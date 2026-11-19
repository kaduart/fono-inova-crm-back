// Rotas financeiras paralelas ao fluxo protegido por payment_operations:
//   POST  /api/v2/payments/create-sync        (marcar sessão avulsa como paga)
//   POST  /api/v2/payments/bulk-settle        (quitar sessões em lote)
//   PATCH /api/v2/payments/:id                (editar / marcar como pago)
//   POST  /api/v2/balance/:patientId/credit   (crédito direto no saldo, via balanceWorker)
// e o B-1 (sinal do crédito no saldo).
//
// Pela camada HTTP real (express + auth + transação). Mongo DESCARTÁVEL em
// replica set e Redis de loopback. Dados fictícios.
//
//   MONGO_TXN_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' REDIS_URL=redis://127.0.0.1:6479 \
//     node --test --test-force-exit --test-concurrency=1 tests/payments/rotasParalelas.http.mongo.nodetest.mjs
import { test, before, after, beforeEach, describe } from 'node:test';
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
let app, Admin, Payment, PatientBalance, PaymentOperation, Appointment, Session, FinancialLedger, EventStore, tokenAdmin;
let handleCredit;
let n = 0;
const key = () => `chave-ficticia-${process.pid}-${Date.now()}-${n++}`;

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_rotas_paralelas_${Date.now()}` });
  ({ default: Admin } = await import('../../models/Admin.js'));
  ({ default: Payment } = await import('../../models/Payment.js'));
  ({ default: PatientBalance } = await import('../../models/PatientBalance.js'));
  ({ default: PaymentOperation } = await import('../../models/PaymentOperation.js'));
  ({ default: Appointment } = await import('../../models/Appointment.js'));
  ({ default: Session } = await import('../../models/Session.js'));
  ({ default: FinancialLedger } = await import('../../models/FinancialLedger.js'));
  ({ default: EventStore } = await import('../../models/EventStore.js'));
  const { default: Outbox } = await import('../../infrastructure/outbox/OutboxModel.js');
  const { default: Package } = await import('../../models/Package.js');
  const { default: paymentRouter } = await import('../../routes/payment.v2.js');
  const { default: balanceRouter } = await import('../../routes/balance.v2.js');
  ({ handleCredit } = await import('../../workers/balanceWorker.js'));
  for (const M of [Payment, PatientBalance, PaymentOperation, Appointment, Session, Outbox, FinancialLedger, EventStore, Package]) {
    await M.createCollection().catch(() => {});
    await M.init();
  }
  app = express();
  app.use(express.json());
  app.use('/api/v2/payments', paymentRouter);
  app.use('/api/v2/balance', balanceRouter);
  const adminId = oid();
  await Admin.collection.insertOne({ _id: adminId, name: 'Admin Ficticio', email: 'admin@teste.invalid', role: 'admin' });
  tokenAdmin = jwt.sign({ id: adminId.toString(), role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30m' });
});

after(async () => {
  if (skip) return;
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  if (skip) return;
  await Promise.all([Payment, PatientBalance, PaymentOperation, Appointment, Session, FinancialLedger, EventStore]
    .map((M) => M.collection.deleteMany({})));
});

const auth = (r, idemKey) => {
  r.set('Authorization', `Bearer ${tokenAdmin}`);
  if (idemKey !== undefined) r.set('Idempotency-Key', idemKey);
  return r;
};
const createSync = (body, k) => auth(request(app).post('/api/v2/payments/create-sync'), k).send(body);
const bulkSettle = (body, k) => auth(request(app).post('/api/v2/payments/bulk-settle'), k).send(body);
const patchPayment = (id, body, k) => auth(request(app).patch(`/api/v2/payments/${id}`), k).send(body);
const credit = (patientId, body, k) => auth(request(app).post(`/api/v2/balance/${patientId}/credit`), k).send(body);
const errCode = (r) => r.body?.code ?? r.body?.error?.code;

async function seedAppointment(patientId, amount = 220) {
  const _id = oid();
  const now = new Date();
  await Appointment.collection.insertOne({
    _id, patient: patientId, doctor: oid(), date: now, time: '10:00', status: 'completed', operationalStatus: 'completed',
    billingType: 'particular', sessionValue: amount, paymentStatus: 'pending', createdAt: now, updatedAt: now
  });
  return _id;
}

async function seedPending(patientId, amounts, extra = {}) {
  const now = new Date();
  const docs = amounts.map((a, i) => ({
    _id: oid(), patient: patientId, patientId: String(patientId), doctor: oid(), amount: a, status: 'pending',
    kind: 'session_payment', billingType: 'particular', paymentMethod: 'dinheiro', clinicId: 'default',
    serviceDate: new Date(now.getTime() - (amounts.length - i) * 86400000), paymentDate: now, createdAt: now, updatedAt: now, ...extra
  }));
  await Payment.collection.insertMany(docs);
  return docs.map((d) => d._id);
}

const ledgerCredits = (paymentId) => FinancialLedger.countDocuments({ payment: paymentId, type: 'payment_received' });

// ─────────────────────────────── create-sync ───────────────────────────────
describe('POST /v2/payments/create-sync', () => {
  const body = (patientId, appointmentId, amount = 220) => ({
    patientId: String(patientId), doctorId: String(oid()), amount, paymentMethod: 'pix', status: 'paid',
    appointmentId: String(appointmentId), serviceType: 'session', paymentDate: new Date().toISOString()
  });

  test('mesma Idempotency-Key repetida: 1 Payment, 1 crédito no caixa; a repetição devolve o mesmo Payment', { skip }, async () => {
    const p = oid(); const a = await seedAppointment(p);
    const k = key();
    const r1 = await createSync(body(p, a), k);
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    const r2 = await createSync(body(p, a), k);
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.idempotent, true);
    assert.equal(String(r2.body.data._id), String(r1.body.data._id));
    assert.equal(await Payment.countDocuments({ patient: p }), 1);
    assert.equal(await ledgerCredits(r1.body.data._id), 1);
  });

  test('clique duplo SEM chave no mesmo agendamento: o 2º não cria outro Payment (agendamento já pago)', { skip }, async () => {
    const p = oid(); const a = await seedAppointment(p);
    const r1 = await createSync(body(p, a));
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    const r2 = await createSync(body(p, a));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.idempotent, true);
    assert.equal(String(r2.body.data._id), String(r1.body.data._id));
    assert.equal(await Payment.countDocuments({ patient: p }), 1);
  });

  test('8 requisições simultâneas (com e sem chave) no mesmo agendamento: 1 Payment e 1 crédito', { skip }, async () => {
    for (const withKey of [true, false]) {
      const p = oid(); const a = await seedAppointment(p);
      const k = withKey ? key() : undefined;
      const rs = await Promise.all(Array.from({ length: 8 }, () => createSync(body(p, a), k)));
      for (const r of rs) {
        assert.ok([200, 201].includes(r.status) || (r.status === 409 && errCode(r) === 'PAYMENT_IN_PROGRESS'),
          `${withKey ? 'com' : 'sem'} chave: ${r.status} ${JSON.stringify(r.body)}`);
      }
      assert.equal(await Payment.countDocuments({ patient: p }), 1, `${withKey ? 'com' : 'sem'} chave`);
      const pay = await Payment.findOne({ patient: p }).lean();
      assert.equal(await ledgerCredits(pay._id), 1);
      const appt = await Appointment.findById(a).lean();
      assert.equal(String(appt.payment), String(pay._id));
    }
  });

  test('mesma chave com outro valor: 409 IDEMPOTENCY_KEY_CONFLICT e nada muda', { skip }, async () => {
    const p = oid(); const a = await seedAppointment(p);
    const k = key();
    assert.equal((await createSync(body(p, a, 220), k)).status, 201);
    const c = await createSync(body(p, a, 999), k);
    assert.equal(c.status, 409);
    assert.equal(errCode(c), 'IDEMPOTENCY_KEY_CONFLICT');
    assert.equal(await Payment.countDocuments({ patient: p }), 1);
  });

  test('operações legítimas diferentes continuam funcionando: dois agendamentos, dois Payments', { skip }, async () => {
    const p = oid(); const a1 = await seedAppointment(p); const a2 = await seedAppointment(p);
    assert.equal((await createSync(body(p, a1), key())).status, 201);
    assert.equal((await createSync(body(p, a2), key())).status, 201);
    assert.equal(await Payment.countDocuments({ patient: p }), 2);
  });

  test('sem agendamento e sem chave: cada requisição é um lançamento (comportamento documentado)', { skip }, async () => {
    const p = oid();
    const b = { patientId: String(p), amount: 50, paymentMethod: 'pix', status: 'paid' };
    assert.equal((await createSync(b)).status, 201);
    assert.equal((await createSync(b)).status, 201);
    assert.equal(await Payment.countDocuments({ patient: p }), 2);
  });
});

// ─────────────────────────────── bulk-settle ───────────────────────────────
describe('POST /v2/payments/bulk-settle', () => {
  test('mesmo conjunto repetido: 1 recibo; a repetição devolve o mesmo recibo (não é erro)', { skip }, async () => {
    const p = oid(); const ids = await seedPending(p, [220, 220]);
    const b = { paymentIds: ids.map(String), paymentMethod: 'pix', totalAmount: 440 };
    const r1 = await bulkSettle(b);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const r2 = await bulkSettle(b);
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.idempotent, true);
    assert.equal(String(r2.body.data.receiptId), String(r1.body.data.receiptId));
    assert.equal(await Payment.countDocuments({ patient: p, kind: 'monthly_settlement' }), 1);
    assert.equal(await Payment.countDocuments({ patient: p, status: 'paid', kind: { $ne: 'monthly_settlement' } }), 2);
  });

  test('8 requisições simultâneas do mesmo conjunto: 1 recibo, cada sessão paga uma vez', { skip }, async () => {
    const p = oid(); const ids = await seedPending(p, [220, 180, 200]);
    const b = { paymentIds: ids.map(String), paymentMethod: 'dinheiro' };
    const rs = await Promise.all(Array.from({ length: 8 }, () => bulkSettle(b)));
    for (const r of rs) {
      assert.ok(r.status === 200 || (r.status === 409 && errCode(r) === 'PAYMENT_IN_PROGRESS'), `${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.ok(rs.some((r) => r.status === 200 && !r.body.idempotent));
    assert.equal(await Payment.countDocuments({ patient: p, kind: 'monthly_settlement' }), 1);
    for (const id of ids) assert.ok((await ledgerCredits(id)) <= 1, `crédito duplicado para ${id}`);
  });

  test('conjuntos diferentes do mesmo paciente: dois fechamentos legítimos', { skip }, async () => {
    const p = oid(); const ids = await seedPending(p, [220, 220, 220, 220]);
    assert.equal((await bulkSettle({ paymentIds: ids.slice(0, 2).map(String), paymentMethod: 'pix' })).status, 200);
    assert.equal((await bulkSettle({ paymentIds: ids.slice(2).map(String), paymentMethod: 'pix' })).status, 200);
    assert.equal(await Payment.countDocuments({ patient: p, kind: 'monthly_settlement' }), 2);
  });

  test('conjunto que inclui sessão já quitada em outro fechamento: recusa, sem pagar de novo', { skip }, async () => {
    const p = oid(); const ids = await seedPending(p, [220, 220, 220]);
    assert.equal((await bulkSettle({ paymentIds: ids.slice(0, 2).map(String), paymentMethod: 'pix' })).status, 200);
    const r = await bulkSettle({ paymentIds: ids.slice(1).map(String), paymentMethod: 'pix' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(await Payment.countDocuments({ patient: p, kind: 'monthly_settlement' }), 1);
    assert.equal((await Payment.findById(ids[2]).lean()).status, 'pending');
  });
});

// ─────────────────────────────── PATCH /:id ───────────────────────────────
describe('PATCH /v2/payments/:id (marcar como pago)', () => {
  async function seedWithOrphanDebit(p, amount = 220) {
    const appointmentId = oid();
    const [id] = await seedPending(p, [amount], { appointment: appointmentId, appointmentId: String(appointmentId) });
    await PatientBalance.collection.insertOne({
      patient: p, currentBalance: amount, totalDebited: amount, totalCredited: 0,
      transactions: [{ _id: oid(), type: 'debit', amount, description: 'Sessão fictícia', appointmentId, isPaid: false, transactionDate: new Date() }],
      createdAt: new Date(), updatedAt: new Date()
    });
    return id;
  }

  test('8 PATCH simultâneos pending→paid: pago uma vez, saldo abatido uma vez', { skip }, async () => {
    const p = oid(); const id = await seedWithOrphanDebit(p);
    const rs = await Promise.all(Array.from({ length: 8 }, () => patchPayment(id, { status: 'paid', paymentMethod: 'pix' })));
    for (const r of rs) {
      assert.ok(r.status === 200 || (r.status === 409 && errCode(r) === 'PAYMENT_IN_PROGRESS'), `${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal((await Payment.findById(id).lean()).status, 'paid');
    const bal = await PatientBalance.findOne({ patient: p }).lean();
    assert.equal(bal.currentBalance, 0, JSON.stringify(bal));
    assert.ok((await ledgerCredits(id)) <= 1);
  });

  test('repetir o mesmo PATCH depois de aplicado não muda nada', { skip }, async () => {
    const p = oid(); const id = await seedWithOrphanDebit(p);
    assert.equal((await patchPayment(id, { status: 'paid', paymentMethod: 'pix' })).status, 200);
    const before1 = await PatientBalance.findOne({ patient: p }).lean();
    assert.equal((await patchPayment(id, { status: 'paid', paymentMethod: 'pix' })).status, 200);
    const after1 = await PatientBalance.findOne({ patient: p }).lean();
    assert.equal(after1.currentBalance, before1.currentBalance);
    assert.equal(after1.totalCredited, before1.totalCredited);
  });

  test('operação legítima diferente: estornar (paid→pending) e pagar de novo funciona', { skip }, async () => {
    const p = oid(); const [id] = await seedPending(p, [220]);
    assert.equal((await patchPayment(id, { status: 'paid', paymentMethod: 'pix' })).status, 200);
    assert.equal((await patchPayment(id, { status: 'pending' })).status, 200);
    assert.equal((await Payment.findById(id).lean()).status, 'pending');
    assert.equal((await patchPayment(id, { status: 'paid', paymentMethod: 'pix' })).status, 200);
    assert.equal((await Payment.findById(id).lean()).status, 'paid');
  });
});

// ─────────────────────── POST /v2/balance/:id/credit ───────────────────────
describe('POST /v2/balance/:patientId/credit + balanceWorker', () => {
  const eventsFor = (p) => EventStore.find({ eventType: 'BALANCE_CREDIT_REQUESTED', aggregateId: String(p) }).lean();
  const deliver = async (ev) => handleCredit({ ...ev.payload, idempotencyKey: ev.payload.idempotencyKey ?? ev.idempotencyKey }, ev.eventId);

  test('mesma Idempotency-Key repetida: 1 evento; a repetição devolve o mesmo eventId', { skip }, async () => {
    const p = oid(); const k = key();
    const r1 = await credit(p, { amount: 100, description: 'Crédito fictício' }, k);
    assert.equal(r1.status, 202, JSON.stringify(r1.body));
    const r2 = await credit(p, { amount: 100, description: 'Crédito fictício' }, k);
    assert.ok([200, 202].includes(r2.status), JSON.stringify(r2.body));
    assert.equal(r2.body.data.eventId, r1.body.data.eventId);
    assert.equal((await eventsFor(p)).length, 1);
  });

  test('mesma chave com outro valor: 409 IDEMPOTENCY_KEY_CONFLICT', { skip }, async () => {
    const p = oid(); const k = key();
    assert.equal((await credit(p, { amount: 100, description: 'x' }, k)).status, 202);
    const c = await credit(p, { amount: 150, description: 'x' }, k);
    assert.equal(c.status, 409);
    assert.equal(errCode(c), 'IDEMPOTENCY_KEY_CONFLICT');
  });

  test('reentrega do mesmo evento ao worker (retry, reinício, 2 workers juntos): credita uma vez', { skip }, async () => {
    const p = oid();
    const r = await credit(p, { amount: 100, description: 'Crédito fictício' }, key());
    assert.equal(r.status, 202);
    const [ev] = await eventsFor(p);
    // o Map em memória do worker some num reinício: chamamos o handler direto, várias vezes e em paralelo
    await Promise.all([deliver(ev), deliver(ev), deliver(ev)]);
    await deliver(ev);
    const bal = await PatientBalance.findOne({ patient: p }).lean();
    assert.equal(bal.totalCredited, 100, JSON.stringify(bal));
    assert.equal(bal.transactions.filter((t) => t.type === 'credit').length, 1);
  });

  test('sem chave, clique duplo imediato: o 2º é recusado com 409 (antes: 202 "enfileirado" sem enfileirar)', { skip }, async () => {
    const p = oid();
    const r1 = await credit(p, { amount: 80, description: 'a' });
    assert.equal(r1.status, 202, JSON.stringify(r1.body));
    const r2 = await credit(p, { amount: 80, description: 'a' });
    assert.equal(r2.status, 409, JSON.stringify(r2.body));
    assert.equal(errCode(r2), 'PAYMENT_DEBOUNCED');
    assert.equal((await eventsFor(p)).length, 1);
  });

  test('sem chave, segundo crédito legítimo depois do primeiro processado: é aplicado (antes: descartado como "duplicado")', { skip }, async () => {
    const p = oid();
    assert.equal((await credit(p, { amount: 60, description: 'a' })).status, 202);
    const [ev1] = await eventsFor(p);
    await deliver(ev1);
    await EventStore.updateOne({ _id: ev1._id }, { $set: { status: 'processed' } });
    await new Promise((r) => setTimeout(r, 5200)); // passa a janela de debounce (5 s)
    const r2 = await credit(p, { amount: 60, description: 'b' });
    assert.equal(r2.status, 202, JSON.stringify(r2.body));
    assert.notEqual(r2.body.data.eventId, 'duplicate');
    const evs = await eventsFor(p);
    assert.equal(evs.length, 2);
    await deliver(evs.find((e) => e.eventId !== ev1.eventId));
    assert.equal((await PatientBalance.findOne({ patient: p }).lean()).totalCredited, 120);
  });

  test('dois créditos legítimos (chaves diferentes) somam os dois', { skip }, async () => {
    const p = oid();
    await credit(p, { amount: 100, description: 'a' }, key());
    await credit(p, { amount: 50, description: 'b' }, key());
    for (const ev of await eventsFor(p)) await deliver(ev);
    const bal = await PatientBalance.findOne({ patient: p }).lean();
    assert.equal(bal.totalCredited, 150);
  });
});

// ─────────────────────────────── B-1 ───────────────────────────────
describe('B-1: crédito reduz a dívida (currentBalance > 0 = paciente deve)', () => {
  test('dívida de 220 + crédito direto de 220 = saldo 0 (balanceWorker)', { skip }, async () => {
    const p = oid();
    await PatientBalance.collection.insertOne({ patient: p, currentBalance: 220, totalDebited: 220, totalCredited: 0, transactions: [], createdAt: new Date(), updatedAt: new Date() });
    await credit(p, { amount: 220, description: 'Crédito fictício' }, key());
    const [ev] = await EventStore.find({ aggregateId: String(p) }).lean();
    await handleCredit({ ...ev.payload, idempotencyKey: ev.payload.idempotencyKey ?? ev.idempotencyKey }, ev.eventId);
    const bal = await PatientBalance.findOne({ patient: p }).lean();
    assert.equal(bal.currentBalance, 0);
    assert.equal(bal.totalCredited, 220);
  });

  test('PatientBalance.addCredit (método do modelo) segue a mesma convenção', { skip }, async () => {
    const p = oid();
    const b = await PatientBalance.create({ patient: p, currentBalance: 300, totalDebited: 300 });
    await b.addCredit(100, 'Crédito fictício');
    const bal = await PatientBalance.findOne({ patient: p }).lean();
    assert.equal(bal.currentBalance, 200);
  });
});
