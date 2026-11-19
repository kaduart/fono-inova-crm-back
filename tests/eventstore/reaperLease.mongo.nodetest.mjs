// Posse do reaper compartilhada entre Node e KAS (mesmo documento
// kas_event_reaper_lease). MongoDB DESCARTÁVEL em loopback, com replica set
// (as escritas cercadas usam transação). Dados fictícios.
//
//   MONGO_TXN_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' \
//     node --test --test-force-exit tests/eventstore/reaperLease.mongo.nodetest.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import EventStore from '../../models/EventStore.js';
import {
  createReaperLease, liveReaperLeaseHolder, sharedLeaseModeFromEnv, reaperLeaseTtlFromEnv,
  REAPER_LEASE_COLLECTION, REAPER_LEASE_ID, ReaperLeaseLostError
} from '../../infrastructure/events/reaperLease.js';
import { reapStuckEvents } from '../../crons/eventReaper.cron.js';

const URI = process.env.MONGO_TXN_TEST_URI;
const skip = !URI ? 'MONGO_TXN_TEST_URI não definido' : false;
if (URI) {
  const host = new URL(URI).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error('MONGO_TXN_TEST_URI precisa ser loopback');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const leaseDoc = () => mongoose.connection.db.collection(REAPER_LEASE_COLLECTION).findOne({ _id: REAPER_LEASE_ID });

let seq = 0;
async function seedStuck(n) {
  const docs = [];
  for (let i = 0; i < n; i++) {
    docs.push({
      eventId: `stuck-${process.pid}-${seq++}`, eventType: 'APPOINTMENT_CREATED', aggregateType: 'appointment',
      aggregateId: 'agg-ficticio', payload: { nome: 'PACIENTE FICTICIO' }, status: 'processing', attempts: 0,
      processingToken: 'tok-morto', processingOwner: 'worker-morto', leaseExpiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 3_600_000)
    });
  }
  await EventStore.collection.insertMany(docs);
  return docs.map((d) => d.eventId);
}

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_reaper_lease_${Date.now()}` });
  await EventStore.createCollection().catch(() => {});
  await mongoose.connection.db.createCollection(REAPER_LEASE_COLLECTION).catch(() => {});
});
after(async () => {
  if (skip) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
beforeEach(async () => {
  if (skip) return;
  await EventStore.deleteMany({});
  await mongoose.connection.db.collection(REAPER_LEASE_COLLECTION).deleteMany({});
});

test('configuração: EVENT_REAPER_SHARED_LEASE on/off, TTL validado', () => {
  assert.equal(sharedLeaseModeFromEnv({}), 'off');
  assert.equal(sharedLeaseModeFromEnv({ EVENT_REAPER_SHARED_LEASE: ' ON ' }), 'on');
  assert.throws(() => sharedLeaseModeFromEnv({ EVENT_REAPER_SHARED_LEASE: 'sim' }), /EVENT_REAPER_SHARED_LEASE inválido/);
  assert.equal(reaperLeaseTtlFromEnv({}), 12 * 60_000);
  assert.throws(() => reaperLeaseTtlFromEnv({ EVENT_REAPER_LEASE_TTL_MS: '10' }), /inválido/);
});

test('um dono vivo por vez: o segundo não toma enquanto o primeiro renova', { skip }, async () => {
  const a = createReaperLease({ holder: 'crm-node:A', ttlMs: 2000 });
  const b = createReaperLease({ holder: 'kas:B', ttlMs: 2000 });
  assert.equal(await a.acquire(), true);
  assert.equal(await b.acquire(), false);
  assert.equal(await a.acquire(), true, 'renovação do próprio dono');
  assert.equal((await liveReaperLeaseHolder()).holder, 'crm-node:A');
  await a.release();
  assert.equal(await liveReaperLeaseHolder(), null, 'release deixa a posse livre na hora');
  assert.equal(await b.acquire(), true);
  assert.equal((await leaseDoc()).holder, 'kas:B');
});

test('formato igual ao da KAS: holder, token, expiresAt pelo relógio do servidor', { skip }, async () => {
  const a = createReaperLease({ holder: 'crm-node:A', ttlMs: 5000 });
  await a.acquire();
  const d = await leaseDoc();
  assert.equal(d._id, 'crm-eventstore-reaper');
  assert.equal(typeof d.token, 'string');
  assert.ok(d.expiresAt instanceof Date && d.renewedAt instanceof Date);
  const ttl = d.expiresAt.getTime() - d.renewedAt.getTime();
  assert.equal(ttl, 5000);
});

test('Node com posse: recupera, e cada escrita vai na mesma transação que a posse', { skip }, async () => {
  const ids = await seedStuck(5);
  const lease = createReaperLease({ holder: 'crm-node:A', ttlMs: 10_000 });
  assert.equal(await lease.acquire(), true);
  const r = await reapStuckEvents({ lease, alert: () => {} });
  assert.equal(r.reset, 5);
  assert.equal(r.leaseLost, false);
  const after = await EventStore.find({ eventId: { $in: ids } }).lean();
  assert.ok(after.every((e) => e.status === 'pending' && e.recoveryCount === 1));
  assert.ok((await leaseDoc()).fencedWriteAt instanceof Date);
});

test('executor que perdeu a posse não grava nada (troca de dono no meio)', { skip }, async () => {
  const ids = await seedStuck(4);
  const stale = createReaperLease({ holder: 'crm-node:A', ttlMs: 1000 });
  assert.equal(await stale.acquire(), true);
  await sleep(1200); // prazo vence (processo travado, GC, rede)
  const kas = createReaperLease({ holder: 'kas:B', ttlMs: 10_000 });
  assert.equal(await kas.acquire(), true, 'KAS assume a posse vencida com token novo');

  const r = await reapStuckEvents({ lease: stale, alert: () => {} });
  assert.equal(r.leaseLost, true);
  assert.equal(r.reset + r.failed + r.deadLetter, 0);
  const after = await EventStore.find({ eventId: { $in: ids } }).lean();
  assert.ok(after.every((e) => e.status === 'processing' && e.recoveryCount == null), 'nenhum evento tocado pelo dono antigo');
  await assert.rejects(() => stale.fence(null), ReaperLeaseLostError);
  assert.equal((await leaseDoc()).holder, 'kas:B');
});

test('modo off: posse viva da KAS é visível só por leitura (Node pula o ciclo)', { skip }, async () => {
  const kas = createReaperLease({ holder: 'kas:B', ttlMs: 10_000 });
  await kas.acquire();
  const h = await liveReaperLeaseHolder();
  assert.equal(h.holder, 'kas:B');
  assert.ok(h.msLeft > 0);
});

test('concorrência: 6 disputas simultâneas, exatamente 1 vence', { skip }, async () => {
  const leases = Array.from({ length: 6 }, (_, i) => createReaperLease({ holder: `h${i}`, ttlMs: 5000 }));
  const won = await Promise.all(leases.map((l) => l.acquire()));
  assert.equal(won.filter(Boolean).length, 1);
});
