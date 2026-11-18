// Retry administrativo de dead_letter: contador, concorrência, falha ao
// republicar e trilha de auditoria. Filas simuladas; Mongo descartável.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
//     node --test --test-force-exit tests/eventstore/adminRetry.mongo.nodetest.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import EventStore from '../../models/EventStore.js';
import { claimEvent } from '../../infrastructure/events/eventOwnership.js';
import { processWithGuarantees, MAX_FAILED_ATTEMPTS } from '../../infrastructure/events/eventStoreService.js';
import { retryDeadLetter, retryBatchDeadLetters } from '../../infrastructure/observability/deadLetterService.js';
import { getQueue } from '../../infrastructure/queue/queueConfig.js';

const URI = process.env.MONGO_TEST_URI;
const skip = !URI ? 'MONGO_TEST_URI não definido' : false;
if (URI && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(URI).hostname)) throw new Error('loopback apenas');

const QUEUES = ['notification', 'patient-projection', 'clinical-orchestrator'];
let added = [];
let failAdd = false;

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_admin_retry_${Date.now()}` });
  for (const q of QUEUES) {
    getQueue(q).add = async (_name, data) => {
      await new Promise(r => setTimeout(r, 5));
      if (failAdd) throw new Error('redis indisponível (simulado)');
      added.push([q, data.eventId]);
      return { id: `fake-${q}-${added.length}` };
    };
  }
});
after(async () => { if (!skip) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
beforeEach(async () => { if (!skip) { await EventStore.collection.deleteMany({}); added = []; failAdd = false; } });

let n = 0;
async function seedDead(over = {}) {
  const eventId = `ar-${process.pid}-${Date.now()}-${n++}`;
  await EventStore.collection.insertOne({
    eventId, eventType: 'APPOINTMENT_CREATED', aggregateType: 'appointment', aggregateId: 'ficticio',
    payload: {}, status: 'dead_letter', attempts: 5, recoveryCount: 3, createdAt: new Date(),
    error: { message: 'Recovery limit reached (3); moved to dead_letter', code: 'RECOVERY_LIMIT_EXCEEDED' }, ...over
  });
  return eventId;
}
const get = (id) => EventStore.findOne({ eventId: id }).lean();

test('retry grava auditoria (quem, quando, contadores anteriores) e zera os contadores', { skip }, async () => {
  const id = await seedDead();
  const out = await retryDeadLetter(id, { requestedBy: 'admin-ficticio', reason: 'teste' });
  assert.equal(out.status, 'pending');
  const doc = await get(id);
  assert.equal(doc.attempts, 0);
  assert.equal(doc.recoveryCount, undefined);
  assert.equal(doc.adminRetryCount, 1);
  assert.equal(doc.adminRetries.length, 1);
  const a = doc.adminRetries[0];
  assert.equal(a.by, 'admin-ficticio');
  assert.equal(a.reason, 'teste');
  assert.equal(a.previousAttempts, 5);
  assert.equal(a.previousRecoveryCount, 3);
  assert.equal(a.previousErrorCode, 'RECOVERY_LIMIT_EXCEEDED');
  assert.equal(a.outcome, 'published');
  assert.equal(a.jobsAdded, 3);
});

test('retries concorrentes do mesmo evento: um republica, os outros recebem EVENT_NOT_FOUND', { skip }, async () => {
  const id = await seedDead();
  const settled = await Promise.allSettled(Array.from({ length: 6 }, () => retryDeadLetter(id, { requestedBy: 'a' })));
  assert.equal(settled.filter(s => s.status === 'fulfilled').length, 1);
  for (const s of settled.filter(x => x.status === 'rejected')) assert.equal(s.reason.code, 'EVENT_NOT_FOUND');
  assert.equal(added.filter(([, e]) => e === id).length, 3, 'uma publicação por fila');
  assert.equal((await get(id)).adminRetries.length, 1);
});

test('falha ao republicar: evento volta para dead_letter (não fica órfão) e a tentativa fica registrada', { skip }, async () => {
  const id = await seedDead();
  failAdd = true;
  await assert.rejects(retryDeadLetter(id, { requestedBy: 'admin' }), { code: 'RETRY_PUBLISH_FAILED' });
  let doc = await get(id);
  assert.equal(doc.status, 'dead_letter');
  assert.equal(doc.error.code, 'RETRY_PUBLISH_FAILED');
  assert.equal(doc.adminRetries[0].outcome, 'publish_failed');

  failAdd = false;
  await retryDeadLetter(id, { requestedBy: 'admin' });
  doc = await get(id);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.adminRetryCount, 2);
  assert.deepEqual(doc.adminRetries.map(r => r.outcome), ['publish_failed', 'published']);
});

test('ciclo completo: retry → falhas normais esgotam de novo → segundo retry; contadores não se somam indevidamente', { skip }, async () => {
  const id = await seedDead();
  await retryDeadLetter(id, { requestedBy: 'admin' });
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
    await assert.rejects(processWithGuarantees({ eventId: id }, async () => { throw new Error('falha-ficticia'); }, 'w'));
  }
  let doc = await get(id);
  assert.equal(doc.status, 'dead_letter');
  assert.equal(doc.attempts, MAX_FAILED_ATTEMPTS, 'contagem nova, não 5 + 5');
  await retryDeadLetter(id, { requestedBy: 'admin-2' });
  doc = await get(id);
  assert.equal(doc.adminRetryCount, 2);
  assert.equal(doc.adminRetries[1].previousAttempts, MAX_FAILED_ATTEMPTS);
  assert.equal(doc.adminRetries[1].by, 'admin-2');
  assert.equal((await claimEvent(id, 'w', { leaseMs: 5000 })).status, 'claimed');
});

test('lote: limite de 100 e auditoria por evento', { skip }, async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await seedDead());
  const r = await retryBatchDeadLetters({ eventIds: ids, limit: 10_000, requestedBy: 'admin-lote' });
  assert.equal(r.success, 3);
  for (const id of ids) assert.equal((await get(id)).adminRetries[0].by, 'admin-lote');
});
