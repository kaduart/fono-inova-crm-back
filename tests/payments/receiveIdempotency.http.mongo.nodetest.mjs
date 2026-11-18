// POST /api/v2/financial/receive pela camada HTTP real (express + auth + transação).
// Idempotency-Key, clique duplo, concorrência, timeout após gravação, falha no meio
// e mesma chave com conteúdo diferente. Mongo DESCARTÁVEL em replica set e Redis
// de loopback. Dados fictícios.
//
//   MONGO_TXN_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' REDIS_URL=redis://127.0.0.1:6479 \
//     node --test --test-force-exit tests/payments/receiveIdempotency.http.mongo.nodetest.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const URI = process.env.MONGO_TXN_TEST_URI;
const skip = !URI ? 'MONGO_TXN_TEST_URI não definido' : false;
const loop = (u) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname);
if (URI && !loop(URI)) throw new Error('MONGO_TXN_TEST_URI precisa ser loopback');
if (process.env.REDIS_URL && !loop(process.env.REDIS_URL)) throw new Error('REDIS_URL precisa ser loopback');

process.env.JWT_SECRET = 'segredo-de-teste-ficticio';
const oid = () => new mongoose.Types.ObjectId();
let app, Admin, Payment, PatientBalance, PaymentOperation, tokenAdmin;
let n = 0;
const key = () => `chave-ficticia-${process.pid}-${Date.now()}-${n++}`;

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_receive_${Date.now()}` });
  ({ default: Admin } = await import('../../models/Admin.js'));
  ({ default: Payment } = await import('../../models/Payment.js'));
  ({ default: PatientBalance } = await import('../../models/PatientBalance.js'));
  ({ default: PaymentOperation } = await import('../../models/PaymentOperation.js'));
  const { default: Appointment } = await import('../../models/Appointment.js');
  const { default: Session } = await import('../../models/Session.js');
  const { default: Outbox } = await import('../../infrastructure/outbox/OutboxModel.js');
  const { default: router } = await import('../../routes/financialSummary.js');
  // Em produção as coleções existem; transações não criam coleção em paralelo.
  for (const M of [Payment, PatientBalance, PaymentOperation, Appointment, Session, Outbox]) {
    await M.createCollection().catch(() => {});
    await M.init(); // espera os índices: build de índice durante a transação vira erro 112
  }
  app = express();
  app.use(express.json());
  app.use('/api/v2/financial', router);
  const adminId = oid();
  await Admin.collection.insertOne({ _id: adminId, name: 'Admin Ficticio', email: 'admin@teste.invalid', role: 'admin' });
  tokenAdmin = jwt.sign({ id: adminId.toString(), role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
});

after(async () => {
  if (skip) return;
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  if (skip) return;
  await Promise.all([Payment, PatientBalance, PaymentOperation].map((M) => M.collection.deleteMany({})));
});

async function seedPending(patientId, amounts) {
  const now = new Date();
  await Payment.collection.insertMany(amounts.map((a, i) => ({
    patient: patientId, patientId: String(patientId), doctor: oid(), amount: a, status: 'pending',
    kind: 'manual_debit', billingType: 'particular', paymentMethod: 'dinheiro', clinicId: 'default',
    serviceDate: new Date(now.getTime() - (amounts.length - i) * 86400000), createdAt: now, updatedAt: now
  })));
}

const post = (body, idemKey) => {
  const r = request(app).post('/api/v2/financial/receive').set('Authorization', `Bearer ${tokenAdmin}`);
  if (idemKey !== undefined) r.set('Idempotency-Key', idemKey);
  return r.send(body);
};
const state = async (patientId) => ({
  paid: await Payment.countDocuments({ patient: patientId, status: 'paid', kind: { $ne: 'monthly_settlement' } }),
  receipts: await Payment.countDocuments({ patient: patientId, kind: 'monthly_settlement' }),
  credit: (await PatientBalance.findOne({ patient: patientId }).lean())?.totalCredited || 0,
  ops: await PaymentOperation.countDocuments({ patient: patientId, kind: 'financial_receive' })
});

test('mesma chave repetida (retentativa após timeout): aplica uma vez e devolve o mesmo recibo', { skip }, async () => {
  const p = oid(); await seedPending(p, [220, 220]);
  const k = key();
  const body = { patientId: String(p), amount: 440, method: 'pix' };
  const a = await post(body, k);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await post(body, k);
  assert.equal(b.status, 200);
  assert.equal(b.body.idempotent, true);
  assert.equal(String(b.body.receiptId), String(a.body.receiptId));
  assert.deepEqual(await state(p), { paid: 2, receipts: 1, credit: 0, ops: 1 });
});

test('recebimento que vira só crédito: mesma chave não credita duas vezes (antes creditava)', { skip }, async () => {
  const p = oid();
  const k = key();
  const body = { patientId: String(p), amount: 180, method: 'dinheiro' };
  assert.equal((await post(body, k)).status, 200);
  const again = await post(body, k);
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.credit, 180);
  assert.deepEqual(await state(p), { paid: 0, receipts: 0, credit: 180, ops: 1 });
});

test('clique duplo / 8 requisições simultâneas com a mesma chave: aplica uma vez', { skip }, async () => {
  const p = oid(); await seedPending(p, [220, 220, 220]);
  const k = key();
  const body = { patientId: String(p), amount: 700, method: 'pix' };
  const rs = await Promise.all(Array.from({ length: 8 }, () => post(body, k)));
  const codes = rs.map((r) => r.status);
  assert.ok(codes.includes(200), `nenhum 200: ${codes}`);
  for (const r of rs) {
    assert.ok(r.status === 200 || (r.status === 409 && r.body?.code === 'RECEIVE_IN_PROGRESS'), `${r.status} ${JSON.stringify(r.body)}`);
  }
  // Quem recebeu 409 repete com a mesma chave e recebe o resultado gravado.
  const retry = await post(body, k);
  assert.equal(retry.status, 200);
  assert.deepEqual(await state(p), { paid: 3, receipts: 1, credit: 40, ops: 1 });
});

test('mesma chave com valor diferente: 409 IDEMPOTENCY_KEY_CONFLICT e nada muda', { skip }, async () => {
  const p = oid(); await seedPending(p, [220]);
  const k = key();
  assert.equal((await post({ patientId: String(p), amount: 220, method: 'pix' }, k)).status, 200);
  const before = await state(p);
  const c = await post({ patientId: String(p), amount: 999, method: 'pix' }, k);
  assert.equal(c.status, 409);
  assert.equal(c.body.code ?? c.body.error?.code, 'IDEMPOTENCY_KEY_CONFLICT');
  const m = await post({ patientId: String(p), amount: 220, method: 'dinheiro' }, k);
  assert.equal(m.status, 409);
  assert.deepEqual(await state(p), before);
});

test('chaves diferentes são operações diferentes (nova operação intencional)', { skip }, async () => {
  const p = oid();
  assert.equal((await post({ patientId: String(p), amount: 100, method: 'pix' }, key())).status, 200);
  assert.equal((await post({ patientId: String(p), amount: 100, method: 'pix' }, key())).status, 200);
  assert.deepEqual(await state(p), { paid: 0, receipts: 0, credit: 200, ops: 2 });
});

test('sem chave: cada requisição é uma operação (comportamento que o front deixa de usar)', { skip }, async () => {
  const p = oid();
  assert.equal((await post({ patientId: String(p), amount: 50, method: 'pix' })).status, 200);
  assert.equal((await post({ patientId: String(p), amount: 50, method: 'pix' })).status, 200);
  assert.deepEqual(await state(p), { paid: 0, receipts: 0, credit: 100, ops: 0 });
});

test('chave inválida: 400 sem efeito', { skip }, async () => {
  const p = oid();
  const r = await post({ patientId: String(p), amount: 50, method: 'pix' }, 'curta');
  assert.equal(r.status, 400);
  assert.deepEqual(await state(p), { paid: 0, receipts: 0, credit: 0, ops: 0 });
});

test('metadata.idempotencyKey (contrato antigo) continua idempotente', { skip }, async () => {
  const p = oid();
  const body = { patientId: String(p), amount: 70, method: 'pix', metadata: { idempotencyKey: key() } };
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).body.idempotent, true);
  assert.deepEqual(await state(p), { paid: 0, receipts: 0, credit: 70, ops: 1 });
});

test('falha no meio (saldo): desfaz pagamentos, recibo e registro; retentativa com a mesma chave aplica uma vez', { skip }, async () => {
  const p = oid(); await seedPending(p, [220]);
  const k = key();
  const body = { patientId: String(p), amount: 300, method: 'pix' };
  const original = PatientBalance.findOneAndUpdate;
  PatientBalance.findOneAndUpdate = function () { throw new Error('falha simulada no saldo'); };
  try {
    const r = await post(body, k);
    assert.equal(r.status, 500);
  } finally {
    PatientBalance.findOneAndUpdate = original;
  }
  assert.deepEqual(await state(p), { paid: 0, receipts: 0, credit: 0, ops: 0 });
  assert.equal((await post(body, k)).status, 200);
  assert.equal((await post(body, k)).body.idempotent, true);
  assert.deepEqual(await state(p), { paid: 1, receipts: 1, credit: 80, ops: 1 });
});
