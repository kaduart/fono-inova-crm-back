// Versões mistas: código antigo (sem posse) convivendo com o novo durante a
// implantação. Mostra o que a ordem API → worker e a cerca garantem, e o que
// NÃO garantem. Mongo descartável em loopback; dados fictícios.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
//     node --test --test-force-exit tests/eventstore/mixedVersions.mongo.nodetest.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import EventStore from '../../models/EventStore.js';
import { claimEvent } from '../../infrastructure/events/eventOwnership.js';
import { processWithGuarantees } from '../../infrastructure/events/eventStoreService.js';
import { reapStuckEvents } from '../../crons/eventReaper.cron.js';
import { legacyProcessWithGuarantees, legacyReapStuckEvents } from './fixtures/legacyV1.mjs';

const URI = process.env.MONGO_TEST_URI;
const skip = !URI ? 'MONGO_TEST_URI não definido' : false;
if (URI && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(URI).hostname)) throw new Error('loopback apenas');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let n = 0;
const MIN = 60_000;
async function seed(over = {}) {
  const eventId = `mv-${process.pid}-${Date.now()}-${n++}`;
  await EventStore.collection.insertOne({
    eventId, eventType: 'APPOINTMENT_CREATED', aggregateType: 'appointment', aggregateId: 'ficticio',
    payload: {}, status: 'pending', attempts: 0, createdAt: new Date(), ...over
  });
  return eventId;
}
const get = (id) => EventStore.findOne({ eventId: id }).lean();

before(async () => { if (!skip) await mongoose.connect(URI, { dbName: `crm_mixed_${Date.now()}` }); });
after(async () => { if (!skip) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
beforeEach(async () => { if (!skip) await EventStore.collection.deleteMany({}); });

test('worker antigo em execução + worker novo, antes da cerca: o novo não executa; depois vê processed', { skip }, async () => {
  const id = await seed({ createdAt: new Date(Date.now() - 20 * MIN) });
  let runs = 0;
  let release;
  const old = legacyProcessWithGuarantees({ eventId: id }, () => new Promise(r => { runs++; release = r; }), 'velho');
  await sleep(50);
  await assert.rejects(
    processWithGuarantees({ eventId: id }, async () => { runs++; }, 'novo', { busyWaitMs: 300, busyPollMs: 100 }),
    { code: 'EVENT_BUSY' }
  );
  release('ok');
  await old;
  const again = await processWithGuarantees({ eventId: id }, async () => { runs++; }, 'novo');
  assert.equal(again.reason, 'already_processed');
  assert.equal(runs, 1);
});

test('reaper NOVO + worker antigo: evento sem posse não é devolvido antes da cerca', { skip }, async () => {
  const id = await seed({ status: 'processing', createdAt: new Date(Date.now() - 20 * MIN) });
  const r = await reapStuckEvents({ alert: () => {}, legacyFence: null });
  assert.equal(r.legacyAwaiting, 1);
  assert.equal((await get(id)).status, 'processing', 'não libera execução que pode estar viva');
});

test('ordem ERRADA (reaper ANTIGO + worker novo): o reaper antigo arranca a posse e o evento roda duas vezes', { skip }, async () => {
  // Por isso o runbook exige API (que roda o reaper) antes do worker.
  const id = await seed({ createdAt: new Date(Date.now() - 20 * MIN) });
  let runs = 0;
  const first = processWithGuarantees({ eventId: id }, async () => {
    runs++;
    await legacyReapStuckEvents();        // reaper antigo roda no meio da execução
    await sleep(50);
    return 'a';
  }, 'novo-1', { leaseMs: 60_000 });
  const r1 = await first;
  assert.equal(r1.ownershipLost, true, 'conclusão condicional recusada: a posse foi arrancada');
  assert.equal((await get(id)).status, 'pending');
  await processWithGuarantees({ eventId: id }, async () => { runs++; }, 'novo-2');
  assert.equal(runs, 2, 'execução dupla: o código novo detecta, mas não impede, enquanto o reaper antigo estiver vivo');
});

test('ordem CERTA (reaper novo + worker novo): execução longa com posse renovada não é tocada', { skip }, async () => {
  const id = await seed({ createdAt: new Date(Date.now() - 20 * MIN) });
  let reaped = null;
  const r = await processWithGuarantees({ eventId: id }, async () => {
    reaped = await reapStuckEvents({ alert: () => {}, legacyFence: null });
    return 'ok';
  }, 'novo', { leaseMs: 60_000 });
  assert.equal(r.success, true);
  assert.equal(reaped.reset + reaped.failed, 0);
  assert.equal((await get(id)).status, 'processed');
});

test('a cerca é declaração do operador: se um worker antigo AINDA roda, a cerca permite execução dupla', { skip }, async () => {
  // Um timestamp não prova que o worker antigo parou. A cerca só pode ser
  // definida depois de confirmar que nenhum processo antigo está vivo.
  const id = await seed({ createdAt: new Date(Date.now() - 20 * MIN) });
  let runs = 0;
  let release;
  const old = legacyProcessWithGuarantees({ eventId: id }, () => new Promise(r => { runs++; release = r; }), 'velho-ainda-vivo');
  await sleep(50);
  const fence = new Date(Date.now() - MIN); // operador declarou a cerca cedo demais
  const claim = await claimEvent(id, 'novo', { legacyFence: fence, alert: () => {} });
  assert.equal(claim.status, 'claimed', 'o novo retoma o evento do antigo');
  runs++; // o novo executaria agora, em paralelo ao antigo
  release('ok');
  await old;
  assert.equal(runs, 2);
});

test('cerca correta (depois de o antigo parar): evento antigo órfão é retomado uma vez', { skip }, async () => {
  const id = await seed({ status: 'processing', createdAt: new Date(Date.now() - 20 * MIN) });
  const fence = new Date(Date.now() - MIN);
  const claims = await Promise.all(Array.from({ length: 4 }, () => claimEvent(id, 'novo', { legacyFence: fence, alert: () => {} })));
  assert.equal(claims.filter(c => c.status === 'claimed').length, 1);
  assert.equal((await get(id)).recoveryCount, 1);
});
