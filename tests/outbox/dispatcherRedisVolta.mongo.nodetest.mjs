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
function dropConnections() { for (const s of sockets) s.destroy(); sockets.clear(); }
function stopProxy() { dropConnections(); return new Promise((r) => proxy.close(() => r())); }
async function waitReady() { for (let i = 0; i < 80 && redis.status !== 'ready'; i++) await sleep(250); assert.equal(redis.status, 'ready'); }

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

// Mesma fila, 2ª rodada: o que a correção NÃO pode quebrar.
//  - eventos pendentes não somem nem são pulados durante a queda;
//  - reconexões, recuperações repetidas e dois dispatchers ao mesmo tempo não criam job extra.
test('queda e reconexões: pendentes preservados e nenhuma publicação extra no Redis', { skip, timeout: 90_000 }, async () => {
  await waitReady();
  const q = () => getQueue('payment-processing');
  const mk = async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const eventId = crypto.randomUUID();
      await Outbox.create({ eventId, correlationId: eventId, eventType: 'PAYMENT_PROCESS_REQUESTED', aggregateType: 'payment',
        aggregateId: `pay-ficticio-${i}`, payload: { ficticio: true }, status: 'pending', scheduledAt: new Date(0), createdAt: new Date(Date.now() + i) });
      out.push(eventId);
    }
    return out;
  };
  const jobsFor = async (ids) => {
    const jobs = await q().getJobs(['waiting', 'delayed', 'paused', 'prioritized', 'active', 'completed', 'failed'], 0, -1);
    return jobs.filter((j) => ids.includes(j.data?.eventId));
  };
  const totalJobs = async () => Object.values(await q().getJobCounts()).reduce((a, b) => a + b, 0);

  const ids = await mk(6);
  await stopProxy(); // Redis cai com 6 pendentes
  for (let i = 0; i < 40 && redis.status === 'ready'; i++) await sleep(100);
  assert.notEqual(redis.status, 'ready');

  const during = publishPendingEvents(3); // lote de 3 durante a queda
  await sleep(1500);
  const mid = await Outbox.find({ eventId: { $in: ids } }).lean();
  assert.equal(mid.length, 6, 'nenhum evento some');
  assert.equal(mid.filter((e) => e.status === 'published').length, 0, 'nada é marcado publicado com o Redis fora');
  const outsideBatch = ids.slice(3);
  assert.ok(mid.filter((e) => outsideBatch.includes(e.eventId)).every((e) => e.status === 'pending'), 'os fora do lote seguem pending');

  await startProxy(); // volta
  await waitReady();
  const r1 = await Promise.race([during, sleep(20_000).then(() => { throw new Error('dispatcher travou depois da volta'); })]);
  assert.equal(r1.processed, 3);

  // recuperação (o que a KAS faz com failed) até esvaziar, repetida de propósito
  for (let i = 0; i < 6; i++) {
    await Outbox.updateMany({ eventId: { $in: ids }, status: 'failed' }, { $set: { status: 'pending', scheduledAt: new Date(0) } });
    await publishPendingEvents(10);
  }
  const done = await Outbox.find({ eventId: { $in: ids } }).lean();
  assert.ok(done.every((e) => e.status === 'published'), `todos publicados: ${done.map((e) => e.status)}`);
  let jobs = await jobsFor(ids);
  assert.equal(jobs.length, 6, 'exatamente 1 job por evento');
  assert.deepEqual(jobs.map((j) => j.id).sort(), ids.map((id) => `${id}__payment-processing`).sort());
  const before = await totalJobs();

  // reenvio indevido: tudo volta a pending e DOIS dispatchers rodam juntos
  await Outbox.updateMany({ eventId: { $in: ids } }, { $set: { status: 'pending', scheduledAt: new Date(0) } });
  const [a, b] = await Promise.all([publishPendingEvents(10), publishPendingEvents(10)]);
  assert.equal(a.failed + b.failed, 0);
  assert.equal(await totalJobs(), before, 'nenhum job novo no Redis');
  jobs = await jobsFor(ids);
  assert.equal(jobs.length, 6);

  // reconexão sem desligar (conexão derrubada no meio): novos eventos publicam 1 vez cada
  const more = await mk(2);
  dropConnections();
  await sleep(300);
  await waitReady();
  let r3 = await publishPendingEvents(10);
  if (r3.failed) { // a queda pode pegar a publicação no meio; a recuperação resolve
    await Outbox.updateMany({ eventId: { $in: more }, status: 'failed' }, { $set: { status: 'pending', scheduledAt: new Date(0) } });
    r3 = await publishPendingEvents(10);
  }
  assert.ok((await Outbox.find({ eventId: { $in: more } }).lean()).every((e) => e.status === 'published'));
  assert.equal(await totalJobs(), before + 2, 'só os 2 novos entraram');
  assert.equal((await jobsFor(more)).length, 2);
});
