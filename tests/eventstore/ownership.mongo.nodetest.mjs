// Testes locais da posse de execução do Event Store.
// Rodam só com MONGO_TEST_URI apontando para um MongoDB DESCARTÁVEL em
// loopback (os testes criam e apagam bancos). Dados fictícios.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
//     node --test tests/eventstore/ownership.mongo.nodetest.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import EventStore from '../../models/EventStore.js';
import {
  claimEvent, completeOwned, failOwned, renewLease, leaseMsFromEnv, DEFAULT_LEASE_MS
} from '../../infrastructure/events/eventOwnership.js';
import {
  processWithGuarantees, markEventProcessed, MAX_FAILED_ATTEMPTS
} from '../../infrastructure/events/eventStoreService.js';
import { reapStuckEvents, MAX_RECOVERIES, observed } from '../../crons/eventReaper.cron.js';
import { resolveEventReaperOwner } from '../../config/cronManager.js';

const URI = process.env.MONGO_TEST_URI;
const skip = !URI ? 'MONGO_TEST_URI não definido' : false;
if (URI) {
  const host = new URL(URI).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error('MONGO_TEST_URI precisa ser loopback');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let seq = 0;
const newId = (p = 'evt') => `${p}-${process.pid}-${Date.now()}-${seq++}`;

async function seed(overrides = {}) {
  const eventId = overrides.eventId || newId();
  await EventStore.collection.insertOne({
    eventId,
    eventType: 'APPOINTMENT_CREATED',
    aggregateType: 'appointment',
    aggregateId: 'agg-ficticio',
    payload: { nome: 'PACIENTE FICTICIO' },
    status: 'pending',
    attempts: 0,
    createdAt: new Date(),
    ...overrides
  });
  return eventId;
}
const get = (eventId) => EventStore.findOne({ eventId }).lean();

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_posse_teste_${Date.now()}` });
});
after(async () => {
  if (skip) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
beforeEach(async () => { if (!skip) await EventStore.deleteMany({}); });

test('EVENT_REAPER_OWNER: padrão node, kas aceito, inválido falha claramente', () => {
  assert.equal(resolveEventReaperOwner({}), 'node');
  assert.equal(resolveEventReaperOwner({ EVENT_REAPER_OWNER: '' }), 'node');
  assert.equal(resolveEventReaperOwner({ EVENT_REAPER_OWNER: 'node' }), 'node');
  assert.equal(resolveEventReaperOwner({ EVENT_REAPER_OWNER: ' KAS ' }), 'kas');
  assert.throws(() => resolveEventReaperOwner({ EVENT_REAPER_OWNER: 'false' }), /EVENT_REAPER_OWNER inválido: "false"/);
  assert.throws(() => resolveEventReaperOwner({ EVENT_REAPER_OWNER: 'both' }), /Use "node" \(padrão\) ou "kas"/);
});

test('EVENT_LEASE_MS: padrão 60 s, inválido falha', () => {
  assert.equal(leaseMsFromEnv({}), DEFAULT_LEASE_MS);
  assert.equal(leaseMsFromEnv({ EVENT_LEASE_MS: '90000' }), 90000);
  assert.throws(() => leaseMsFromEnv({ EVENT_LEASE_MS: '10' }), /EVENT_LEASE_MS inválido/);
  assert.throws(() => leaseMsFromEnv({ EVENT_LEASE_MS: 'abc' }), /EVENT_LEASE_MS inválido/);
});

test('caminho feliz: token único por execução, posse limpa ao concluir', { skip }, async () => {
  const id = await seed();
  let seen;
  const r = await processWithGuarantees({ eventId: id }, async (_e, ctx) => {
    seen = ctx.token;
    const doc = await get(id);
    assert.equal(doc.status, 'processing');
    assert.equal(doc.processingToken, ctx.token);
    assert.ok(doc.leaseExpiresAt > new Date());
    return 'ok';
  }, 'workerFicticio', { leaseMs: 5000 });
  assert.deepEqual(r, { success: true, result: 'ok' });
  const doc = await get(id);
  assert.equal(doc.status, 'processed');
  assert.equal(doc.processedBy, 'workerFicticio');
  assert.equal(doc.processingToken, undefined);
  assert.equal(doc.leaseExpiresAt, undefined);
  assert.ok(seen);
  // Segunda execução do mesmo evento: não roda o processador.
  let ran = false;
  const again = await processWithGuarantees({ eventId: id }, async () => { ran = true; }, 'workerFicticio');
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'already_processed');
  assert.equal(ran, false);
});

test('worker lento: a posse é renovada e o reaper não retoma', { skip }, async () => {
  const id = await seed();
  let reaps = 0;
  const reaper = (async () => {
    for (let i = 0; i < 12; i++) { const r = await reapStuckEvents(); reaps += r.total; await sleep(100); }
  })();
  const r = await processWithGuarantees({ eventId: id }, async () => { await sleep(1300); return 'lento'; }, 'workerLento', { leaseMs: 300 });
  await reaper;
  assert.equal(r.success, true);
  assert.equal(reaps, 0, 'o reaper não pode achar um evento com posse renovada');
  assert.equal((await get(id)).status, 'processed');
});

test('segunda entrega concorrente encontra posse viva e recebe erro retentável', { skip }, async () => {
  const id = await seed();
  let release;
  const first = processWithGuarantees({ eventId: id }, () => new Promise(r => { release = r; }), 'w1', { leaseMs: 5000 });
  await sleep(50);
  await assert.rejects(processWithGuarantees({ eventId: id }, async () => 'dup', 'w2', { leaseMs: 5000 }), { code: 'EVENT_BUSY' });
  release('ok');
  assert.equal((await first).success, true);
});

test('perda de posse: worker travado não conclui depois que outro retomou', { skip }, async () => {
  const id = await seed();
  let otherToken;
  let signalAborted;
  const r = await processWithGuarantees({ eventId: id }, async (_e, ctx) => {
    const end = Date.now() + 700;
    while (Date.now() < end) { /* event loop travado: nenhuma renovação roda */ }
    // O relógio do novo worker está adiante: mesmo que a renovação atrasada
    // do dono antigo rode durante esta chamada, o prazo dele já venceu.
    const other = await claimEvent(id, 'workerNovo', { leaseMs: 5000, now: new Date(Date.now() + 10_000) });
    assert.equal(other.status, 'claimed', 'posse vencida deve ser retomável');
    otherToken = other.token;
    await sleep(250); // dá tempo de a renovação perceber a perda
    signalAborted = ctx.signal.aborted;
    return 'efeito-ja-executado';
  }, 'workerVelho', { leaseMs: 300 });
  assert.equal(r.success, false);
  assert.equal(r.ownershipLost, true);
  assert.equal(signalAborted, true, 'o processador é avisado pelo AbortSignal');
  const doc = await get(id);
  assert.equal(doc.status, 'processing');
  assert.equal(doc.processingToken, otherToken, 'o registro continua do novo dono');
  // O dono antigo também não consegue registrar falha nem renovar.
  assert.equal(await failOwned(id, 'token-antigo', new Error('x')), null);
  assert.equal(await renewLease(id, 'token-antigo'), false);
  assert.equal((await get(id)).attempts, 0);
});

test('conclusão simultânea ao reaper: nunca as duas coisas', { skip }, async () => {
  const n = 200;
  const tokens = [];
  for (let i = 0; i < n; i++) {
    const id = await seed({ eventId: `sim-${i}` });
    const c = await claimEvent(id, 'w', { leaseMs: 1 });
    tokens.push([id, c.token]);
  }
  await sleep(20); // todas as posses vencem
  const [reap, completions] = await Promise.all([
    reapStuckEvents({ batchSize: 1000 }),
    Promise.all(tokens.map(([id, t]) => completeOwned(id, t, 'w')))
  ]);
  const docs = await EventStore.find({}).lean();
  const byId = new Map(docs.map(d => [d.eventId, d]));
  let completed = 0;
  tokens.forEach(([id], i) => {
    const d = byId.get(id);
    if (completions[i]) {
      completed++;
      assert.equal(d.status, 'processed', `${id}: conclusão aceita mas status ${d.status}`);
      assert.equal(d.recoveryCount, undefined);
    } else {
      assert.equal(d.status, 'pending', `${id}: sem conclusão deveria estar recuperado`);
      assert.equal(d.recoveryCount, 1);
    }
  });
  const recovered = reap.reset + reap.failed + reap.deadLetter;
  assert.equal(recovered + completed, n);
  assert.equal(reap.total, recovered + reap.lostRace);
});

test('renovação entre a leitura e a escrita do reaper: nada é gravado', { skip }, async () => {
  // Injeção determinística: a renovação acontece exatamente depois da leitura
  // do reaper e antes da sua escrita condicional.
  const id = await seed();
  const c = await claimEvent(id, 'workerLento', { leaseMs: 1 });
  await sleep(20); // posse vencida: o reaper vai selecionar o evento
  const coll = EventStore.collection;
  const original = coll.updateOne;
  coll.updateOne = async function (...args) {
    coll.updateOne = original;
    assert.equal(await renewLease(id, c.token, { leaseMs: 5000 }), true, 'o dono ainda renova uma posse vencida não retomada');
    return original.apply(this, args);
  };
  try {
    const r = await reapStuckEvents();
    assert.equal(r.total, 1);
    assert.equal(r.lostRace, 1);
    assert.equal(r.reset + r.failed + r.deadLetter, 0);
  } finally {
    coll.updateOne = original;
  }
  const doc = await get(id);
  assert.equal(doc.status, 'processing');
  assert.equal(doc.processingToken, c.token);
  assert.equal(doc.recoveryCount, undefined);
  assert.equal(await completeOwned(id, c.token, 'workerLento'), true, 'o dono segue dono e conclui');
});

test('filtro condicional usa o valor bruto observado (ausente, null, tipo inesperado)', { skip }, async () => {
  assert.deepEqual(observed({}, 'x'), { $exists: false });
  assert.deepEqual(observed({ x: null }, 'x'), { $type: 'null' });
  assert.deepEqual(observed({ x: '2' }, 'x'), { $eq: '2' });
  // recoveryCount gravado como texto por código antigo: o cast do Mongoose
  // faria o filtro nunca casar e o evento ficaria em processing para sempre.
  const id = await seed({ status: 'processing', recoveryCount: '1', processingToken: null, createdAt: new Date(Date.now() - 20 * 60 * 1000) });
  const r = await reapStuckEvents({ alert: async () => {} });
  assert.equal(r.lostRace, 0);
  assert.equal(r.reset, 1);
  const doc = await get(id);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.recoveryCount, 2);
});

test('reinício: execução abandonada é retomada pelo reaper e reprocessada', { skip }, async () => {
  const id = await seed();
  const c = await claimEvent(id, 'workerQueMorreu', { leaseMs: 200 });
  assert.equal(c.status, 'claimed');
  // o processo morre aqui: sem conclusão, sem renovação
  assert.equal((await reapStuckEvents()).total, 0, 'posse ainda viva');
  await sleep(250);
  const r = await reapStuckEvents();
  assert.equal(r.reset, 1);
  let doc = await get(id);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.recoveryCount, 1);
  assert.equal(doc.error.code, 'RECOVERED_STUCK_PROCESSING');
  assert.equal(doc.processingToken, undefined);
  const again = await processWithGuarantees({ eventId: id }, async () => 'ok', 'workerNovo', { leaseMs: 5000 });
  assert.equal(again.success, true);
  doc = await get(id);
  assert.equal(doc.status, 'processed');
  assert.equal(doc.recoveryCount, 1, 'o histórico de recuperações fica');
});

test('dois reapers ao mesmo tempo: cada evento recuperado uma vez', { skip }, async () => {
  const n = 300;
  for (let i = 0; i < n; i++) {
    const id = await seed({ eventId: `dois-${i}`, attempts: i % 4 });
    await claimEvent(id, 'w', { leaseMs: 1 });
  }
  await sleep(20);
  const [a, b] = await Promise.all([reapStuckEvents({ batchSize: 1000 }), reapStuckEvents({ batchSize: 1000 })]);
  const applied = a.reset + a.failed + b.reset + b.failed;
  assert.equal(applied, n);
  assert.equal(a.lostRace + b.lostRace, a.total + b.total - n);
  const wrong = await EventStore.countDocuments({ recoveryCount: { $ne: 1 } });
  assert.equal(wrong, 0);
  assert.equal(await EventStore.countDocuments({ status: 'failed' }), n / 4); // attempts 3
});

test(`esgotamento: ${MAX_RECOVERIES}º abandono vai para dead_letter com alerta`, { skip }, async () => {
  const id = await seed();
  const alerts = [];
  const alert = async (a) => { alerts.push(a); };
  for (let round = 1; round <= MAX_RECOVERIES; round++) {
    const c = await claimEvent(id, 'workerQueCai', { leaseMs: 1 });
    assert.equal(c.status, 'claimed', `rodada ${round}`);
    await sleep(10);
    await reapStuckEvents({ alert });
  }
  const doc = await get(id);
  assert.equal(doc.status, 'dead_letter');
  assert.equal(doc.recoveryCount, MAX_RECOVERIES);
  assert.equal(doc.error.code, 'RECOVERY_LIMIT_EXCEEDED');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'event_recovery_limit');
  assert.equal(alerts[0].level, 'critical');
  assert.doesNotMatch(JSON.stringify(alerts[0]), /PACIENTE/);
  // dead_letter não é mais reivindicado nem reprocessado
  assert.equal((await claimEvent(id, 'w')).status, 'dead_letter');
  const r = await processWithGuarantees({ eventId: id }, async () => { throw new Error('não deveria rodar'); }, 'w');
  assert.equal(r.reason, 'dead_letter');
});

test(`falhas retentáveis: dead_letter na ${MAX_FAILED_ATTEMPTS}ª, como antes`, { skip }, async () => {
  const id = await seed();
  for (let i = 1; i <= MAX_FAILED_ATTEMPTS; i++) {
    await assert.rejects(processWithGuarantees({ eventId: id }, async () => { throw new Error('ECONNRESET ficticio'); }, 'w', { leaseMs: 5000 }));
    const doc = await get(id);
    assert.equal(doc.attempts, i);
    assert.equal(doc.status, i < MAX_FAILED_ATTEMPTS ? 'failed' : 'dead_letter');
    assert.equal(doc.processingToken, undefined);
  }
});

test('escrita legada sem token não passa por cima de posse viva', { skip }, async () => {
  const id = await seed();
  const c = await claimEvent(id, 'dono', { leaseMs: 5000 });
  assert.equal(await markEventProcessed(id, 'legado'), null);
  assert.equal((await get(id)).status, 'processing');
  assert.equal(await completeOwned(id, c.token, 'dono'), true);
  // sem posse viva, a escrita legada continua funcionando
  const id2 = await seed();
  assert.equal((await markEventProcessed(id2, 'legado')).status, 'processed');
});

test('evento processing antigo sem posse (código anterior): critério legado de 15 min', { skip }, async () => {
  const old = await seed({ status: 'processing', attempts: 1, createdAt: new Date(Date.now() - 20 * 60_000) });
  const young = await seed({ status: 'processing', attempts: 1, createdAt: new Date(Date.now() - 60_000) });
  const r = await reapStuckEvents();
  assert.equal(r.reset, 1);
  const d = await get(old);
  assert.equal(d.status, 'pending');
  assert.equal(d.error.message, 'Auto-recovered from stuck processing after 15min');
  assert.equal((await get(young)).status, 'processing');
  // e um worker novo também pode retomar o antigo sem posse
  const o2 = await seed({ status: 'processing', createdAt: new Date(Date.now() - 20 * 60_000) });
  assert.equal((await claimEvent(o2, 'w')).status, 'claimed');
});

test('evento fora do Event Store: caminho legado sem posse, sem quebrar', { skip }, async () => {
  const r = await processWithGuarantees({ eventId: 'idem-key-que-nao-e-evento' }, async () => 'ok', 'w');
  assert.deepEqual(r, { success: true, result: 'ok' });
});

// ---------- D-1: worker de convênio no protocolo de posse ----------
const { processInsuranceJob } = await import('../../domains/billing/workers/insuranceOrchestratorWorker.js');
const insuranceJob = (data) => ({ data: { eventType: 'TIPO_FICTICIO_SEM_HANDLER', correlationId: 'corr-ficticio', payload: { batchId: 'lote-ficticio' }, ...data }, attemptsMade: 0 });

test('D-1: job de convênio reivindica, conclui e libera a posse do evento gravado', { skip }, async () => {
  const key = newId('conv');
  const r = await processInsuranceJob(insuranceJob({ eventId: newId('job'), idempotencyKey: key }));
  assert.equal(r.success, true);
  assert.equal(r.ownership, undefined, 'passou pelo caminho com posse');
  const doc = await EventStore.findOne({ idempotencyKey: key }).lean();
  assert.equal(doc.status, 'processed', 'antes do D-1 o evento ficava pending para sempre');
  assert.equal(doc.processedBy, 'insuranceOrchestratorWorker');
  assert.equal(doc.processingToken, undefined);
  assert.equal(doc.leaseExpiresAt, undefined);
});

test('D-1: reentrega do mesmo job (mesma idempotencyKey) não reprocessa', { skip }, async () => {
  const key = newId('conv');
  await processInsuranceJob(insuranceJob({ eventId: newId('job'), idempotencyKey: key }));
  const again = await processInsuranceJob(insuranceJob({ eventId: newId('job'), idempotencyKey: key }));
  assert.equal(again.status, 'already_processed');
  assert.equal(await EventStore.countDocuments({ idempotencyKey: key }), 1);
});

test('D-1: reentrega com posse viva de outra execução recebe erro retentável', { skip }, async () => {
  const key = newId('conv');
  const id = await seed({ idempotencyKey: key, aggregateType: 'insurance_batch' });
  const other = await claimEvent(id, 'outraExecucao', { leaseMs: 5000 });
  assert.equal(other.status, 'claimed');
  await assert.rejects(processInsuranceJob(insuranceJob({ eventId: newId('job'), idempotencyKey: key })), { code: 'EVENT_BUSY' });
  const doc = await get(id);
  assert.equal(doc.processingToken, other.token, 'a posse da outra execução continua intacta');
});

test('D-1: reentrega depois de execução abandonada retoma o mesmo evento', { skip }, async () => {
  const key = newId('conv');
  const id = await seed({ idempotencyKey: key, aggregateType: 'insurance_batch' });
  await claimEvent(id, 'execucaoQueMorreu', { leaseMs: 1 });
  await sleep(20);
  const r = await processInsuranceJob(insuranceJob({ eventId: newId('job'), idempotencyKey: key }));
  assert.equal(r.success, true);
  assert.equal(await EventStore.countDocuments({ idempotencyKey: key }), 1, 'não cria um segundo evento');
  assert.equal((await get(id)).status, 'processed');
});

test('processWithGuarantees aceita a string do eventId (contrato antigo)', { skip }, async () => {
  const id = await seed();
  const r = await processWithGuarantees(id, async () => 'ok', 'w-string', { leaseMs: 5000 });
  assert.equal(r.success, true);
  assert.equal((await get(id)).status, 'processed');
});

test('sem eventId: processa sem posse e não escreve em nenhum documento', { skip }, async () => {
  await EventStore.collection.insertOne({ eventType: 'SEM_ID', aggregateType: 'x', aggregateId: 'x', payload: {}, status: 'pending', attempts: 0, createdAt: new Date() });
  const id = await seed();
  let ran = false;
  const r = await processWithGuarantees(undefined, async () => { ran = true; return 'ok'; }, 'w-sem-id');
  assert.equal(ran, true);
  assert.equal(r.ownership, 'none');
  assert.equal(await EventStore.countDocuments({ status: { $ne: 'pending' } }), 0, 'nenhum documento mudou');
  await assert.rejects(processWithGuarantees({ eventId: '' }, async () => { throw new Error('falha-ficticia'); }, 'w'), /falha-ficticia/);
  assert.equal((await get(id)).status, 'pending');
});

// ---------- dead_letter visível e recuperável ----------
const { listDeadLetters, retryDeadLetter } = await import('../../infrastructure/observability/deadLetterService.js');
const { getQueue } = await import('../../infrastructure/queue/queueConfig.js');

test('dead_letter do limite aparece na listagem e volta por retry com orçamento zerado', { skip }, async () => {
  const added = [];
  for (const q of ['notification', 'patient-projection', 'clinical-orchestrator']) {
    getQueue(q).add = async (name, data) => { added.push([q, data.eventId]); return { id: `fake-${q}` }; };
  }
  const id = await seed({ status: 'processing', processingToken: 'tok-velho', leaseExpiresAt: new Date(Date.now() - 1000), recoveryCount: MAX_RECOVERIES - 1 });
  const alerts = [];
  const r = await reapStuckEvents({ alert: async (a) => alerts.push(a) });
  assert.equal(r.deadLetter, 1);
  assert.equal(alerts.length, 1);

  const list = await listDeadLetters({});
  const item = list.items?.find(i => i.eventId === id) ?? list.events?.find(i => i.eventId === id);
  assert.ok(item, 'aparece na listagem de dead letters');
  assert.equal(item.error.code, 'RECOVERY_LIMIT_EXCEEDED');
  assert.equal(item.recoveryCount, MAX_RECOVERIES);

  const out = await retryDeadLetter(id);
  assert.equal(out.status, 'pending');
  assert.equal(added.filter(([, e]) => e === id).length, 3, 'republicado nas filas mapeadas');
  const doc = await get(id);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.recoveryCount, undefined, 'orçamento de recuperações zerado');
  assert.equal(doc.processingToken, undefined);

  await assert.rejects(retryDeadLetter(id), { code: 'EVENT_NOT_FOUND' }, 'segundo retry não republica');
  assert.equal(added.filter(([, e]) => e === id).length, 3);
  assert.equal((await claimEvent(id, 'w', { leaseMs: 5000 })).status, 'claimed', 'volta a ser processável');
});

// ---------- limite de recuperações também na retomada direta ----------
test('retomada direta de posse vencida conta como recuperação; a 3ª vai para dead_letter com alerta', { skip }, async () => {
  const id = await seed();
  const alerts = [];
  const opts = { leaseMs: 1, alert: async (a) => alerts.push(a) };
  assert.equal((await claimEvent(id, 'exec1', opts)).status, 'claimed');
  for (let n = 1; n < MAX_RECOVERIES; n++) {
    await sleep(10); // execução anterior morreu: prazo vence
    const c = await claimEvent(id, `exec${n + 1}`, opts);
    assert.equal(c.status, 'claimed');
    assert.equal(c.recoveryCount, n);
  }
  await sleep(10);
  const last = await claimEvent(id, 'execFinal', opts);
  assert.equal(last.status, 'dead_letter');
  assert.equal(last.exhausted, true);
  const doc = await get(id);
  assert.equal(doc.status, 'dead_letter');
  assert.equal(doc.recoveryCount, MAX_RECOVERIES);
  assert.equal(doc.error.code, 'RECOVERY_LIMIT_EXCEEDED');
  assert.equal(doc.error.stack, undefined, 'error substituído, não mesclado');
  assert.equal(doc.processingToken, undefined);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'event_recovery_limit');
  const r = await processWithGuarantees({ eventId: id }, async () => { throw new Error('não deveria rodar'); }, 'w');
  assert.equal(r.skipped, true);
});

test('reaper e retomada direta somam no mesmo contador', { skip }, async () => {
  const id = await seed();
  await claimEvent(id, 'exec1', { leaseMs: 1 });
  await sleep(10);
  assert.equal((await reapStuckEvents({ alert: async () => {} })).reset, 1); // recoveryCount 1
  await claimEvent(id, 'exec2', { leaseMs: 1 });
  await sleep(10);
  assert.equal((await claimEvent(id, 'exec3', { leaseMs: 1 })).recoveryCount, 2);
  await sleep(10);
  const r = await reapStuckEvents({ alert: async () => {} });
  assert.equal(r.deadLetter, 1);
  assert.equal((await get(id)).recoveryCount, 3);
});

test('falha comum (exceção) não consome o orçamento de recuperações', { skip }, async () => {
  const id = await seed();
  await assert.rejects(processWithGuarantees({ eventId: id }, async () => { const e = new Error('timeout ficticio'); e.code = 'ETIMEDOUT'; throw e; }, 'w', { leaseMs: 5000 }));
  const doc = await get(id);
  assert.equal(doc.status, 'failed');
  assert.equal(doc.recoveryCount, undefined);
});
