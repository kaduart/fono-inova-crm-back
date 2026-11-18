// Idempotência e atomicidade de multi_payment, standalone e balance_credit.
// Precisa de MongoDB DESCARTÁVEL em loopback configurado como replica set
// (transações). Dados fictícios. Cada execução cria e apaga o próprio banco.
//
//   MONGO_TXN_TEST_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true' \
//     node --test --test-force-exit tests/payments/paymentIdempotency.mongo.nodetest.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import Payment from '../../models/Payment.js';
import PatientBalance from '../../models/PatientBalance.js';
import PaymentOperation from '../../models/PaymentOperation.js';
import FinancialLedger from '../../models/FinancialLedger.js';
import { recordPaymentReceived } from '../../services/financialLedgerService.js';
import { classifyError } from '../../infrastructure/events/errorClassifier.js';
import {
  operationKeyFor, requestFingerprint, runPaymentOperation, markSideEffectsDone,
  applyStandalone, applyBalanceCredit, applyMultiPayment,
  CONFLICT_CODE, DEBITS_NOT_PAYABLE_CODE
} from '../../services/paymentOperations.js';

const URI = process.env.MONGO_TXN_TEST_URI;
const skip = !URI ? 'MONGO_TXN_TEST_URI não definido' : false;
if (URI && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(URI).hostname)) {
  throw new Error('MONGO_TXN_TEST_URI precisa ser loopback');
}

const oid = () => new mongoose.Types.ObjectId();
let n = 0;
const key = (p = 'k') => `${p}-${process.pid}-${Date.now()}-${n++}`;

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_payop_${Date.now()}` });
  // Transações não criam coleções sob carga concorrente: criar antes.
  await Promise.all([Payment, PatientBalance, PaymentOperation, FinancialLedger].map(async (M) => {
    await M.createCollection().catch(() => {});
    await M.syncIndexes();
  }));
});

after(async () => {
  if (skip) return;
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  if (skip) return;
  await Promise.all([Payment, PatientBalance, PaymentOperation, FinancialLedger].map(M => M.collection.deleteMany({})));
});

const standalonePayload = (patientId, amount = 220) => ({
  type: 'standalone', patientId: String(patientId), amount, paymentMethod: 'pix',
  notes: 'teste ficticio', requestedBy: 'system'
});

const runStandalone = (operationKey, payload, opts = {}) => runPaymentOperation({
  operationKey, kind: 'standalone', request: payload, eventId: opts.eventId || null,
  apply: (ctx) => applyStandalone(payload, ctx, {
    correlationId: 'corr-ficticio', recordLedger: opts.recordLedger || recordPaymentReceived
  })
});

const runCredit = (operationKey, payload) => runPaymentOperation({
  operationKey, kind: 'balance_credit', request: payload,
  apply: (ctx) => applyBalanceCredit(payload, ctx)
});

const runMulti = (operationKey, payload) => runPaymentOperation({
  operationKey, kind: 'multi_payment', request: payload,
  apply: (ctx) => applyMultiPayment(payload, ctx, { correlationId: 'corr-multi', recordLedger: recordPaymentReceived })
});

async function seedDebits(patientId, amounts) {
  const transactions = amounts.map(a => ({ _id: oid(), type: 'debit', amount: a, description: 'sessão fictícia', isPaid: false }));
  const total = amounts.reduce((s, a) => s + a, 0);
  await PatientBalance.create({ patient: patientId, currentBalance: total, totalDebited: total, totalCredited: 0, transactions });
  return transactions.map(t => String(t._id));
}

const multiPayload = (patientId, debitIds, totalAmount) => ({
  type: 'multi_payment', patientId: String(patientId), debitIds, totalAmount,
  payments: [{ amount: totalAmount, paymentMethod: 'pix' }], requestedBy: 'system'
});

// ---------------------------------------------------------------- identidade

test('identidade: chave estável e impressão digital só dos campos financeiros', { skip }, () => {
  assert.equal(operationKeyFor('standalone', { idempotencyKey: 'abc', eventId: 'e1' }), 'payop:standalone:abc');
  assert.equal(operationKeyFor('standalone', { eventId: 'e1' }), 'payop:standalone:e1');
  assert.throws(() => operationKeyFor('standalone', {}), /PAYMENT_OPERATION_KEY_MISSING/);
  assert.throws(() => operationKeyFor('appointment_payment', { eventId: 'x' }), /KIND_INVALID/);

  const p = standalonePayload(oid());
  const sameButNotes = { ...p, notes: 'outra nota', requestedAt: new Date().toISOString() };
  assert.equal(requestFingerprint('standalone', p), requestFingerprint('standalone', sameButNotes));
  assert.notEqual(requestFingerprint('standalone', p), requestFingerprint('standalone', { ...p, amount: 221 }));

  const m = multiPayload(oid(), ['b', 'a'], 100);
  assert.equal(requestFingerprint('multi_payment', m), requestFingerprint('multi_payment', { ...m, debitIds: ['a', 'b'] }));
});

// ---------------------------------------------------------------- standalone

test('standalone: aplica Payment, saldo e ledger juntos', { skip }, async () => {
  const patient = oid();
  const k = operationKeyFor('standalone', { eventId: key() });
  const r = await runStandalone(k, standalonePayload(patient));

  assert.equal(r.applied, true);
  assert.equal(await Payment.countDocuments({ patient }), 1);
  const bal = await PatientBalance.findOne({ patient }).lean();
  assert.equal(bal.currentBalance, -220);
  assert.equal(bal.totalCredited, 220);
  assert.equal(bal.transactions.length, 1);
  assert.equal(bal.transactions[0].operationKey, k);
  assert.equal(await FinancialLedger.countDocuments({ payment: r.paymentId, type: 'payment_received' }), 1);
  const op = await PaymentOperation.findById(k).lean();
  assert.equal(String(op.paymentId), String(r.paymentId));
  assert.equal(op.sideEffectsAt, null);
});

test('standalone: repetir a mesma operação não duplica nada', { skip }, async () => {
  const patient = oid();
  const k = operationKeyFor('standalone', { eventId: key() });
  const first = await runStandalone(k, standalonePayload(patient));
  const second = await runStandalone(k, { ...standalonePayload(patient), notes: 'reentrega' });
  const third = await runStandalone(k, standalonePayload(patient));

  assert.equal(second.applied, false);
  assert.equal(second.replayed, true);
  assert.equal(String(second.paymentId), String(first.paymentId));
  assert.equal(String(third.paymentId), String(first.paymentId));
  assert.equal(await Payment.countDocuments({ patient }), 1);
  assert.equal((await PatientBalance.findOne({ patient }).lean()).currentBalance, -220);
  assert.equal(await FinancialLedger.countDocuments({ patient }), 1);
  assert.equal((await PaymentOperation.findById(k).lean()).replays, 2);
});

test('standalone: 12 execuções concorrentes da mesma chave aplicam uma vez', { skip }, async () => {
  const patient = oid();
  const k = operationKeyFor('standalone', { eventId: key() });
  const results = await Promise.all(Array.from({ length: 12 }, () => runStandalone(k, standalonePayload(patient))));

  assert.equal(results.filter(r => r.applied).length, 1);
  assert.equal(new Set(results.map(r => String(r.paymentId))).size, 1);
  assert.equal(await Payment.countDocuments({ patient }), 1);
  const bal = await PatientBalance.findOne({ patient }).lean();
  assert.equal(bal.currentBalance, -220);
  assert.equal(bal.transactions.length, 1);
  assert.equal(await FinancialLedger.countDocuments({ patient }), 1);
});

test('standalone: mesma chave com valor diferente é conflito não retentável', { skip }, async () => {
  const patient = oid();
  const k = operationKeyFor('standalone', { eventId: key() });
  await runStandalone(k, standalonePayload(patient, 220));

  await assert.rejects(runStandalone(k, standalonePayload(patient, 180)), (err) => {
    assert.equal(err.code, CONFLICT_CODE);
    assert.equal(classifyError(err).retryable, false);
    return true;
  });
  // Conflito concorrente: nenhuma das versões divergentes é aplicada.
  const k2 = operationKeyFor('standalone', { eventId: key() });
  const settled = await Promise.allSettled([
    runStandalone(k2, standalonePayload(patient, 100)),
    runStandalone(k2, standalonePayload(patient, 150))
  ]);
  assert.equal(settled.filter(s => s.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(s => s.status === 'rejected' && s.reason.code === CONFLICT_CODE).length, 1);

  assert.equal(await Payment.countDocuments({ patient }), 2);
  const bal = await PatientBalance.findOne({ patient }).lean();
  const applied = settled.find(s => s.status === 'fulfilled').value;
  const appliedAmount = (await Payment.findById(applied.paymentId).lean()).amount;
  assert.equal(bal.currentBalance, -(220 + appliedAmount));
});

test('standalone: falha no meio (ledger) desfaz Payment, saldo e registro; retry aplica uma vez', { skip }, async () => {
  const patient = oid();
  const k = operationKeyFor('standalone', { eventId: key() });
  const boom = async () => { throw new Error('FALHA_SIMULADA_LEDGER'); };

  await assert.rejects(runStandalone(k, standalonePayload(patient), { recordLedger: boom }), /FALHA_SIMULADA_LEDGER/);
  assert.equal(await Payment.countDocuments({ patient }), 0);
  assert.equal(await PatientBalance.countDocuments({ patient }), 0);
  assert.equal(await PaymentOperation.countDocuments({ _id: k }), 0);
  assert.equal(await FinancialLedger.countDocuments({ patient }), 0);

  const ok = await runStandalone(k, standalonePayload(patient));
  assert.equal(ok.applied, true);
  assert.equal(await Payment.countDocuments({ patient }), 1);
  assert.equal((await PatientBalance.findOne({ patient }).lean()).currentBalance, -220);
});

test('reinício: commit sem efeitos posteriores fica marcado e a reentrega os refaz uma vez', { skip }, async () => {
  const patient = oid();
  const k = operationKeyFor('standalone', { eventId: key() });
  await runStandalone(k, standalonePayload(patient));
  // "Processo caiu" aqui: sem markSideEffectsDone.

  const redelivery = await runStandalone(k, standalonePayload(patient));
  assert.equal(redelivery.applied, false);
  assert.equal(redelivery.sideEffectsPending, true);
  await markSideEffectsDone(k);

  const later = await runStandalone(k, standalonePayload(patient));
  assert.equal(later.sideEffectsPending, false);
  assert.equal(await Payment.countDocuments({ patient }), 1);
});

test('standalone: duas requisições distintas (chaves diferentes) são dois pagamentos', { skip }, async () => {
  const patient = oid();
  await runStandalone(operationKeyFor('standalone', { eventId: key() }), standalonePayload(patient));
  await runStandalone(operationKeyFor('standalone', { eventId: key() }), standalonePayload(patient));
  assert.equal(await Payment.countDocuments({ patient }), 2);
  assert.equal((await PatientBalance.findOne({ patient }).lean()).currentBalance, -440);
});

test('saldo: operações diferentes concorrentes num paciente sem saldo não perdem crédito', { skip }, async () => {
  const patient = oid();
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    runStandalone(operationKeyFor('standalone', { eventId: key() }), standalonePayload(patient, 10))));
  assert.equal(results.filter(r => r.applied).length, 6);
  assert.equal(await PatientBalance.countDocuments({ patient }), 1);
  const bal = await PatientBalance.findOne({ patient }).lean();
  assert.equal(bal.currentBalance, -60);
  assert.equal(bal.transactions.length, 6);
});

// ---------------------------------------------------------------- balance_credit

test('balance_credit: crédito reduz o saldo devedor, uma vez por chave, inclusive concorrente', { skip }, async () => {
  const patient = oid();
  await PatientBalance.create({ patient, currentBalance: 500, totalDebited: 500, totalCredited: 0, transactions: [] });
  const k = operationKeyFor('balance_credit', { eventId: key() });
  const payload = { type: 'balance_credit', patientId: String(patient), amount: 180, paymentMethod: 'pix', requestedBy: 'system' };

  const results = await Promise.all(Array.from({ length: 8 }, () => runCredit(k, payload)));
  assert.equal(results.filter(r => r.applied).length, 1);
  const bal = await PatientBalance.findOne({ patient }).lean();
  assert.equal(bal.currentBalance, 320);
  assert.equal(bal.totalCredited, 180);
  assert.equal(bal.transactions.length, 1);

  await assert.rejects(runCredit(k, { ...payload, amount: 200 }), (e) => e.code === CONFLICT_CODE);
  assert.equal((await PatientBalance.findOne({ patient }).lean()).currentBalance, 320);
});

// ---------------------------------------------------------------- multi_payment

test('multi_payment: quita débitos, abate saldo e cria Payment e ledger uma vez', { skip }, async () => {
  const patient = oid();
  const debitIds = await seedDebits(patient, [220, 180]);
  const k = operationKeyFor('multi_payment', { idempotencyKey: `payment_multi_${patient}_${[...debitIds].sort().join('_')}` });
  const payload = multiPayload(patient, debitIds, 400);

  const results = await Promise.all(Array.from({ length: 6 }, () => runMulti(k, payload)));
  assert.equal(results.filter(r => r.applied).length, 1);
  assert.equal(await Payment.countDocuments({ patient }), 1);
  const bal = await PatientBalance.findOne({ patient }).lean();
  assert.equal(bal.currentBalance, 0);
  assert.equal(bal.transactions.filter(t => t.type === 'debit' && t.isPaid).length, 2);
  assert.equal(bal.transactions.filter(t => t.type === 'payment').length, 1);
  assert.equal(await FinancialLedger.countDocuments({ patient }), 1);

  await assert.rejects(runMulti(k, multiPayload(patient, debitIds, 399)), (e) => e.code === CONFLICT_CODE);
});

test('multi_payment: outra chave para débitos já pagos é recusada sem efeito', { skip }, async () => {
  const patient = oid();
  const debitIds = await seedDebits(patient, [220, 180]);
  await runMulti(operationKeyFor('multi_payment', { eventId: key() }), multiPayload(patient, debitIds, 400));

  await assert.rejects(runMulti(operationKeyFor('multi_payment', { eventId: key() }), multiPayload(patient, [debitIds[0]], 220)), (e) => {
    assert.equal(e.code, DEBITS_NOT_PAYABLE_CODE);
    assert.equal(classifyError(e).retryable, false);
    return true;
  });
  assert.equal(await Payment.countDocuments({ patient }), 1);
  assert.equal((await PatientBalance.findOne({ patient }).lean()).currentBalance, 0);
  assert.equal(await PaymentOperation.countDocuments({ patient }), 1);
});

test('multi_payment: duas chaves concorrentes para os mesmos débitos aplicam só uma', { skip }, async () => {
  const patient = oid();
  const debitIds = await seedDebits(patient, [100, 100, 100]);
  const payload = multiPayload(patient, debitIds, 300);
  const settled = await Promise.allSettled([
    runMulti(operationKeyFor('multi_payment', { eventId: key() }), payload),
    runMulti(operationKeyFor('multi_payment', { eventId: key() }), payload),
    runMulti(operationKeyFor('multi_payment', { eventId: key() }), payload)
  ]);
  assert.equal(settled.filter(s => s.status === 'fulfilled').length, 1);
  for (const s of settled.filter(x => x.status === 'rejected')) assert.equal(s.reason.code, DEBITS_NOT_PAYABLE_CODE);
  assert.equal(await Payment.countDocuments({ patient }), 1);
  assert.equal((await PatientBalance.findOne({ patient }).lean()).currentBalance, 0);
});

test('multi_payment: débito inexistente aborta tudo', { skip }, async () => {
  const patient = oid();
  const debitIds = await seedDebits(patient, [220]);
  await assert.rejects(
    runMulti(operationKeyFor('multi_payment', { eventId: key() }), multiPayload(patient, [debitIds[0], String(oid())], 440)),
    (e) => e.code === DEBITS_NOT_PAYABLE_CODE
  );
  assert.equal(await Payment.countDocuments({ patient }), 0);
  const bal = await PatientBalance.findOne({ patient }).lean();
  assert.equal(bal.currentBalance, 220);
  assert.equal(bal.transactions[0].isPaid, false);
  assert.equal(await PaymentOperation.countDocuments({ patient }), 0);
});

// ---------------------------------------------------------------- preflight (P1.4)

test('preflight: relata duplicatas legadas e sinal suspeito; --apply cria índices; reexecução é idempotente', { skip }, async () => {
  const { buildReport, ensureIndexes } = await import('../../scripts/migrations/2026-11-18-payment-operations-preflight.js');
  const db = mongoose.connection.db;
  const patient = oid();
  const t0 = new Date('2026-10-01T12:00:00Z');
  const mk = (min) => ({
    patient, patientId: String(patient), amount: 220, paymentMethod: 'pix', paymentDate: t0, status: 'paid',
    source: 'manual', appointment: null, description: 'Pagamento avulso', createdAt: new Date(t0.getTime() + min * 60000)
  });
  // Dois avulsos em 3 min (duplicata); um terceiro 2 h depois (não é).
  await Payment.collection.insertMany([mk(0), mk(3), mk(120)]);
  await PatientBalance.collection.insertOne({
    patient, currentBalance: 0, totalDebited: 0, totalCredited: 0,
    transactions: [
      { _id: oid(), type: 'credit', amount: 50, description: 'Crédito de pagamento avulso', transactionDate: t0 },
      { _id: oid(), type: 'credit', amount: 50, description: 'Crédito de pagamento avulso', transactionDate: new Date(t0.getTime() + 60000) },
      { _id: oid(), type: 'credit', amount: 90, description: 'Crédito em conta', paymentMethod: 'pix', transactionDate: t0 }
    ]
  });
  // Operação nova (com operationKey) não entra no relatório.
  await runStandalone(operationKeyFor('standalone', { eventId: key() }), standalonePayload(patient));

  const before = await Payment.countDocuments({});
  const r = await buildReport(db);
  assert.equal(r.standaloneDuplicateGroups.length, 1);
  assert.equal(r.standaloneDuplicateGroups[0].count, 2);
  assert.equal(r.balanceCreditDuplicateGroups.length, 1);
  assert.equal(r.legacyBalanceCreditSignSuspects.length, 1);
  assert.equal(await Payment.countDocuments({}), before, 'relatório não altera dados');

  const names = await ensureIndexes(db);
  assert.ok(names.includes('side_effects_pending'));
  assert.deepEqual((await ensureIndexes(db)).sort(), [...names].sort());
});
