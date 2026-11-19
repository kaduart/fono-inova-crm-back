// Achado do item 7 (ambiente integrado): se o primeiro uso do Redis pelo dispatcher
// acontece com o Redis fora do ar (lazyConnect), a fila criada nesse momento fica
// presa em "Connection is closed." mesmo depois que o Redis volta, até reiniciar o
// processo. O mesmo erro aparece nos outbox `failed` de produção.
//
// Reprodução REAL, sem mock: um proxy TCP na frente do Redis de teste começa
// desligado (Redis "fora do ar") e depois liga (Redis "volta"), na mesma porta.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
//   REDIS_TEST_URL='redis://127.0.0.1:6379/7' \
//     node --test --test-force-exit tests/outbox/dispatcherRedisVolta.mongo.nodetest.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

const URI = process.env.MONGO_TEST_URI;
const REDIS = process.env.REDIS_TEST_URL;
const skip = !URI || !REDIS ? 'MONGO_TEST_URI e REDIS_TEST_URL são necessários' : false;
const loopback = (u) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname);
if (!skip && (!loopback(URI) || !loopback(REDIS))) throw new Error('Mongo e Redis de teste precisam ser loopback');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

let Outbox, publishPendingEvents, getQueue, redis, proxy, port;
const sockets = new Set();
function startProxy() {
  const up = new URL(REDIS);
  proxy = net.createServer((c) => {
    const u = net.connect(Number(up.port || 6379), up.hostname);
    sockets.add(c); sockets.add(u);
    c.on('error', () => {}); u.on('error', () => {});
    c.pipe(u).pipe(c);
  });
  return new Promise((r) => proxy.listen(port, '127.0.0.1', r));
}

before(async () => {
  if (skip) return;
  port = await freePort();
  const db = new URL(REDIS).pathname || '/7';
  process.env.REDIS_URL = `redis://127.0.0.1:${port}${db}`; // proxy ainda desligado = Redis fora do ar
  ({ default: Outbox } = await import('../../infrastructure/outbox/OutboxModel.js'));
  ({ publishPendingEvents } = await import('../../infrastructure/outbox/outboxPattern.js'));
  ({ getQueue } = await import('../../infrastructure/queue/queueConfig.js'));
  ({ redisConnection: redis } = await import('../../config/redisConnection.js'));
  await mongoose.connect(URI, { dbName: `crm_dispatcher_volta_${Date.now()}` });
  await Outbox.init();
});

after(async () => {
  if (skip) return;
  await mongoose.connection.db.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  for (const s of sockets) s.destroy();
  proxy?.close();
  redis.disconnect();
});

test('Redis fora no 1º uso → failed; Redis volta → o mesmo dispatcher publica sem reiniciar', { skip, timeout: 60_000 }, async () => {
  const eventId = crypto.randomUUID();
  await Outbox.create({
    eventId, correlationId: eventId, eventType: 'PAYMENT_PROCESS_REQUESTED', aggregateType: 'payment',
    aggregateId: 'pay-ficticio', payload: { ficticio: true }, status: 'pending', scheduledAt: new Date(0)
  });

  const r1 = await publishPendingEvents(10);
  assert.equal(r1.failed, 1, 'com o Redis fora, a publicação falha');
  const f = await Outbox.findOne({ eventId }).lean();
  assert.equal(f.status, 'failed');
  assert.match(f.lastError, /Connection is closed/);

  await startProxy(); // Redis "volta" na mesma porta
  for (let i = 0; i < 60 && redis.status !== 'ready'; i++) await sleep(250);
  assert.equal(redis.status, 'ready', 'a conexão compartilhada voltou');

  // o que a recuperação de failed (KAS) faz: devolve a pending
  await Outbox.updateOne({ eventId }, { $set: { status: 'pending', scheduledAt: new Date(0) } });
  const r2 = await publishPendingEvents(10);
  assert.equal(r2.published, 1, `depois da volta do Redis o dispatcher deveria publicar; erros: ${JSON.stringify(r2.errors)}`);
  assert.equal((await Outbox.findOne({ eventId }).lean()).status, 'published');
  const job = await getQueue('payment-processing').getJob(`${eventId}__payment-processing`);
  assert.ok(job, 'job no Redis com jobId eventId__fila');
});
