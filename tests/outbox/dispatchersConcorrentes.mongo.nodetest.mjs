// Dois dispatchers do Outbox legado (Node) rodando ao mesmo tempo sobre os
// mesmos eventos pendentes. Mongo e Redis descartáveis em loopback; dados fictícios.
//
// O dispatcher não reserva o evento (lê `pending` e publica). O que evita job
// duplicado é o jobId determinístico `${eventId}__${fila}` no BullMQ, que só
// vale enquanto o job anterior ainda existe no Redis. Ver docs/DISPATCHERS.md.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
//   REDIS_TEST_URL='redis://127.0.0.1:6379/7' \
//     node --test --test-force-exit tests/outbox/dispatchersConcorrentes.mongo.nodetest.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

const URI = process.env.MONGO_TEST_URI;
const REDIS = process.env.REDIS_TEST_URL;
const skip = !URI || !REDIS ? 'MONGO_TEST_URI e REDIS_TEST_URL são necessários' : false;
const loopback = (u) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname);
if (!skip && (!loopback(URI) || !loopback(REDIS))) throw new Error('Mongo e Redis de teste precisam ser loopback');

let Outbox, publishPendingEvents, getQueue, redis;
const N = 40;
const QUEUE = 'payment-processing'; // destino de PAYMENT_PROCESS_REQUESTED

before(async () => {
  if (skip) return;
  process.env.REDIS_URL = REDIS; // antes de importar a conexão compartilhada
  ({ default: Outbox } = await import('../../infrastructure/outbox/OutboxModel.js'));
  ({ publishPendingEvents } = await import('../../infrastructure/outbox/outboxPattern.js'));
  ({ getQueue } = await import('../../infrastructure/queue/queueConfig.js'));
  ({ redisConnection: redis } = await import('../../config/redisConnection.js'));
  await redis.flushdb();
  await mongoose.connect(URI, { dbName: `crm_dispatchers_${Date.now()}` });
  await Outbox.init();
});

after(async () => {
  if (skip) return;
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  await redis.flushdb();
  await getQueue(QUEUE).close();
  redis.disconnect();
});

test(`dois dispatchers simultâneos sobre ${N} eventos: ${N} jobs, nenhum duplicado`, { skip }, async () => {
  const docs = Array.from({ length: N }, (_, i) => ({
    eventId: `evt-teste-${crypto.randomUUID()}`,
    correlationId: `corr-teste-${i}`,
    eventType: 'PAYMENT_PROCESS_REQUESTED',
    payload: { patientId: '0000000000000000000e2e02', amount: 1 }, // fictício
    aggregateType: 'payment',
    aggregateId: `agg-teste-${i}`,
    status: 'pending',
    scheduledAt: new Date(Date.now() - 1000)
  }));
  await Outbox.insertMany(docs);

  const [a, b] = await Promise.all([publishPendingEvents(100), publishPendingEvents(100)]);

  const q = getQueue(QUEUE);
  const counts = await q.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed', 'prioritized');
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  assert.equal(total, N, `esperava ${N} jobs, achou ${JSON.stringify(counts)}`);
  assert.equal(await Outbox.countDocuments({ status: 'published' }), N);
  // Os dois leram o lote inteiro: o trabalho é repetido, o job não.
  assert.equal(a.published + b.published, 2 * N);
});

test('evento que o dispatcher marca como failed não volta a ser publicado por ele', { skip }, async () => {
  await Outbox.create({
    eventId: `evt-teste-${crypto.randomUUID()}`, correlationId: 'corr-teste-f', eventType: 'EVENTO_QUE_NAO_EXISTE',
    payload: {}, aggregateType: 'teste', aggregateId: 'agg-teste-f', status: 'pending', scheduledAt: new Date(Date.now() - 1000)
  });
  await publishPendingEvents(100);
  const failed = await Outbox.findOne({ eventType: 'EVENTO_QUE_NAO_EXISTE' }).lean();
  assert.equal(failed.status, 'failed');
  await Outbox.updateOne({ _id: failed._id }, { $set: { scheduledAt: new Date(Date.now() - 1000) } });
  const again = await publishPendingEvents(100);
  assert.equal(again.processed, 0, 'o poller só lê pending; failed depende de recuperação externa (KAS #11)');
});
