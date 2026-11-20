// services/whatsappWebChatMirror.js
//
// Ponte WhatsApp Web → tela Conversas (20/11/2026).
//
// A tela Conversas lê ChatProjection (lista) e Message (balões). Até aqui só o pipeline da API
// (Cloud API, workers do grupo "whatsapp") gravava nessas coleções; o WhatsApp Web, que virou o
// canal oficial, só gravava origem, confirmação e convênio. Este módulo grava as mensagens do Web
// direto nas duas coleções, sem filas e sem disparar a Amanda.
//
// Chave: WA_WEB_CHAT_MIRROR=on liga. Qualquer outro valor (ou ausente) = desligado, nada é gravado.
//
// Idempotência: Message é gravada por upsert em waMessageId (índice único já existente). Reprocessar
// o mesmo evento (catch-up depois do worker suspenso, reenvio do conector) não duplica nada, e a
// projeção só muda quando a mensagem nova é a mais recente da conversa.
//
// Envio pelo ERP: o CRM já grava a Message com o mesmo waMessageId logo após o envio. A cópia de
// saída espera alguns segundos (WA_WEB_CHAT_MIRROR_OUTBOUND_DELAY_MS) para o ERP gravar primeiro,
// e o upsert nunca sobrescreve o que já existe.

import Message from '../models/Message.js';
import ChatProjection from '../models/ChatProjection.js';
import Lead from '../models/Leads.js';
import { normalizeE164BR } from '../utils/phone.js';

export function isChatMirrorOn(env = process.env) {
  return String(env.WA_WEB_CHAT_MIRROR || '').trim().toLowerCase() === 'on';
}

export function outboundDelayMs(env = process.env) {
  const n = Number(env.WA_WEB_CHAT_MIRROR_OUTBOUND_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 15000;
}

// Tipo do whatsapp-web.js → tipo aceito pelo model Message.
const TYPE_MAP = {
  chat: 'text', text: 'text', buttons_response: 'text', list_response: 'text', template_button_reply: 'text',
  image: 'image', ptt: 'audio', audio: 'audio', video: 'video', document: 'document',
  sticker: 'sticker', location: 'location',
};
const PLACEHOLDER = {
  image: '[imagem]', audio: '[áudio]', video: '[vídeo]', document: '[documento]',
  sticker: '[figurinha]', location: '[localização]', text: '[mensagem]',
};

export function messageTypeOf(waType) {
  return TYPE_MAP[String(waType || 'chat')] || 'text';
}

export function contentOf(body, waType) {
  const text = String(body || '').trim();
  const type = messageTypeOf(waType);
  if (type === 'text') return text || PLACEHOLDER.text;
  return text ? `${PLACEHOLDER[type]} ${text}` : PLACEHOLDER[type];
}

function atDate(timestampSec) {
  const n = Number(timestampSec);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

// Mesmas variações de telefone que resolveLeadByPhone usa (com/sem 55, com/sem o 9, com/sem +).
export function phoneVariants(phoneE164) {
  const p = String(phoneE164 || '');
  if (!p) return [];
  const out = new Set([p, `+${p}`]);
  if (p.length === 13) { const sem9 = p.slice(0, 4) + p.slice(5); out.add(sem9); out.add(`+${sem9}`); }
  if (p.length === 12) { const com9 = `${p.slice(0, 4)}9${p.slice(4)}`; out.add(com9); out.add(`+${com9}`); }
  const sem55 = p.replace(/^55/, '');
  if (sem55 !== p) { out.add(sem55); out.add(`+${sem55}`); }
  return [...out];
}

/**
 * Acha o lead do telefone; sem lead, cria um mínimo para a conversa aparecer.
 * Diferente de resolveLeadByPhone: NÃO liga a Amanda (autoReplyEnabled=false), NÃO inicia recuperação
 * de lead e NÃO mexe em lastInteractionAt de lead existente.
 */
export async function findOrCreateChatLead({ phone, name = null }) {
  const variants = phoneVariants(phone);
  const existing = await Lead.findOne({ 'contact.phone': { $in: variants } }).select('_id name').lean();
  if (existing) return { lead: existing, created: false };
  const lead = await Lead.create({
    name: name || null,
    contact: { phone },
    origin: 'WhatsApp',
    status: 'novo',
    autoReplyEnabled: false,
    manualControl: { active: false, autoResumeAfter: null },
  });
  return { lead: { _id: lead._id, name: lead.name }, created: true };
}

async function emitNew(payload, log) {
  try {
    const { emitSocketEvent } = await import('../config/socket.js');
    await emitSocketEvent('message:new', payload);
  } catch (err) {
    log.warn?.('[WaWebChatMirror] aviso em tempo real falhou (a tela atualiza no botão):', err?.message);
  }
}

/**
 * Grava uma mensagem do WhatsApp Web na conversa.
 * @param {{ direction: 'inbound'|'outbound', waMessageId: string, phone: string, body?: string,
 *           type?: string, timestamp?: number, notifyName?: string|null }} ev
 * @returns {Promise<{ status: 'off'|'skipped'|'exists'|'saved', reason?: string, leadId?: string }>}
 */
export async function mirrorWebMessage(ev, { env = process.env, log = console, clinicPhone = null } = {}) {
  if (!isChatMirrorOn(env)) return { status: 'off' };
  if (!ev?.waMessageId) return { status: 'skipped', reason: 'sem_id' };
  const phone = normalizeE164BR(ev.phone || '');
  if (!phone) return { status: 'skipped', reason: 'sem_telefone' };

  const inbound = ev.direction === 'inbound';
  // Número da clínica: do próprio evento (id do chat do WhatsApp), senão da env, senão zeros (campo obrigatório).
  const clinic = normalizeE164BR(ev.clinicPhone || clinicPhone || env.CLINIC_PHONE_E164 || '') || '0000000000000';
  const at = atDate(ev.timestamp);
  const type = messageTypeOf(ev.type);
  const content = contentOf(ev.body, ev.type);

  // Mensagem já gravada (pelo ERP ou por um evento anterior): não toca na conversa de novo.
  const already = await Message.findOne({ waMessageId: ev.waMessageId }).select('_id').lean();
  if (already) return { status: 'exists' };

  const { lead } = await findOrCreateChatLead({ phone, name: inbound ? ev.notifyName : null });

  let saved;
  try {
    saved = await Message.findOneAndUpdate(
      { waMessageId: ev.waMessageId },
      {
        $setOnInsert: {
          waMessageId: ev.waMessageId,
          from: inbound ? phone : clinic,
          to: inbound ? clinic : phone,
          direction: inbound ? 'inbound' : 'outbound',
          type,
          content,
          status: inbound ? 'received' : 'sent',
          timestamp: at,
          lead: lead._id,
          // Saída que não veio do ERP = alguém respondeu pelo celular/WhatsApp Web: é resposta humana.
          metadata: { sentBy: 'manual' },
          raw: { source: 'whatsapp_web', origin: ev.source || 'live' },
        },
      },
      { upsert: true, new: true, includeResultMetadata: true }
    );
  } catch (err) {
    if (err?.code === 11000) return { status: 'exists' }; // corrida com o ERP ou outro evento: já existe
    throw err;
  }
  if (saved?.lastErrorObject && saved.lastErrorObject.updatedExisting) return { status: 'exists' };

  // Projeção da lista: garante a linha e só avança "última mensagem" se esta for a mais recente.
  await ChatProjection.updateOne(
    { leadId: lead._id },
    { $setOnInsert: { leadId: lead._id, phone, contactName: lead.name || ev.notifyName || null, unreadCount: 0 } },
    { upsert: true }
  );
  const newest = {
    $set: {
      lastMessage: content.slice(0, 200),
      lastMessageAt: at,
      lastDirection: inbound ? 'inbound' : 'outbound',
      lastMessageType: type,
      phone,
    },
  };
  // Recebida soma não lida; resposta da clínica (pelo celular) zera, igual a quem responde pelo ERP.
  if (inbound) newest.$inc = { unreadCount: 1 };
  else newest.$set.unreadCount = 0;
  await ChatProjection.updateOne(
    { leadId: lead._id, $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: at } }] },
    newest
  );

  const messageId = String(saved?.value?._id || '');
  await emitNew({
    id: messageId, leadId: String(lead._id), from: inbound ? phone : clinic, to: inbound ? clinic : phone,
    type, content, text: content, timestamp: at, direction: inbound ? 'inbound' : 'outbound',
  }, log);

  log.info?.(`[WaWebChatMirror] ✅ ${inbound ? 'recebida' : 'enviada'} gravada na conversa (lead ${lead._id})`);
  return { status: 'saved', leadId: String(lead._id) };
}

/** Saída: agenda a cópia para depois do ERP gravar; nunca segura quem chamou. */
export function scheduleOutboundMirror(ev, { env = process.env, log = console, setTimer = setTimeout } = {}) {
  if (!isChatMirrorOn(env)) return false;
  setTimer(() => {
    mirrorWebMessage({ ...ev, direction: 'outbound' }, { env, log }).catch((err) =>
      log.warn?.('[WaWebChatMirror] ⚠️ cópia da mensagem enviada falhou (ignorado):', err?.message)
    );
  }, outboundDelayMs(env));
  return true;
}

export default { isChatMirrorOn, mirrorWebMessage, scheduleOutboundMirror, findOrCreateChatLead, contentOf, messageTypeOf, phoneVariants };
