import 'dotenv/config';
import mongoose from 'mongoose';
import { mkdirSync, writeFileSync } from 'node:fs';
import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import PatientBalance from '../../models/PatientBalance.js';
import { transitionPaymentStatus } from '../../services/paymentStatusService.js';
import { applyFinancialProtection } from '../../services/appointment/policies/appointmentFinancialPolicy.js';
import { getPatientPendingSnapshot } from '../../services/patientPendingSnapshot.js';

const patientId = '685b0cfaaec14c7163585b5b';
const paymentId = '6ac6a2bdcd89d9f9dab97439';
const receiptId = '6abc0fa2a1baeea0c7ca147d';
const overlappingPaymentId = '6a8c91733f3e96ae214a136c';
const priorReceiptId = '6a91db24840b39a658af1ba7';
const reason = 'Inclusão autorizada: TO de 11/09/2026 paga no recebimento de 29/09/2026. Vínculos anteriores preservados; valor documental do recibo preservado';
const execute = process.argv.includes('--execute');
mongoose.set('autoIndex', false);
await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
const tx = await mongoose.startSession();
try {
  await tx.withTransaction(async () => {
    const payment = await Payment.findById(paymentId).session(tx).lean();
    const receipt = await Payment.findById(receiptId).session(tx).lean();
    const previous = await Payment.findById(priorReceiptId).session(tx).lean();
    const appointment = await Appointment.findById(payment.appointment).session(tx).lean();
    const session = await Session.findById(payment.session).session(tx).lean();
    const balance = await PatientBalance.findOne({ patient: patientId }).session(tx).lean();
    if (String(payment.patient) !== patientId || String(receipt.patient) !== patientId
      || payment.amount !== 160 || payment.billingType !== 'particular'
      || String(payment.appointment) !== '6ac6a2bccd89d9f9dab97430'
      || appointment.operationalStatus !== 'completed'
      || receipt.amount !== 1830 || receipt.status !== 'paid'
      || receipt.paidAt.toISOString() !== '2026-09-29T19:21:05.145Z') throw new Error('Unexpected source data');
    const ids = receipt.settledPaymentIds.map(String);
    if (payment.status === 'paid' && ids.includes(paymentId)) {
      console.log('Already linked; no changes'); return;
    }
    if (payment.status !== 'pending' || !ids.includes(overlappingPaymentId)
      || !previous.settledPaymentIds.map(String).includes(overlappingPaymentId)) throw new Error('Receipt membership conflict');
    const children = await Payment.find({ _id: { $in: receipt.settledPaymentIds } }).session(tx).lean();
    const retained = children.filter(p => String(p._id) !== overlappingPaymentId);
    if (retained.length !== 11 || retained.reduce((s, p) => s + p.amount, 0) !== 1670) throw new Error('Expected 11 sessions totaling 1670');
    const debit = balance.transactions.filter(t => t.type === 'debit' && !t.isDeleted && !t.isPaid && String(t.appointmentId) === String(payment.appointment));
    if (debit.length !== 1 || debit[0].amount !== 160 || debit[0].paidAmount !== 0) throw new Error('Debit reconciliation conflict');
    console.log(JSON.stringify({ execute, receiptId, before: 1670, addedSession: 160, after: 1830, retainedSessions: 11, creditUsed: 120 }));
    if (!execute) return;
    mkdirSync('scripts/maintenance/artifacts', { recursive: true });
    writeFileSync('scripts/maintenance/artifacts/isis-link-2026-09-29-before.json', JSON.stringify({ payment, receipt, appointment, session, balance }, null, 2), { flag: 'wx' });
    await transitionPaymentStatus(paymentId, 'paid', {
      session: tx, paidAt: receipt.paidAt, financialDate: receipt.paidAt,
      paymentMethod: receipt.paymentMethod, userId: '6806dd1bb6f92559b49a8a9c', reason,
      reconcilePatientBalance: true,
    });
    await Payment.updateOne({ _id: paymentId }, { $set: { parentPaymentId: receipt._id, notes: reason } }, { session: tx });
    const payload = applyFinancialProtection(appointment, {
      isPaid: true, paymentStatus: 'paid', paymentMethod: 'cartao_credito',
      paymentForms: [{ amount: 160, date: receipt.paidAt, method: 'cartao_credito' }],
    });
    const financialOptions = { session: tx, __fromFinancialGuard: true, __guardContext: 'FINANCIAL' };
    await Appointment.updateOne({ _id: appointment._id }, { $set: payload }, financialOptions);
    await Session.updateOne({ _id: session._id }, { $set: { isPaid: true, paymentStatus: 'paid', paidAt: receipt.paidAt, paymentMethod: receipt.paymentMethod } }, financialOptions);
    await Payment.updateOne({ _id: receipt._id }, { $set: {
      notes: `${receipt.notes}\n${reason}`,
    }, $addToSet: { settledPaymentIds: payment._id } }, { session: tx });
  });
  if (execute) {
    const snapshot = await getPatientPendingSnapshot(patientId);
    const fields = Object.fromEntries(Object.entries(snapshot.stats).map(([k, v]) => [`stats.${k}`, v]));
    await mongoose.connection.db.collection('patients_view').updateOne({ _id: new mongoose.Types.ObjectId(patientId) }, { $set: fields });
    console.log(JSON.stringify({ verified: true, pendingCount: snapshot.payments.length, stats: snapshot.stats }));
  }
} finally { await tx.endSession(); await mongoose.disconnect(); }
