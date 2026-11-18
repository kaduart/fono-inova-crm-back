// Interação real entre BullMQ (tentativas, stalled) e a posse do Event Store
// (lease, recoveryCount, attempts). Mongo e Redis DESCARTÁVEIS em loopback.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
//   REDIS_TEST_URL='redis://127.0.0.1:6379' \
//     node --test --test-force-exit tests/eventstore/bullmqInteraction.mongo.nodetest.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import IORedis from 'ioredis';
import { Queue, Worker, QueueEvents } from 'bullmq';

import EventStore from '../../models/EventStore.js';
import { claimEvent } from '../../infrastructure/events/eventOwnership.js';
import { processWithGuarantees } from '../../infrastructure/events/eventStoreService.js';
import { reapStuckEvents } from '../../crons/eventReaper.cron.js';

const MONGO = process.env.MONGO_TEST_URI;
const REDIS = process.env.REDIS_TEST_URL;
const skip = (!MONGO || !REDIS) ? 'MONGO_TEST_URI e REDIS_TEST_URL são necessários' : false;
for (const u of [MONGO, REDIS].filter(Boolean)) {
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname)) throw new Error(`${u} precisa ser loopback`);
}

const DB = `crm_bullmq_posse_${Date.now()}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let n = 0;
const uid = (p) => `${p}-${process.pid}-${Date.now()}-${n++}`;
let connection;
const closers = [];

before(async () => {
  if (skip) return;
  await mongoose.connect(MONGO, { dbName: DB });
  connection = new IORedis(REDIS, { maxRetriesPerRequest: null });
});
after(async () => {
  if (skip) return;
  for (const c of closers.reverse()) await c().catch(() => {});
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await connection.quit();
});

async function seed(over = {}) {
  const eventId = uid('evt');
  await EventStore.collection.insertOne({
    eventId, eventType: 'APPOINTMENT_CREATED', aggregateType: 'appointment', aggregateId: 'ficticio',
    payload: {}, status: 'pending', attempts: 0, createdAt: new Date(), ...over
  });
  return eventId;
}
const get = (eventId) => EventStore.findOne({ eventId }).lean();

function setup(name, processor, workerOpts = {}) {
  const queue = new Queue(name, { connection });
  const events = new QueueEvents(name, { connection: connection.duplicate() });
  const worker = new Worker(name, processor, { connection: connection.duplicate(), ...workerOpts });
  closers.push(() => worker.close(), () => events.close(), () => queue.obliterate({ force: true }).then(() => queue.close()));
  return { queue, events, worker };
}

const finished = (events, jobId, timeoutMs) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout esperando o job')), timeoutMs);
  events.on('completed', ({ jobId: id }) => { if (id === jobId) { clearTimeout(t); resolve('completed'); } });
  events.on('failed', ({ jobId: id, failedReason }) => { if (id === jobId) { clearTimeout(t); resolve(`failed:${failedReason}`); } });
});

test('antes (sem espera): EVENT_BUSY esgota as tentativas do job antes do lease vencer e o evento fica órfão', { skip }, async () => {
  const id = await seed();
  const dead = await claimEvent(id, 'execucao-morta', { leaseMs: 4000 }); // ninguém renova
  assert.equal(dead.status, 'claimed');
  let runs = 0;
  const { queue, events } = setup(uid('q-sem-espera'), (job) =>
    processWithGuarantees({ eventId: job.data.eventId }, async () => { runs++; return 'ok'; }, 'w', { leaseMs: 4000, busyWaitMs: 0 }));
  await events.waitUntilReady();
  const job = await queue.add('e', { eventId: id }, { attempts: 5, backoff: { type: 'exponential', delay: 100 } });
  const outcome = await finished(events, job.id, 10_000);
  assert.match(outcome, /^failed:.*posse viva/);
  assert.equal(runs, 0);
  const doc = await get(id);
  assert.equal(doc.status, 'processing', 'evento preso com posse de execução morta');
  assert.equal(doc.processingToken, dead.token);
});

test('agora (com espera): a mesma entrega espera o lease vencer, retoma e conclui na 1ª tentativa', { skip }, async () => {
  const id = await seed();
  await claimEvent(id, 'execucao-morta', { leaseMs: 2000 });
  let runs = 0;
  const { queue, events } = setup(uid('q-com-espera'), (job) =>
    processWithGuarantees({ eventId: job.data.eventId }, async () => { runs++; return 'ok'; }, 'w', { leaseMs: 2000, busyPollMs: 200 }));
  await events.waitUntilReady();
  const job = await queue.add('e', { eventId: id }, { attempts: 5, backoff: { type: 'exponential', delay: 100 } });
  assert.equal(await finished(events, job.id, 15_000), 'completed');
  assert.equal(runs, 1);
  assert.equal((await queue.getJob(job.id)).attemptsMade, 1, 'uma única tentativa do BullMQ (no BullMQ 5 a conclusão conta 1)');
  const doc = await get(id);
  assert.equal(doc.status, 'processed');
  assert.equal(doc.recoveryCount, 1, 'um abandono = uma recuperação');
});

test('espera não atropela execução viva: quem espera vê o evento concluir e não reexecuta', { skip }, async () => {
  const id = await seed();
  let runs = 0;
  const first = processWithGuarantees({ eventId: id }, async () => { runs++; await sleep(1500); return 'a'; }, 'w1', { leaseMs: 600 });
  await sleep(100);
  const second = await processWithGuarantees({ eventId: id }, async () => { runs++; return 'b'; }, 'w2', { leaseMs: 600, busyPollMs: 100, busyWaitMs: 5000 });
  assert.equal((await first).success, true);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already_processed');
  assert.equal(runs, 1);
});

test('queda real (SIGKILL) + stalled do BullMQ: uma reexecução, recoveryCount = 1, sem tentativas extras', { skip }, async () => {
  const id = await seed();
  const name = uid('q-queda');
  process.env.EVENT_LEASE_MS = '2000';
  const queue = new Queue(name, { connection });
  const events = new QueueEvents(name, { connection: connection.duplicate() });
  closers.push(() => events.close(), () => queue.obliterate({ force: true }).then(() => queue.close()));
  await events.waitUntilReady();

  const child = fork(fileURLToPath(new URL('./fixtures/stallWorker.child.mjs', import.meta.url)),
    [MONGO, DB, REDIS, name], { env: { ...process.env, EVENT_LEASE_MS: '2000' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const started = new Promise(r => child.on('message', (m) => m.started && r()));
  await new Promise(r => child.on('message', (m) => m.ready && r()));
  const job = await queue.add('e', { eventId: id }, { attempts: 5, backoff: { type: 'exponential', delay: 100 } });
  await started;
  assert.equal((await get(id)).status, 'processing');
  child.kill('SIGKILL');

  let runs = 0;
  const worker = new Worker(name, (j) =>
    processWithGuarantees({ eventId: j.data.eventId }, async () => { runs++; return 'ok'; }, 'pai', { busyPollMs: 200 }),
  { connection: connection.duplicate(), lockDuration: 1000, stalledInterval: 1000, maxStalledCount: 1 });
  closers.push(() => worker.close());

  assert.equal(await finished(events, job.id, 30_000), 'completed');
  delete process.env.EVENT_LEASE_MS;
  assert.equal(runs, 1, 'processador do pai executou uma vez');
  const doc = await get(id);
  assert.equal(doc.status, 'processed');
  assert.equal(doc.recoveryCount, 1);
  assert.equal(doc.attempts ?? 0, 0, 'queda não conta como falha comum');
});

test('reaper e entregas concorrentes contam um abandono uma vez só', { skip }, async () => {
  for (let round = 0; round < 5; round++) {
    const id = await seed();
    await claimEvent(id, 'morta', { leaseMs: 1 });
    await sleep(10);
    const results = await Promise.all([
      reapStuckEvents({ alert: () => {}, legacyFence: null }),
      ...Array.from({ length: 5 }, () => claimEvent(id, 'nova', { leaseMs: 60_000, legacyFence: null, alert: () => {} }))
    ]);
    const claims = results.slice(1).filter(c => c.status === 'claimed');
    assert.ok(claims.length <= 1, 'no máximo uma execução retoma');
    assert.equal((await get(id)).recoveryCount, 1, `rodada ${round}: um abandono = uma recuperação`);
  }
});

test('evento em dead_letter: novas entregas do BullMQ terminam sem executar', { skip }, async () => {
  const id = await seed({ status: 'dead_letter', recoveryCount: 3 });
  let runs = 0;
  const { queue, events } = setup(uid('q-dlq'), (job) =>
    processWithGuarantees({ eventId: job.data.eventId }, async () => { runs++; return 'x'; }, 'w'));
  await events.waitUntilReady();
  const job = await queue.add('e', { eventId: id }, { attempts: 5, backoff: { type: 'fixed', delay: 50 } });
  assert.equal(await finished(events, job.id, 10_000), 'completed');
  assert.equal(runs, 0);
  assert.equal((await queue.getJob(job.id)).attemptsMade, 1, 'uma única tentativa');
});
