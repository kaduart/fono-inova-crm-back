/**
 * services/agent/amanda/index.js
 *
 * Amanda com Claude: recebe o lead + texto, monta contexto (histórico, dados
 * do contato, regras da clínica), deixa o Claude conduzir a conversa com
 * ferramentas e devolve no MESMO contrato do orquestrador antigo:
 *
 *   { command: 'SEND_MESSAGE' | 'NO_REPLY', payload?: { text }, meta }
 *
 * Lock, manualControl, idempotência do envio e retentativas continuam no
 * whatsappAutoReplyWorker — este módulo não envia nada.
 */

import { buildSystem } from './prompt.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
const logger = {
  info: (event, data = {}) => console.log(`[amandaAgent] ${event}`, JSON.stringify(data)),
  error: (event, data = {}) => console.error(`[amandaAgent] ${event}`, JSON.stringify(data)),
};

export const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 6;
const HISTORY_LIMIT = 30;

export const FALLBACK_TEXT = 'Vou pedir para alguém da equipe continuar seu atendimento por aqui, tá bom?';

let _client = null;
async function getClient() {
  if (_client) return _client;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  _client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: Number(process.env.AMANDA_AGENT_TIMEOUT_MS || 45_000),
    maxRetries: 1,
  });
  return _client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Histórico
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converte mensagens do Mongo em turnos user/assistant alternados.
 * Mensagens seguidas do mesmo lado viram um turno só (ex.: "oi" / "quero fono").
 * Garante que começa e termina com a pessoa.
 */
export function toConversation(docs = [], currentText = '') {
  const turns = [];
  for (const m of docs) {
    const text = String(m.content || m.text || m.caption || '').trim();
    if (!text) continue;
    const role = m.direction === 'outbound' ? 'assistant' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else turns.push({ role, content: text });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();

  const cur = String(currentText || '').trim();
  const last = turns[turns.length - 1];
  if (!last || last.role !== 'user') {
    if (cur) turns.push({ role: 'user', content: cur });
  } else if (cur && !last.content.includes(cur)) {
    last.content += `\n${cur}`;
  }
  return turns;
}

async function loadHistory(lead) {
  const { default: Message } = await import('../../../models/Message.js');
  const or = [{ lead: lead._id }];
  if (lead.contact?.phone) or.push({ from: lead.contact.phone }, { to: lead.contact.phone });
  const docs = await Message.find({ $or: or, type: { $in: ['text', 'template'] } })
    .sort({ timestamp: -1 })
    .limit(HISTORY_LIMIT)
    .select('direction content caption timestamp type')
    .lean();
  return docs.reverse();
}

// ─────────────────────────────────────────────────────────────────────────────
// Saída
// ─────────────────────────────────────────────────────────────────────────────

/** Limpa formatação que não combina com WhatsApp e mantém no máximo um 💚. */
export function sanitizeReply(text, { heartAlreadyUsed = false } = {}) {
  let t = String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let seen = heartAlreadyUsed;
  t = t.replace(/💚/g, () => {
    if (seen) return '';
    seen = true;
    return '💚';
  });
  return t.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
}

function textOf(content = []) {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Loop do agente
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} lead     documento do lead (lean)
 * @param {string} userText texto atual (pode ser bloco de mensagens agrupadas)
 * @param {object} context  enrichedContext do worker
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]  modo sombra: ferramentas não escrevem
 * @param {object}  [opts.client]        injeção para testes
 * @param {Array}   [opts.history]       injeção para testes (docs de Message)
 * @param {object}  [opts.toolDeps]      injeção para testes
 */
export async function runAmandaAgent(lead, userText, context = {}, opts = {}) {
  const startedAt = Date.now();
  const dryRun = !!opts.dryRun;
  const correlationId = context.correlationId;
  const model = process.env.AMANDA_AGENT_MODEL || DEFAULT_MODEL;
  const state = {};
  const toolCalls = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const log = (event, data = {}) => logger.info(event, { ...data, dryRun, correlationId });

  try {
    const client = opts.client || (await getClient());
    const historyDocs = opts.history || (await loadHistory(lead));
    const messages = toConversation(historyDocs, userText);
    if (!messages.length) return { command: 'NO_REPLY', meta: { reason: 'EMPTY_INPUT' } };

    const heartAlreadyUsed = historyDocs.some((m) => m.direction === 'outbound' && /💚/.test(m.content || ''));
    const system = buildSystem(lead, context);

    const useFallbacks = String(process.env.AMANDA_AGENT_FALLBACKS || 'on').toLowerCase() !== 'off';

    let finalText = '';
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const params = {
        model,
        max_tokens: 16000,
        system,
        tools: TOOL_DEFINITIONS,
        messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: process.env.AMANDA_AGENT_EFFORT || 'medium' },
      };
      const response = useFallbacks
        ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
        : await client.messages.create(params);

      usage.input += response.usage?.input_tokens || 0;
      usage.output += response.usage?.output_tokens || 0;
      usage.cacheRead += response.usage?.cache_read_input_tokens || 0;
      usage.cacheWrite += response.usage?.cache_creation_input_tokens || 0;

      if (response.stop_reason === 'refusal') {
        log('refusal', { category: response.stop_details?.category });
        break;
      }
      if (response.stop_reason === 'max_tokens') {
        log('max_tokens');
        break;
      }

      // devolve o content inteiro (inclui blocos de thinking) sem alterar
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'pause_turn') continue;

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !toolUses.length) {
        finalText = textOf(response.content);
        break;
      }
      if (round === MAX_TOOL_ROUNDS) {
        log('max_tool_rounds');
        break;
      }

      const results = [];
      for (const tu of toolUses) {
        let result;
        let isError = false;
        try {
          result = await executeTool(tu.name, tu.input, { lead, dryRun, state, log, deps: opts.toolDeps });
        } catch (err) {
          isError = true;
          result = { erro: 'falha_interna', detalhe: err.message };
          logger.error('tool_error', { tool: tu.name, err: err.message, correlationId });
        }
        toolCalls.push({ name: tu.name, input: tu.input, result, isError });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result), ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }

    const text = sanitizeReply(finalText, { heartAlreadyUsed });
    const meta = { model, dryRun, toolCalls, usage, handoff: state.handoff || null, ms: Date.now() - startedAt };

    if (!text) {
      // Sem texto utilizável: não deixa a família sem resposta e chama a equipe.
      if (!state.handoff) {
        await executeTool(
          'transferir_para_equipe',
          { motivo: 'duvida_sem_resposta', resumo: `A assistente não conseguiu responder: "${String(userText).slice(0, 200)}"` },
          { lead, dryRun, state, log, deps: opts.toolDeps },
        ).catch((err) => logger.error('fallback_handoff_error', { err: err.message, correlationId }));
      }
      log('empty_reply_fallback', meta);
      return { command: 'SEND_MESSAGE', payload: { text: FALLBACK_TEXT }, meta: { ...meta, fallback: true } };
    }

    log('reply', { tools: toolCalls.map((t) => t.name), usage, ms: meta.ms });
    return { command: 'SEND_MESSAGE', payload: { text }, meta };
  } catch (err) {
    logger.error('agent_error', { err: err.message, status: err.status, correlationId });
    if (!state.handoff) {
      await executeTool(
        'transferir_para_equipe',
        { motivo: 'outro', resumo: `Falha técnica da assistente ao responder: "${String(userText).slice(0, 200)}"` },
        { lead, dryRun, state, log, deps: opts.toolDeps },
      ).catch(() => {});
    }
    return {
      command: 'SEND_MESSAGE',
      payload: { text: FALLBACK_TEXT },
      meta: { model, dryRun, toolCalls, usage, error: err.message, fallback: true, ms: Date.now() - startedAt },
    };
  }
}

export default runAmandaAgent;
