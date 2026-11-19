// Item 7: boot REAL dos workers (startWorkersByGroup → registry → TotalsWorker) com o Redis fora do ar.
// Ele precisa voltar a consumir sozinho quando o Redis volta, sem reiniciar o processo,
// e de novo depois de uma conexão derrubada e de uma 2ª queda completa.
// Redis "fora" = proxy TCP desligado na frente do Redis de teste (mesma porta depois).
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
//   REDIS_TEST_URL='redis://127.0.0.1:6379/8' \
//     node --test --test-force-exit tests/isolado/workersRedisVolta.mongo.nodetest.mjs
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

let port, proxy, worker, redis, getQueue, TotalsSnapshot;
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

const consumed = [];
const mine = []; // só os jobs deste teste (o Redis de teste pode ter sobras de execuções anteriores)
async function enqueueAndWait(date, label, ms = 30_000) {
  const eventId = crypto.randomUUID();
  mine.push(`${eventId}__totals-calculation`);
  await getQueue('totals-calculation').add('TOTALS_RECALCULATE_REQUESTED',
    { eventId, eventType: 'TOTALS_RECALCULATE_REQUESTED', payload: { clinicId: 'clinica-ficticia', date, period: 'day', correlationId: eventId } },
    { jobId: `${eventId}__totals-calculation` });
  for (let i = 0; i < ms / 250; i++) {
    const snap = await TotalsSnapshot.findOne({ clinicId: 'clinica-ficticia', date, period: 'day' }).lean();
    if (snap && consumed.includes(`${eventId}__totals-calculation`)) return snap;
    await sleep(250);
  }
  throw new Error(`worker não consumiu o job (${label})`);
}

const BILLING_OFF = ['PAYMENT', 'BALANCE', 'PACKAGE_VALIDATION', 'INVOICE', 'PACKAGE_PROJECTION', 'PACKAGE_PROCESSING', 'COMMUNICATION_EMAIL', 'CONSUMER', 'COMMISSION_GENERATION'];
let startWorkersByGroup, stopAllWorkers, VALID_GROUPS, started;

before(async () => {
  if (skip) return;
  port = await freePort();
  const db = new URL(REDIS).pathname || '/8';
  process.env.REDIS_URL = `redis://127.0.0.1:${port}${db}`; // proxy desligado = Redis fora
  for (const f of BILLING_OFF) process.env[`ENABLE_BILLING_${f}`] = 'false'; // só o TotalsWorker no grupo
  process.env.ENABLE_BILLING_TOTALS = 'true';
  // chaves inválidas de propósito (o registry instancia clientes na importação); nada é chamado
  Object.assign(process.env, { OPENAI_API_KEY: 'sk-isolado-invalida', ANTHROPIC_API_KEY: 'isolado-invalida', RESEND_API_KEY: 're_isolado_invalida', GROQ_API_KEY: 'isolado-invalida', GEMINI_API_KEY: 'isolado-invalida',
    INTERNAL_BASE_URL: 'http://127.0.0.1:9', WHATSAPP_ENABLED: 'false', ENABLE_ADS_CONVERSION: 'false', ADS_CONVERSION_DRY_RUN: 'true',
    GOOGLE_ADS_CLIENT_ID: 'isolado', GOOGLE_ADS_CLIENT_SECRET: 'isolado', GOOGLE_ADS_REFRESH_TOKEN: 'isolado', GOOGLE_ADS_DEVELOPER_TOKEN: 'isolado', GOOGLE_ADS_CUSTOMER_ID: '0000000000' });
  await mongoose.connect(URI, { dbName: `crm_workers_volta_${Date.now()}` });
  ({ default: TotalsSnapshot } = await import('../../models/TotalsSnapshot.js'));
  ({ getQueue, redisConnection: redis } = await import('../../infrastructure/queue/queueConfig.js'));
  ({ startWorkersByGroup, stopAllWorkers, VALID_GROUPS } = await import('../../workers/index.js')); // caminho real do boot
});

after(async () => {
  if (skip) return;
  stopAllWorkers?.();
  await sleep(300);
  await mongoose.connection.db.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  dropConnections(); proxy?.close();
  redis.disconnect();
});

const isBullWorker = (w) => typeof w?.isRunning === 'function';

test('boot real (startWorkersByGroup) com Redis fora: espera o Redis, depois consome; e de novo após conexão derrubada e 2ª queda', { skip, timeout: 120_000 }, async () => {
  let resolved = false;
  const boot = startWorkersByGroup('billing').then((w) => { resolved = true; return w; });
  await sleep(2500);
  assert.equal(resolved, false, 'com o Redis fora o boot espera; não cria worker condenado');

  await startProxy(); // Redis volta
  started = await Promise.race([boot, sleep(30_000).then(() => { throw new Error('boot não terminou após a volta do Redis'); })]);
  const bull = started.filter(isBullWorker);
  assert.ok(bull.some((w) => w.name === 'totals-calculation'), 'TotalsWorker criado');
  // inclui os workers criados na importação do registry (patient/package*/communication-email)
  assert.ok(bull.length >= 1);
  const { patientWorker } = await import('../../domains/clinical/workers/patientWorker.js');
  const { communicationEmailWorker } = await import('../../domains/billing/workers/communicationEmailWorker.js');
  for (let i = 0; i < 40 && ![...bull, patientWorker, communicationEmailWorker].every((w) => w.isRunning()); i++) await sleep(250);
  for (const w of [...bull, patientWorker, communicationEmailWorker]) assert.equal(w.isRunning(), true, `worker ${w.name} rodando após a volta`);

  const totals = bull.find((w) => w.name === 'totals-calculation');
  totals.on('completed', (job) => consumed.push(job.id));

  const s1 = await enqueueAndWait('2026-11-10', 'após a 1ª volta');
  assert.equal(s1.totals.totalReceived, 0);

  dropConnections(); // conexão derrubada (proxy segue ligado)
  await sleep(500);
  await enqueueAndWait('2026-11-11', 'após conexão derrubada');

  await stopProxy(); // 2ª queda completa, com os workers já rodando
  await sleep(3000);
  await startProxy();
  await enqueueAndWait('2026-11-12', 'após a 2ª queda');

  const ours = consumed.filter((id) => mine.includes(id));
  assert.equal(ours.length, 3, 'cada job consumido uma vez');
  assert.equal(new Set(ours).size, 3);
});

test('VALID_GROUPS de workers/index.js bate com os grupos do registry', { skip }, async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../workers/registry.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const GROUPS = {'), src.indexOf('export const VALID_GROUPS'));
  const keys = [...body.matchAll(/^  ([a-z]+): async/gm)].map((m) => m[1]);
  assert.deepEqual([...keys].sort(), [...VALID_GROUPS].sort());
});
