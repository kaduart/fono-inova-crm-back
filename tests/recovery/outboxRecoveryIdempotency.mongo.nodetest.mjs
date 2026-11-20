// Idempotência dos consumidores que uma recuperação de Outbox (republicar
// entrada failed) pode atingir de novo: snapshot financeiro (SESSION_COMPLETED,
// PAYMENT_STATUS_CHANGED). O saldo do paciente tem suíte própria (balanceContract).
// Cobre: repetição, concorrência e falha depois de o efeito já ter sido aplicado.
//
// Mongo e Redis DESCARTÁVEIS em loopback, dados fictícios, banco próprio por execução.
//   MONGO_TXN_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' REDIS_URL=redis://127.0.0.1:6479 \
//     node --test --test-force-exit --test-concurrency=1 tests/recovery/outboxRecoveryIdempotency.mongo.nodetest.mjs
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const URI = process.env.MONGO_TXN_TEST_URI;
const skip = !URI ? 'MONGO_TXN_TEST_URI não definido' : false;
const loop = (u) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname);
if (URI && !loop(URI)) throw new Error('MONGO_TXN_TEST_URI precisa ser loopback');
if (process.env.REDIS_URL && !loop(process.env.REDIS_URL)) throw new Error('REDIS_URL precisa ser loopback');

const oid = () => new mongoose.Types.ObjectId();
let Snapshot, Session, PatientBalance;
let processFinancialEvent, onSessionCompleted, handleBalanceEvent;
const DAY = '2026-11-18';

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_recuperacao_idem_${Date.now()}` });
  ({ default: Snapshot } = await import('../../models/FinancialDailySnapshot.js'));
  ({ default: Session } = await import('../../models/Session.js'));
  ({ default: PatientBalance } = await import('../../models/PatientBalance.js'));
  ({ processFinancialEvent, onSessionCompleted } = await import('../../workers/financialSnapshotWorker.v2.js'));
  ({ handleBalanceEvent } = await import('../../workers/balanceWorker.js'));
  for (const M of [Snapshot, Session, PatientBalance]) {
    await M.createCollection().catch(() => {});
    await M.syncIndexes();
  }
});

after(async () => {
  if (skip) return;
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  if (skip) return;
  await Promise.all([Snapshot, Session, PatientBalance].map(M => M.collection.deleteMany({})));
});

// Sessão fictícia gravada direto na coleção (o snapshot só lê date e valor).
async function fakeSession(value = 180) {
  const _id = oid();
  await Session.collection.insertOne({ _id, date: new Date(`${DAY}T13:00:00Z`), sessionValue: value, method: 'particular', status: 'completed' });
  return _id.toString();
}
const day = () => Snapshot.findOne({ date: DAY, clinicId: 'default' }).lean();

describe('snapshot financeiro: SESSION_COMPLETED', () => {
  test('repetição: o mesmo SESSION_COMPLETED 3 vezes (com e sem eventId) soma uma vez', { skip }, async () => {
    const sessionId = await fakeSession(180);
    await onSessionCompleted({ sessionId });
    await onSessionCompleted({ sessionId, eventId: 'evt-a' });
    await processFinancialEvent('SESSION_COMPLETED', { sessionId, eventId: 'evt-b' });
    const d = await day();
    assert.equal(d.production.count, 1);
    assert.equal(d.production.total, 180);
    assert.equal(d.contributions.length, 1);
  });

  test('concorrência: 12 entregas simultâneas da mesma sessão, dia ainda sem documento', { skip }, async () => {
    const sessionId = await fakeSession(220);
    await Promise.all(Array.from({ length: 12 }, () => onSessionCompleted({ sessionId })));
    const d = await day();
    assert.equal(d.production.count, 1);
    assert.equal(d.production.total, 220);
  });

  test('concorrência: 8 sessões diferentes no mesmo dia não se perdem na corrida do upsert', { skip }, async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, () => fakeSession(100)));
    await Promise.all(ids.map(sessionId => onSessionCompleted({ sessionId })));
    const d = await day();
    assert.equal(d.production.count, 8);
    assert.equal(d.production.total, 800);
  });

  test('falha depois do efeito: o $inc entrou, o job falhou e foi reentregue', { skip }, async () => {
    const sessionId = await fakeSession(180);
    // 1ª entrega aplica e "falha" depois (ex.: worker morre antes do ack).
    await assert.rejects(async () => { await onSessionCompleted({ sessionId, eventId: 'evt-1' }); throw new Error('queda depois do efeito'); });
    // Reentrega do mesmo evento e também um replay com outro eventId.
    await onSessionCompleted({ sessionId, eventId: 'evt-1' });
    await onSessionCompleted({ sessionId, eventId: 'evt-replay' });
    const d = await day();
    assert.equal(d.production.count, 1);
    assert.equal(d.production.total, 180);
  });
});

describe('snapshot financeiro: PAYMENT_STATUS_CHANGED', () => {
  const psc = (eventId) => processFinancialEvent('PAYMENT_STATUS_CHANGED', {
    paymentId: '64b000000000000000000001', from: 'pending', to: 'paid', amount: 220,
    paymentMethod: 'pix', financialDate: `${DAY}T12:00:00Z`, eventId
  });

  test('repetição e concorrência com o mesmo eventId entram no caixa uma vez', { skip }, async () => {
    await Promise.all(Array.from({ length: 10 }, () => psc('evt-pay-1')));
    await psc('evt-pay-1');
    const d = await day();
    assert.equal(d.cash.total, 220);
    assert.equal(d.payments.countPaid, 1);
    assert.equal(d.processedEvents.filter(e => e === 'evt-pay-1').length, 1);
  });
});
