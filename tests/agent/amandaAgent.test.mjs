// Testes do agente Amanda (Claude). Rodar: npm run test:agent
// Sem rede e sem Mongo: cliente da API e dependências são falsos.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAmandaAgent, toConversation, sanitizeReply, FALLBACK_TEXT } from '../../services/agent/amanda/index.js';
import { executeTool, pickOptions, TOOL_DEFINITIONS, especialidadesComAgenda, _resetAgendaCache } from '../../services/agent/amanda/tools.js';
import { buildPricingText, buildSystem } from '../../services/agent/amanda/prompt.js';
import { decideRoute, phoneAllowed } from '../../services/agent/amanda/router.js';
import { THERAPY_PRICING, formatPrice } from '../../config/pricing.js';

process.env.AMANDA_AGENT_FALLBACKS = 'off';

const LEAD = { _id: 'lead1', name: 'Carla', contact: { phone: '5562999990000' }, stage: 'novo' };

function fakeDeps(over = {}) {
  const calls = { updates: [], emits: [], booked: [] };
  const deps = {
    calls,
    Leads: { updateOne: async (q, u) => calls.updates.push({ q, u }) },
    Doctor: {
      find: (q) => ({
        select: () => ({
          lean: async () => {
            const all = [
              { _id: 'd-fono', specialty: 'fonoaudiologia', specialties: [], fullName: 'Dra. Ana' },
              { _id: 'd-psi', specialty: 'psicologia', specialties: ['psicopedagogia'], fullName: 'Dr. Beto' },
            ];
            return q._id ? all.filter((d) => q._id.$in.includes(d._id)) : all;
          },
        }),
      }),
    },
    findAvailableSlots: async (args) => (calls.slotArgs = [...(calls.slotArgs || []), args], {
      primary: { doctorId: 'd-fono', doctorName: 'Dra. Ana', date: '2026-11-04', time: '14:00' },
      alternativesSamePeriod: [{ doctorId: 'd-psi', doctorName: 'Dr. Beto', date: '2026-11-04', time: '15:00' }],
      alternativesOtherPeriod: [{ doctorId: 'd-fono', doctorName: 'Dra. Ana', date: '2026-11-05', time: '09:00' }],
    }),
    validateSlotStillAvailable: async () => ({ isValid: true }),
    autoBookAppointment: async (a) => {
      calls.booked.push(a);
      return { success: true };
    },
    emitSocketEvent: async (e, p) => calls.emits.push({ e, p }),
    ...over,
  };
  return deps;
}

function fakeClient(responses) {
  const requests = [];
  const create = async (params) => {
    requests.push(structuredClone(params));
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  return { requests, messages: { create }, beta: { messages: { create } } };
}

const ctx = (deps, over = {}) => ({ lead: LEAD, dryRun: false, state: {}, log: () => {}, deps, ...over });

// ── histórico ────────────────────────────────────────────────────────────────

test('toConversation junta mensagens seguidas e começa pela pessoa', () => {
  const conv = toConversation(
    [
      { direction: 'outbound', content: 'mensagem de campanha' },
      { direction: 'inbound', content: 'oi' },
      { direction: 'inbound', content: 'quero fono' },
      { direction: 'outbound', content: 'Claro! Para quem?' },
      { direction: 'inbound', content: 'pra minha filha' },
    ],
    'pra minha filha',
  );
  assert.deepEqual(conv.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.equal(conv[0].content, 'oi\nquero fono');
  assert.equal(conv[2].content, 'pra minha filha');
});

test('toConversation acrescenta o texto atual se ainda não está no histórico', () => {
  const conv = toConversation([{ direction: 'inbound', content: 'oi' }, { direction: 'outbound', content: 'Olá' }], 'quanto custa?');
  assert.equal(conv.at(-1).role, 'user');
  assert.equal(conv.at(-1).content, 'quanto custa?');
});

test('sanitizeReply tira negrito e deixa no máximo um 💚', () => {
  assert.equal(sanitizeReply('**Oi** 💚 tudo bem 💚'), 'Oi 💚 tudo bem');
  assert.equal(sanitizeReply('Até logo 💚', { heartAlreadyUsed: true }), 'Até logo');
});

// ── prompt ───────────────────────────────────────────────────────────────────

test('preços do prompt vêm de config/pricing.js', () => {
  const txt = buildPricingText();
  assert.ok(txt.includes(formatPrice(THERAPY_PRICING.fonoaudiologia.avaliacao)));
  assert.ok(txt.includes(formatPrice(THERAPY_PRICING.psicologia.sessaoPacote)));
});

test('system tem cache no bloco da clínica e contato por último', () => {
  const sys = buildSystem({ ...LEAD, patientInfo: { fullName: 'Lia', age: 3 } }, {});
  assert.equal(sys.length, 3);
  assert.deepEqual(sys[1].cache_control, { type: 'ephemeral' });
  assert.ok(sys[2].text.includes('Lia'));
  assert.ok(!sys[0].text.includes('R$'), 'instruções fixas não têm preço escrito à mão');
});

test('schemas das tools são strict e fechados', () => {
  for (const t of TOOL_DEFINITIONS) {
    assert.equal(t.strict, true);
    assert.equal(t.input_schema.additionalProperties, false);
  }
});

// ── rota ─────────────────────────────────────────────────────────────────────

test('decideRoute respeita modo e lista de telefones', () => {
  assert.equal(decideRoute(LEAD, {}), 'fsm');
  assert.equal(decideRoute(LEAD, { AMANDA_AGENT_MODE: 'on' }), 'agent');
  assert.equal(decideRoute(LEAD, { AMANDA_AGENT_MODE: 'on', AMANDA_AGENT_PHONES: '62 99999-0000' }), 'agent');
  assert.equal(decideRoute(LEAD, { AMANDA_AGENT_MODE: 'on', AMANDA_AGENT_PHONES: '5562888880000' }), 'fsm');
  assert.equal(decideRoute(LEAD, { AMANDA_AGENT_MODE: 'shadow' }), 'shadow');
  assert.equal(phoneAllowed('', '5562'), false);
});

// ── tools ────────────────────────────────────────────────────────────────────

test('buscar_horarios só devolve profissionais da especialidade pedida', async () => {
  const deps = fakeDeps();
  const c = ctx(deps);
  const r = await executeTool('buscar_horarios', { especialidade: 'fonoaudiologia', periodo: 'tarde' }, c);
  assert.equal(r.horarios.length, 2);
  assert.ok(r.horarios.every((h) => h.profissional === 'Dra. Ana'));
  assert.equal(c.state.opcoes[0].codigo, 'A');
  assert.equal(deps.calls.updates.length, 1, 'guarda opções no lead');
});

test('pickOptions vazio quando não há profissional da área', async () => {
  const deps = fakeDeps();
  const r = await pickOptions(
    { primary: { doctorId: 'd-psi', date: '2026-11-04', time: '14:00' } },
    'fonoaudiologia',
    deps,
  );
  assert.equal(r.length, 0);
});

test('reservar_horario faz pré-reserva, avisa a equipe e é idempotente', async () => {
  const deps = fakeDeps();
  const c = ctx(deps);
  await executeTool('buscar_horarios', { especialidade: 'fonoaudiologia', periodo: 'tarde' }, c);
  const r = await executeTool('reservar_horario', { codigo: 'A' }, c);
  assert.equal(r.sucesso, true);
  assert.equal(r.status, 'pre_reserva');
  assert.equal(deps.calls.booked.length, 0, 'sem AUTOBOOK não cria agendamento');
  assert.ok(deps.calls.emits.some((e) => e.e === 'system:alert'));

  const lead2 = { ...LEAD, pendingChosenSlot: c.state.opcoes[0] };
  const r2 = await executeTool('reservar_horario', { codigo: 'A' }, { ...c, lead: lead2 });
  assert.equal(r2.status, 'pre_reserva');
  assert.equal(deps.calls.emits.filter((e) => e.e === 'system:alert').length, 1, 'não avisa duas vezes');
});

test('reservar_horario com horário ocupado não confirma', async () => {
  const deps = fakeDeps({ validateSlotStillAvailable: async () => ({ isValid: false }) });
  const c = ctx(deps);
  await executeTool('buscar_horarios', { especialidade: 'fonoaudiologia', periodo: 'tarde' }, c);
  const r = await executeTool('reservar_horario', { codigo: 'A' }, c);
  assert.equal(r.sucesso, false);
  assert.equal(r.erro, 'horario_indisponivel');
});

test('reservar_horario com AUTOBOOK aguarda o agendamento real', async () => {
  process.env.AMANDA_AGENT_AUTOBOOK = 'true';
  try {
    const deps = fakeDeps();
    const c = ctx(deps);
    await executeTool('buscar_horarios', { especialidade: 'fonoaudiologia', periodo: 'tarde' }, c);
    const r = await executeTool('reservar_horario', { codigo: 'B', nome_paciente: 'Lia Souza' }, c);
    assert.equal(r.status, 'agendado');
    assert.equal(deps.calls.booked.length, 1);
  } finally {
    delete process.env.AMANDA_AGENT_AUTOBOOK;
  }
});

test('transferir_para_equipe pausa a IA e avisa com resumo', async () => {
  const deps = fakeDeps();
  await executeTool('transferir_para_equipe', { motivo: 'pedido_da_pessoa', resumo: 'Quer falar com a recepção' }, ctx(deps));
  const set = deps.calls.updates[0].u.$set;
  assert.equal(set['manualControl.active'], true);
  assert.equal(set.currentState, 'HANDOFF');
  assert.ok(deps.calls.emits.some((e) => e.e === 'lead:manualControl' && e.p.resumo === 'Quer falar com a recepção'));
});

test('dryRun não escreve nada', async () => {
  const deps = fakeDeps();
  const c = ctx(deps, { dryRun: true });
  await executeTool('buscar_horarios', { especialidade: 'fonoaudiologia', periodo: 'tarde' }, c);
  await executeTool('atualizar_contato', { nome_paciente: 'Lia', idade: 3 }, c);
  await executeTool('reservar_horario', { codigo: 'A' }, c);
  await executeTool('transferir_para_equipe', { motivo: 'outro', resumo: 'x' }, c);
  assert.equal(deps.calls.updates.length, 0);
  assert.equal(deps.calls.emits.length, 0);
});

// ── loop do agente ───────────────────────────────────────────────────────────

test('runAmandaAgent executa tool e devolve a resposta final', async () => {
  const deps = fakeDeps();
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: 'tu1', name: 'buscar_horarios', input: { especialidade: 'fonoaudiologia', periodo: 'tarde' } },
      ],
    },
    {
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 15 },
      content: [{ type: 'text', text: 'Tenho quarta às 14h ou quinta às 9h com a Dra. Ana. Qual fica melhor?' }],
    },
  ]);
  const r = await runAmandaAgent(LEAD, 'quero marcar fono à tarde', {}, {
    client,
    history: [{ direction: 'inbound', content: 'quero marcar fono à tarde' }],
    toolDeps: deps,
  });
  assert.equal(r.command, 'SEND_MESSAGE');
  assert.match(r.payload.text, /Dra\. Ana/);
  assert.equal(r.meta.toolCalls[0].name, 'buscar_horarios');

  const [first, second] = client.requests;
  assert.equal(first.model, 'claude-opus-5-5');
  assert.deepEqual(first.thinking, { type: 'adaptive' });
  assert.equal(first.tools.length, 4);
  // segunda chamada carrega o content do assistente intacto (com thinking) + tool_result
  assert.equal(second.messages.at(-2).content[0].type, 'thinking');
  assert.equal(second.messages.at(-1).content[0].type, 'tool_result');
  assert.equal(second.messages.at(-1).content[0].tool_use_id, 'tu1');
});

test('runAmandaAgent: falha da API → resposta segura e equipe acionada', async () => {
  const deps = fakeDeps();
  const client = fakeClient([new Error('overloaded')]);
  const r = await runAmandaAgent(LEAD, 'oi', {}, { client, history: [], toolDeps: deps });
  assert.equal(r.payload.text, FALLBACK_TEXT);
  assert.equal(r.meta.fallback, true);
  assert.ok(deps.calls.updates.some((u) => u.u.$set['manualControl.active'] === true));
});

test('runAmandaAgent: recusa sem texto também cai no fallback', async () => {
  const deps = fakeDeps();
  const client = fakeClient([{ stop_reason: 'refusal', content: [], stop_details: { category: 'x' } }]);
  const r = await runAmandaAgent(LEAD, 'oi', {}, { client, history: [], toolDeps: deps });
  assert.equal(r.payload.text, FALLBACK_TEXT);
});

test('buscar_horarios manda o dia da semana no formato que a agenda entende', async () => {
  const deps = fakeDeps();
  await executeTool('buscar_horarios', { especialidade: 'fonoaudiologia', periodo: 'manha', dia_preferido: 'quinta' }, ctx(deps));
  assert.equal(deps.calls.slotArgs[0].preferredDay, 'thursday');
  assert.equal(deps.calls.slotArgs[0].preferredPeriod, 'manha');
});

test('psicopedagogia procura psicóloga com essa subespecialidade', async () => {
  const deps = fakeDeps({
    findAvailableSlots: async (args) => {
      deps.calls.slotArgs = [...(deps.calls.slotArgs || []), args];
      return args.therapyArea === 'psicologia'
        ? { primary: { doctorId: 'd-psi', doctorName: 'Dr. Beto', date: '2026-11-06', time: '10:00' } }
        : { primary: { doctorId: 'd-fono', doctorName: 'Dra. Ana', date: '2026-11-04', time: '14:00' } };
    },
  });
  const r = await executeTool('buscar_horarios', { especialidade: 'psicopedagogia', periodo: 'qualquer' }, ctx(deps));
  assert.equal(r.horarios.length, 1);
  assert.equal(r.horarios[0].profissional, 'Dr. Beto');
  assert.deepEqual(deps.calls.slotArgs[1].specialties, ['psicopedagogia']);
});

test('especialidade sem agenda online orienta a chamar a equipe', async () => {
  _resetAgendaCache();
  const deps = fakeDeps({ findAvailableSlots: async () => null });
  const r = await executeTool('buscar_horarios', { especialidade: 'musicoterapia', periodo: 'tarde' }, ctx(deps));
  assert.equal(r.horarios.length, 0);
  assert.match(r.observacao, /transferir_para_equipe/);
  assert.deepEqual(await especialidadesComAgenda(deps), ['fonoaudiologia', 'psicologia', 'psicopedagogia']);
});

test('prompt informa quais especialidades têm agenda online', () => {
  const sys = buildSystem(LEAD, { especialidadesComAgenda: ['fonoaudiologia', 'psicologia'] });
  assert.match(sys[2].text, /agenda online agora: fonoaudiologia, psicologia/);
});
