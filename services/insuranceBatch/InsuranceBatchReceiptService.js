import mongoose from 'mongoose';
import moment from 'moment-timezone';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import Payment from '../../models/Payment.js';
import Convenio from '../../models/Convenio.js';
import { transitionPaymentStatus } from '../paymentStatusService.js';
import { recordInsuranceReceived } from '../financialLedgerService.js';

const TERMINAL_PAYMENT_STATUSES = ['canceled', 'cancelled', 'void', 'refunded'];

export class InsuranceBatchReceiptError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'InsuranceBatchReceiptError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function objectId(value, field = 'id') {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new InsuranceBatchReceiptError('INSURANCE_BATCH_INVALID_ID', `${field} inválido`, 400);
  }
  return new mongoose.Types.ObjectId(value);
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function allocateNetAmounts(grossAmounts, totalNet) {
  const grossCents = grossAmounts.map(value => Math.round(Number(value || 0) * 100));
  const totalGrossCents = grossCents.reduce((sum, value) => sum + value, 0);
  const totalNetCents = Math.round(Number(totalNet || 0) * 100);
  if (totalGrossCents <= 0 || totalNetCents < 0) {
    throw new InsuranceBatchReceiptError('INSURANCE_BATCH_INVALID_TOTAL', 'Totais do lote inválidos para baixa', 422);
  }

  let allocated = 0;
  return grossCents.map((gross, index) => {
    const cents = index === grossCents.length - 1
      ? totalNetCents - allocated
      : Math.round(totalNetCents * gross / totalGrossCents);
    allocated += cents;
    return cents / 100;
  });
}

function guideSummary(batch, paymentById = new Map()) {
  const grouped = new Map();
  for (const item of batch.sessions || []) {
    const guide = item.guide && typeof item.guide === 'object' ? item.guide : null;
    const key = String(guide?._id || item.guide || 'without-guide');
    if (!grouped.has(key)) {
      grouped.set(key, {
        guideId: guide?._id?.toString?.() || (item.guide ? String(item.guide) : null),
        number: guide?.number || 'Sem guia',
        specialty: guide?.specialty || null,
        sessions: 0,
        grossAmount: 0,
        receivedSessions: 0,
        receivedAmount: 0,
        pendingSessions: 0,
        pendingAmount: 0
      });
    }
    const row = grouped.get(key);
    const payment = paymentById.get(item.payment?.toString?.());
    const isReceived = payment?.insurance?.status === 'received' || item.status === 'paid';
    const grossAmount = Number(item.grossAmount || 0);
    const receivedAmount = Number(payment?.insurance?.receivedAmount ?? item.netAmount ?? grossAmount);
    row.sessions += 1;
    row.grossAmount = round(row.grossAmount + grossAmount);
    if (isReceived) {
      row.receivedSessions += 1;
      row.receivedAmount = round(row.receivedAmount + receivedAmount);
    } else {
      row.pendingSessions += 1;
      row.pendingAmount = round(row.pendingAmount + grossAmount);
    }
  }
  return [...grouped.values()].map(row => ({
    ...row,
    status: row.receivedSessions === row.sessions
      ? 'received'
      : row.receivedSessions > 0
        ? 'partial'
        : 'pending'
  }));
}

function toReceivable(batch, paymentById) {
  const guides = guideSummary(batch, paymentById);
  const sessionPatient = (batch.sessions || [])
    .map(item => item.session?.patient)
    .find(patient => patient && typeof patient === 'object');
  const patient = batch.patient && typeof batch.patient === 'object'
    ? batch.patient
    : sessionPatient;
  const receivedAmount = round(guides.reduce((sum, guide) => sum + guide.receivedAmount, 0));
  const totalNet = round(batch.totalNet || batch.totalGross);
  const receivedSessions = guides.reduce((sum, guide) => sum + guide.receivedSessions, 0);
  const totalSessions = guides.reduce((sum, guide) => sum + guide.sessions, 0);
  const paymentReceivedDates = (batch.sessions || [])
    .map(item => paymentById.get(item.payment?.toString?.())?.insurance?.receivedAt)
    .filter(Boolean)
    .map(value => new Date(value));
  const derivedReceivedAt = paymentReceivedDates.length
    ? new Date(Math.max(...paymentReceivedDates.map(value => value.getTime())))
    : null;
  const derivedStatus = totalSessions > 0 && receivedSessions === totalSessions
    ? 'received'
    : receivedSessions > 0
      ? 'partial'
      : batch.status;
  return {
    batchId: batch._id.toString(),
    billingSubmissionId: batch.billingSubmissionId?.toString?.() || null,
    invoiceNumber: batch.invoiceNumber,
    invoiceDate: batch.invoiceDate,
    invoiceDocumentId: batch.invoiceDocumentId?.toString?.() || null,
    patient: patient
      ? { _id: patient._id.toString(), fullName: patient.fullName }
      : null,
    insuranceProvider: batch.insuranceProvider,
    status: derivedStatus,
    origin: batch.origin,
    sessions: batch.totalSessions || batch.sessions?.length || 0,
    guides,
    totalGross: round(batch.totalGross),
    issRate: batch.issRate,
    issAmount: batch.issAmount,
    totalNet,
    receivedAmount,
    pendingAmount: round(Math.max(0, totalNet - receivedAmount)),
    receivedAt: batch.receivedAt || derivedReceivedAt,
    createdAt: batch.createdAt
  };
}

export async function listInvoiceReceivables({ status = 'pending', patientId, insuranceProvider } = {}) {
  const query = {
    invoiceNumber: { $exists: true, $nin: [null, ''] },
    status: { $in: ['sent', 'processing', 'partial', 'received'] }
  };
  if (patientId) query.patient = objectId(patientId, 'patientId');
  if (insuranceProvider) query.insuranceProvider = String(insuranceProvider).trim().toLowerCase();

  const batches = await InsuranceBatch.find(query)
    .populate('patient', 'fullName')
    .populate({ path: 'sessions.session', select: 'patient', populate: { path: 'patient', select: 'fullName' } })
    .populate('sessions.guide', 'number specialty billingMode')
    .sort({ invoiceDate: 1, createdAt: 1 })
    .lean();
  const paymentIds = [...new Set(batches.flatMap(batch => (
    batch.sessions || []
  ).map(item => item.payment?.toString?.()).filter(Boolean)))];
  const payments = paymentIds.length
    ? await Payment.find({ _id: { $in: paymentIds.map(id => objectId(id, 'paymentId')) } })
      .select('insurance.status insurance.receivedAmount insurance.receivedAt')
      .lean()
    : [];
  const paymentById = new Map(payments.map(payment => [payment._id.toString(), payment]));
  const receivables = batches.map(batch => toReceivable(batch, paymentById));
  if (status === 'pending') return receivables.filter(row => row.status !== 'received' && row.pendingAmount > 0);
  if (status === 'received') return receivables.filter(row => row.status === 'received');
  return receivables;
}

export async function receiveInsuranceBatch(batchId, { receivedDate, userId, guideIds = [] } = {}) {
  if (!receivedDate || !/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) {
    throw new InsuranceBatchReceiptError('INSURANCE_BATCH_RECEIVED_DATE_REQUIRED', 'Data do recebimento obrigatória no formato YYYY-MM-DD');
  }
  const receivedAt = moment.tz(receivedDate, 'YYYY-MM-DD', true, 'America/Sao_Paulo');
  if (!receivedAt.isValid()) {
    throw new InsuranceBatchReceiptError('INSURANCE_BATCH_RECEIVED_DATE_INVALID', 'Data do recebimento inválida');
  }

  const mongoSession = await mongoose.startSession();
  let result;
  try {
    await mongoSession.withTransaction(async () => {
      const batch = await InsuranceBatch.findById(objectId(batchId, 'batchId')).session(mongoSession);
      if (!batch) throw new InsuranceBatchReceiptError('INSURANCE_BATCH_NOT_FOUND', 'NF/lote não encontrado', 404);
      if (batch.status === 'received') {
        result = { idempotent: true, batchId: batch._id.toString(), status: batch.status };
        return;
      }
      if (!['sent', 'processing', 'partial'].includes(batch.status)) {
        throw new InsuranceBatchReceiptError('INSURANCE_BATCH_NOT_RECEIVABLE', 'NF/lote não está aguardando recebimento', 409, { status: batch.status });
      }
      if (!batch.invoiceNumber) {
        throw new InsuranceBatchReceiptError('INSURANCE_BATCH_INVOICE_REQUIRED', 'A baixa exige uma NF vinculada ao lote', 409);
      }

      const paymentIds = [...new Set(batch.sessions.map(item => item.payment?.toString()).filter(Boolean))];
      if (paymentIds.length !== batch.sessions.length) {
        throw new InsuranceBatchReceiptError('INSURANCE_BATCH_PAYMENT_INTEGRITY_CONFLICT', 'Cada sessão da NF precisa possuir um Payment vinculado', 409);
      }
      const payments = await Payment.find({
        _id: { $in: paymentIds.map(id => objectId(id, 'paymentId')) },
        billingType: 'convenio',
        status: { $nin: TERMINAL_PAYMENT_STATUSES }
      }).session(mongoSession);
      if (payments.length !== paymentIds.length) {
        throw new InsuranceBatchReceiptError('INSURANCE_BATCH_PAYMENT_INTEGRITY_CONFLICT', 'Um ou mais Payments da NF estão ausentes ou inativos', 409);
      }
      const paymentById = new Map(payments.map(payment => [payment._id.toString(), payment]));
      const requestedGuideIds = [...new Set((guideIds || []).map(String))];
      const availableGuideIds = new Set(batch.sessions.map(item => item.guide?.toString()).filter(Boolean));
      const unknownGuideIds = requestedGuideIds.filter(id => !mongoose.Types.ObjectId.isValid(id) || !availableGuideIds.has(id));
      if (unknownGuideIds.length) {
        throw new InsuranceBatchReceiptError('INSURANCE_BATCH_GUIDE_NOT_FOUND', 'Uma ou mais guias não pertencem à NF informada', 409, { guideIds: unknownGuideIds });
      }
      const targetItems = requestedGuideIds.length
        ? batch.sessions.filter(item => requestedGuideIds.includes(item.guide?.toString()))
        : batch.sessions;
      const pendingTargetItems = targetItems.filter(item => paymentById.get(item.payment?.toString())?.insurance?.status !== 'received');
      if (!pendingTargetItems.length) {
        result = {
          idempotent: true,
          batchId: batch._id.toString(),
          invoiceNumber: batch.invoiceNumber,
          status: batch.status,
          paymentsReceived: 0
        };
        return;
      }
      const targetPayments = pendingTargetItems.map(item => paymentById.get(item.payment.toString()));
      const invalid = targetPayments.filter(payment => payment.insurance?.status !== 'billed');
      if (invalid.length) {
        throw new InsuranceBatchReceiptError('INSURANCE_BATCH_PAYMENT_NOT_BILLED', 'Todos os Payments selecionados precisam estar faturados antes da baixa', 409, { payments: invalid.map(payment => payment._id.toString()) });
      }

      let issRate = batch.issRate;
      if (issRate == null) {
        const convenio = await Convenio.findOne({ code: batch.insuranceProvider }).select('issRate').session(mongoSession).lean();
        issRate = Number(convenio?.issRate || 0);
      }
      const totalGross = round(batch.totalGross || batch.sessions.reduce((sum, item) => sum + Number(item.grossAmount || 0), 0));
      const issAmount = batch.issAmount == null ? round(totalGross * Number(issRate || 0) / 100) : round(batch.issAmount);
      const totalNet = batch.totalNet > 0 && (batch.issAmount != null || batch.issRate != null)
        ? round(batch.totalNet)
        : round(totalGross - issAmount);
      const grossByPayment = new Map(batch.sessions.map(item => [item.payment.toString(), Number(item.grossAmount || 0)]));
      const netAmounts = allocateNetAmounts(paymentIds.map(id => grossByPayment.get(id)), totalNet);
      const netByPayment = new Map(paymentIds.map((id, index) => [id, netAmounts[index]]));

      for (const payment of targetPayments) {
        const grossAmount = round(grossByPayment.get(payment._id.toString()));
        const netAmount = netByPayment.get(payment._id.toString());
        const transition = await transitionPaymentStatus(payment._id, 'paid', {
          session: mongoSession,
          userId,
          paidAt: receivedAt.toDate(),
          financialDate: receivedAt.toDate(),
          paymentMethod: 'convenio',
          reason: 'insurance_batch_invoice_received'
        });
        transition.payment.insurance.status = 'received';
        transition.payment.insurance.grossAmount = grossAmount;
        transition.payment.insurance.issRate = Number(issRate || 0);
        transition.payment.insurance.issAmount = round(grossAmount - netAmount);
        transition.payment.insurance.receivedAmount = netAmount;
        transition.payment.insurance.receivedAt = receivedAt.toDate();
        await transition.payment.save({ session: mongoSession });
        await recordInsuranceReceived(transition.payment, {
          userId,
          receivedAt: receivedAt.toDate(),
          receivedAmount: netAmount,
          correlationId: `insurance_batch_received_${batch._id}_${payment._id}`
        }, mongoSession);
      }

      const now = new Date();
      const receivedPaymentIds = new Set([
        ...payments.filter(payment => payment.insurance?.status === 'received').map(payment => payment._id.toString()),
        ...targetPayments.map(payment => payment._id.toString())
      ]);
      for (const item of pendingTargetItems) {
        item.status = 'paid';
        item.netAmount = netByPayment.get(item.payment.toString());
        item.returnAmount = item.netAmount;
        item.glosaAmount = 0;
        item.processedAt = now;
      }
      const allReceived = paymentIds.every(id => receivedPaymentIds.has(id));
      batch.status = allReceived ? 'received' : 'partial';
      batch.receivedAmount = round(paymentIds.reduce((sum, id) => (
        receivedPaymentIds.has(id) ? sum + Number(netByPayment.get(id) || 0) : sum
      ), 0));
      batch.receivedAt = allReceived ? receivedAt.toDate() : null;
      batch.receivedBy = allReceived ? objectId(userId, 'userId') : null;
      batch.processedAt = now;
      batch.processedBy = objectId(userId, 'userId');
      batch.issRate = Number(issRate || 0);
      batch.issAmount = issAmount;
      batch.totalNet = totalNet;
      await batch.save({ session: mongoSession });

      result = {
        idempotent: false,
        batchId: batch._id.toString(),
        invoiceNumber: batch.invoiceNumber,
        status: batch.status,
        paymentsReceived: targetPayments.length,
        guidesReceived: requestedGuideIds,
        totalGross,
        issRate: batch.issRate,
        issAmount,
        totalNet,
        receivedAmount: batch.receivedAmount,
        receivedAt: batch.receivedAt
      };
    });
    return result;
  } finally {
    await mongoSession.endSession();
  }
}

export const __testables = { guideSummary, toReceivable };

export default { listInvoiceReceivables, receiveInsuranceBatch };
