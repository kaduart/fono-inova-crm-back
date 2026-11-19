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
  REAPER_LEASE_COLLECTION, REAPER_LEASE_ID, ReaperLeaseLostError, reaperLeaseSnapshot
} from '../../infrastructure/events/reaperLease.js';
import { reapStuckEvents, runReaperCycle, initEventReaperCron } from '../../crons/eventReaper.cron.js';

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

// ── Matriz de configuração: variável ausente, off, on, inválida e divergente da KAS ──
// "KAS" abaixo = createReaperLease com holder kas:*, mesma semântica do Go
// (internal/legacy/crmeventstore/lease.go; a guarda -require-crm-node-lease
// tem testes próprios em lease_crmnode_test.go).
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const listLeaseCollections = async () => (await mongoose.connection.db.listCollections({ name: REAPER_LEASE_COLLECTION }).toArray()).length;

test('matriz: variável AUSENTE = off. Recupera sem posse, não cria documento nem marca', { skip }, async () => {
  const ids = await seedStuck(3);
  await withEnv({ EVENT_REAPER_SHARED_LEASE: undefined }, () => runReaperCycle());
  const after = await EventStore.find({ eventId: { $in: ids } }).lean();
  assert.ok(after.every((e) => e.status === 'pending'), 'recuperou como o reaper antigo');
  assert.equal(await leaseDoc(), null, 'nenhum documento de posse criado');
  assert.ok(await listLeaseCollections() <= 1);
});

test('matriz: OFF com posse viva da KAS. Node pula o ciclo e não grava nada', { skip }, async () => {
  const ids = await seedStuck(3);
  const kas = createReaperLease({ holder: 'kas:B', ttlMs: 10_000 });
  await kas.acquire();
  await withEnv({ EVENT_REAPER_SHARED_LEASE: 'off' }, () => runReaperCycle());
  const after = await EventStore.find({ eventId: { $in: ids } }).lean();
  assert.ok(after.every((e) => e.status === 'processing'), 'Node off não tocou em nada');
  assert.equal((await reaperLeaseSnapshot()).nodeMarkerAgeMs, null, 'off nunca grava a marca de participação');
});

test('matriz: OFF + KAS SEM a guarda = dois responsáveis (incompatível)', { skip }, async () => {
  // O Node off confere a posse só no início do ciclo. Se a KAS assumir depois
  // dessa conferência, os dois recuperam no mesmo intervalo. A escrita condicional
  // evita gravar o MESMO evento duas vezes, mas há dois donos agindo juntos.
  const ids = await seedStuck(6);
  assert.equal(await liveReaperLeaseHolder(), null, 'Node off conferiu: sem posse viva');
  const kas = createReaperLease({ holder: 'kas:B', ttlMs: 10_000 });
  assert.equal(await kas.acquire(), true, 'KAS sem a guarda assume logo depois');
  const kasRun = await reapStuckEvents({ lease: kas, alert: () => {}, batchSize: 3 });
  const nodeRun = await reapStuckEvents({ lease: null, alert: () => {} }); // ciclo do Node off seguindo
  assert.equal(kasRun.reset, 3);
  assert.equal(nodeRun.reset, 3, 'Node off recuperou sem posse enquanto a KAS tinha a posse viva');
  const after = await EventStore.find({ eventId: { $in: ids } }).lean();
  assert.ok(after.every((e) => e.recoveryCount === 1), 'nenhum evento gravado duas vezes, mas dois donos agiram');
});

test('matriz: ON. Disputa a posse, cerca as escritas e grava a marca de participação', { skip }, async () => {
  const ids = await seedStuck(2);
  await withEnv({ EVENT_REAPER_SHARED_LEASE: 'on' }, () => runReaperCycle());
  const snap = await reaperLeaseSnapshot();
  assert.match(snap.holder, /^crm-node:/);
  assert.ok(snap.nodeMarkerAgeMs !== null && snap.nodeMarkerAgeMs < 5000, 'marca fresca');
  assert.ok((await leaseDoc()).fencedWriteAt instanceof Date, 'escritas cercadas');
  const after = await EventStore.find({ eventId: { $in: ids } }).lean();
  assert.ok(after.every((e) => e.status === 'pending'));
});

test('matriz: ON com a KAS dona. Node pula, mas renova a marca (a KAS com a guarda segue agindo)', { skip }, async () => {
  const ids = await seedStuck(2);
  const kas = createReaperLease({ holder: 'kas:B', ttlMs: 10_000 });
  await kas.acquire();
  await withEnv({ EVENT_REAPER_SHARED_LEASE: 'on' }, () => runReaperCycle());
  const snap = await reaperLeaseSnapshot();
  assert.equal(snap.holder, 'kas:B');
  assert.ok(snap.nodeMarkerAgeMs !== null && snap.nodeMarkerAgeMs < 5000);
  const after = await EventStore.find({ eventId: { $in: ids } }).lean();
  assert.ok(after.every((e) => e.status === 'processing'), 'Node sem posse não grava');
});

test('matriz: reversão ON → OFF. A marca para de ser renovada (a KAS com a guarda para em até max-age)', { skip }, async () => {
  await withEnv({ EVENT_REAPER_SHARED_LEASE: 'on' }, () => runReaperCycle());
  const t1 = (await leaseDoc()).participants.crmNode.at.getTime();
  await sleep(50);
  await withEnv({ EVENT_REAPER_SHARED_LEASE: 'off' }, () => runReaperCycle());
  const t2 = (await leaseDoc()).participants.crmNode.at.getTime();
  assert.equal(t2, t1, 'off não renova a marca');
});

test('matriz: valor INVÁLIDO derruba a subida do cron (não roda calado)', () => {
  const saved = process.env.EVENT_REAPER_SHARED_LEASE;
  process.env.EVENT_REAPER_SHARED_LEASE = 'sim';
  try {
    assert.throws(() => initEventReaperCron(), /EVENT_REAPER_SHARED_LEASE inválido/);
  } finally {
    if (saved === undefined) delete process.env.EVENT_REAPER_SHARED_LEASE; else process.env.EVENT_REAPER_SHARED_LEASE = saved;
  }
});

// Troca Node → Go com a guarda: EVENT_REAPER_OWNER=kas + on deixa o Node CEDENTE.
test('troca: OWNER=kas + ON = modo cedente. Renova a marca (yield), nunca toma a posse, nunca recupera', { skip }, async () => {
  const ids = await seedStuck(3);
  const { startReaperYieldIfShared, stopAllCronsAndRelease } = await import('../../config/cronManager.js');
  const cron = await withEnv({ EVENT_REAPER_SHARED_LEASE: 'on', EVENT_REAPER_INTERVAL_MS: '500' }, () => startReaperYieldIfShared());
  try {
    assert.ok(cron, 'modo cedente sobe com on');
    await sleep(1300);
    const doc = await leaseDoc();
    assert.equal(doc.participants.crmNode.mode, 'yield');
    assert.ok(Date.now() - doc.participants.crmNode.at.getTime() < 2000, 'marca renovada a cada intervalo');
    assert.ok(!doc.token && doc.expiresAt.getTime() === 0, 'o Node cedente nunca toma a posse');
    const kas = createReaperLease({ holder: 'kas:troca', ttlMs: 10_000 });
    assert.equal(await kas.acquire(), true, 'a KAS (com a guarda) fica livre para assumir');
    const after = await EventStore.find({ eventId: { $in: ids } }).lean();
    assert.ok(after.every((e) => e.status === 'processing'), 'o Node cedente não recupera nada');
  } finally {
    await stopAllCronsAndRelease();
  }
});

test('troca: OWNER=kas SEM on não sobe nada e avisa (a KAS com a guarda também fica parada)', { skip }, async () => {
  const { startReaperYieldIfShared } = await import('../../config/cronManager.js');
  const warns = [];
  const orig = console.warn; console.warn = (m) => warns.push(String(m));
  try {
    const cron = await withEnv({ EVENT_REAPER_SHARED_LEASE: 'off' }, () => startReaperYieldIfShared());
    assert.equal(cron, null);
  } finally { console.warn = orig; }
  assert.ok(warns.some((w) => /SEM EVENT_REAPER_SHARED_LEASE=on/.test(w)));
  assert.equal(await leaseDoc(), null, 'sem marca, sem documento');
});
