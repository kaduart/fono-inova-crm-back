import mongoose from 'mongoose';
import BillingSubmission, { BillingSubmissionStatus } from '../../models/BillingSubmission.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import InsuranceCommunication from '../../models/InsuranceCommunication.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import PatientDocument from '../../models/PatientDocument.js';
import Convenio from '../../models/Convenio.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import { transitionPaymentStatus } from '../paymentStatusService.js';
import { recordInsuranceBilled } from '../financialLedgerService.js';
import { saveToOutbox } from '../../infrastructure/outbox/outboxPattern.js';
import { EventTypes } from '../../infrastructure/events/eventPublisher.js';

const ACTIVE_PAYMENT_STATUSES = ['pending', 'pending_billing', 'billed', 'received', 'paid', 'partial'];

export class BillingSubmissionError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'BillingSubmissionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function objectId(value, field) {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new BillingSubmissionError('BILLING_SUBMISSION_INVALID_ID', `${field} inválido`);
  }
  return new mongoose.Types.ObjectId(value);
}

function uniqueIds(values = []) {
  const normalized = values.map(value => objectId(value, 'sessionId').toString());
  if (normalized.length !== new Set(normalized).size) {
    throw new BillingSubmissionError(
      'BILLING_SUBMISSION_DUPLICATE_SESSION',
      'Uma sessão não pode ser informada mais de uma vez',
      409
    );
  }
  return normalized;
}

function normalizedAllocations(allocations = []) {
  return allocations.map(allocation => ({
    ...(allocation._id && mongoose.Types.ObjectId.isValid(allocation._id)
      ? { _id: new mongoose.Types.ObjectId(allocation._id) }
      : {}),
    sessionIds: uniqueIds(allocation.sessionIds || []).map(id => new mongoose.Types.ObjectId(id)),
    invoice: allocation.invoice ? {
      invoiceNumber: String(allocation.invoice.invoiceNumber || '').trim(),
      invoiceDate: allocation.invoice.invoiceDate || null,
      documentId: allocation.invoice.documentId
        ? objectId(allocation.invoice.documentId, 'invoice.documentId')
        : null
    } : null
  }));
}

function assertAllocationCoverage(sessionIds, allocations, { requireInvoices = false } = {}) {
  if (!allocations.length) {
    throw new BillingSubmissionError(
      'BILLING_SUBMISSION_ALLOCATIONS_REQUIRED',
      'Informe ao menos uma alocação de faturamento'
    );
  }

  const expected = new Set(sessionIds.map(value => value.toString()));
  const allocated = new Set();

  for (const allocation of allocations) {
    if (!allocation.sessionIds?.length) {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_ALLOCATION_SESSIONS_REQUIRED',
        'Toda alocação precisa conter ao menos uma sessão'
      );
    }

    if (requireInvoices) {
      const invoice = allocation.invoice;
      if (!invoice?.invoiceNumber || !invoice?.invoiceDate || !invoice?.documentId) {
        throw new BillingSubmissionError(
          'BILLING_SUBMISSION_INVOICE_REQUIRED',
          'Todas as alocações precisam de número, data e documento da Nota Fiscal'
        );
      }
    }

    for (const sessionId of allocation.sessionIds) {
      const id = sessionId.toString();
      if (!expected.has(id)) {
        throw new BillingSubmissionError(
          'BILLING_SUBMISSION_ALLOCATION_OUT_OF_SCOPE',
          'Uma alocação contém sessão fora do submission',
          400,
          { sessionId: id }
        );
      }
      if (allocated.has(id)) {
        throw new BillingSubmissionError(
          'BILLING_SUBMISSION_DUPLICATE_SESSION',
          'Uma sessão não pode aparecer em mais de uma alocação',
          409,
          { sessionId: id }
        );
      }
      allocated.add(id);
    }
  }

  if (allocated.size !== expected.size) {
    const missingSessionIds = [...expected].filter(id => !allocated.has(id));
    throw new BillingSubmissionError(
      'BILLING_SUBMISSION_INCOMPLETE_COVERAGE',
      'As alocações precisam cobrir todas as sessões exatamente uma vez',
      400,
      { missingSessionIds }
    );
  }
}

async function resolveProvider(providerId, mongoSession) {
  const query = Convenio.findById(objectId(providerId, 'insuranceProviderId'));
  if (mongoSession) query.session(mongoSession);
  const provider = await query.lean();
  if (!provider || !provider.active) {
    throw new BillingSubmissionError(
      'BILLING_SUBMISSION_PROVIDER_INVALID',
      'Convênio não encontrado ou inativo',
      404
    );
  }
  return provider;
}

async function validateSessionScope({ patientId, provider, billingCompetence, sessionIds, mongoSession }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(billingCompetence || '')) {
    throw new BillingSubmissionError(
      'BILLING_SUBMISSION_INVALID_COMPETENCE',
      'billingCompetence deve usar o formato YYYY-MM'
    );
  }

  const ids = uniqueIds(sessionIds);
  if (!ids.length) {
    throw new BillingSubmissionError(
      'BILLING_SUBMISSION_SESSIONS_REQUIRED',
      'Selecione ao menos uma sessão'
    );
  }

  const query = Session.find({ _id: { $in: ids } })
    .select('_id patient date status appointmentId insuranceGuide billingBatchId')
    .lean();
  if (mongoSession) query.session(mongoSession);
  const sessions = await query;

  if (sessions.length !== ids.length) {
    throw new BillingSubmissionError(
      'BILLING_SUBMISSION_SESSION_NOT_FOUND',
      'Uma ou mais sessões não foram encontradas',
      404
    );
  }

  const patientObjectId = objectId(patientId, 'patientId');
  for (const session of sessions) {
    if (session.patient?.toString() !== patientObjectId.toString()) {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_PATIENT_MISMATCH',
        'Todas as sessões precisam pertencer ao mesmo paciente',
        409,
        { sessionId: session._id.toString() }
      );
    }
    if (session.status !== 'completed') {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_SESSION_NOT_COMPLETED',
        'Somente sessões concluídas podem entrar no faturamento',
        409,
        { sessionId: session._id.toString() }
      );
    }
    if (!session.appointmentId || !session.insuranceGuide) {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_SESSION_INCOMPLETE',
        'A sessão precisa possuir agendamento e guia de convênio',
        409,
        { sessionId: session._id.toString() }
      );
    }
    if (session.billingBatchId) {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_SESSION_ALREADY_BILLED',
        'Uma sessão selecionada já pertence a um lote',
        409,
        { sessionId: session._id.toString(), batchId: session.billingBatchId.toString() }
      );
    }
  }

  const guideIds = [...new Set(sessions.map(session => session.insuranceGuide.toString()))];
  const guideQuery = InsuranceGuide.find({ _id: { $in: guideIds } })
    .select('_id patientId insurance number specialty')
    .lean();
  if (mongoSession) guideQuery.session(mongoSession);
  const guides = await guideQuery;
  if (guides.length !== guideIds.length || guides.some(guide =>
    guide.patientId?.toString() !== patientObjectId.toString() || guide.insurance !== provider.code
  )) {
    throw new BillingSubmissionError(
      'BILLING_SUBMISSION_PROVIDER_MISMATCH',
      'Todas as guias precisam pertencer ao paciente e convênio do submission',
      409
    );
  }

  const paymentQuery = Payment.find({
    session: { $in: ids },
    billingType: 'convenio',
    status: { $in: ACTIVE_PAYMENT_STATUSES }
  }).select('_id session patient appointment amount status insurance').lean();
  if (mongoSession) paymentQuery.session(mongoSession);
  const payments = await paymentQuery;
  const paymentsBySession = new Map();
  for (const payment of payments) {
    const key = payment.session?.toString();
    if (!paymentsBySession.has(key)) paymentsBySession.set(key, []);
    paymentsBySession.get(key).push(payment);
  }
  for (const id of ids) {
    const candidates = paymentsBySession.get(id) || [];
    if (candidates.length !== 1) {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_PAYMENT_INTEGRITY_CONFLICT',
        'Cada sessão precisa possuir exatamente um Payment de convênio ativo',
        409,
        { sessionId: id, activePayments: candidates.length }
      );
    }
    const payment = candidates[0];
    if (payment.patient?.toString() !== patientObjectId.toString()) {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_PAYMENT_PATIENT_MISMATCH',
        'O Payment não pertence ao paciente do submission',
        409,
        { sessionId: id }
      );
    }
    const paymentProviderId = payment.insurance?.insuranceProvider?.toString?.();
    const paymentProviderCode = payment.insurance?.provider;
    if ((paymentProviderId && paymentProviderId !== provider._id.toString())
      || (paymentProviderCode && paymentProviderCode !== provider.code)) {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_PAYMENT_PROVIDER_MISMATCH',
        'O Payment não pertence ao convênio do submission',
        409,
        { sessionId: id }
      );
    }
    if (payment.insurance?.status !== 'pending_billing') {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_PAYMENT_NOT_ELIGIBLE',
        'O Payment da sessão não está pendente de faturamento',
        409,
        { sessionId: id, insuranceStatus: payment.insurance?.status || null }
      );
    }
    const amount = payment.insurance?.grossAmount > 0
      ? payment.insurance.grossAmount
      : payment.amount;
    if (!(amount > 0)) {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_PAYMENT_AMOUNT_INVALID',
        'O Payment da sessão não possui valor financeiro válido',
        409,
        { sessionId: id }
      );
    }
  }

  return {
    sessions,
    payments,
    paymentBySession: new Map(payments.map(payment => [payment.session.toString(), payment]))
  };
}

async function validateInvoiceDocuments(submission, allocations, mongoSession) {
  const documentIds = allocations.map(allocation => allocation.invoice?.documentId).filter(Boolean);
  if (!documentIds.length) return;
  const query = PatientDocument.find({ _id: { $in: documentIds } })
    .select('_id patientId type')
    .lean();
  if (mongoSession) query.session(mongoSession);
  const documents = await query;
  const valid = new Map(documents.map(document => [document._id.toString(), document]));
  for (const documentId of documentIds) {
    const document = valid.get(documentId.toString());
    if (!document || document.patientId?.toString() !== submission.patientId.toString() || document.type !== 'invoice') {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_INVOICE_DOCUMENT_INVALID',
        'O documento da NF precisa existir, ser do tipo invoice e pertencer ao paciente',
        409,
        { documentId: documentId.toString() }
      );
    }
  }
}

export async function createBillingSubmission({
  patientId,
  insuranceProviderId,
  billingCompetence,
  sessionIds,
  billingAllocations,
  userId
}) {
  const mongoSession = await mongoose.startSession();
  try {
    let created;
    await mongoSession.withTransaction(async () => {
      const provider = await resolveProvider(insuranceProviderId, mongoSession);
      const normalizedSessionIds = uniqueIds(sessionIds).map(id => new mongoose.Types.ObjectId(id));
      await validateSessionScope({
        patientId,
        provider,
        billingCompetence,
        sessionIds: normalizedSessionIds,
        mongoSession
      });

      const allocations = billingAllocations?.length
        ? normalizedAllocations(billingAllocations)
        : [{ sessionIds: normalizedSessionIds, invoice: null }];
      assertAllocationCoverage(normalizedSessionIds, allocations);

      const overlappingDrafts = await BillingSubmission.find({
        status: BillingSubmissionStatus.DRAFT,
        sessionIds: { $in: normalizedSessionIds }
      }).session(mongoSession);
      if (overlappingDrafts.length) {
        const requested = new Set(normalizedSessionIds.map(value => value.toString()));
        const exact = overlappingDrafts.find(draft =>
          draft.patientId.toString() === objectId(patientId, 'patientId').toString()
          && draft.insuranceProviderId.toString() === provider._id.toString()
          && draft.billingCompetence === billingCompetence
          && draft.sessionIds.length === requested.size
          && draft.sessionIds.every(value => requested.has(value.toString()))
        );
        if (exact) {
          created = exact;
          return;
        }
        throw new BillingSubmissionError(
          'BILLING_SUBMISSION_SESSION_RESERVED',
          'Uma ou mais sessões já pertencem a outro submission em draft',
          409
        );
      }

      const docs = await BillingSubmission.create([{
        patientId: objectId(patientId, 'patientId'),
        insuranceProviderId: provider._id,
        billingCompetence,
        sessionIds: normalizedSessionIds,
        billingAllocations: allocations,
        status: BillingSubmissionStatus.DRAFT,
        createdBy: objectId(userId, 'userId')
      }], { session: mongoSession });
      created = docs[0];
    });
    return created;
  } catch (error) {
    if (error?.code === 11000) {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_SESSION_RESERVED',
        'Uma ou mais sessões já pertencem a outro submission em draft',
        409
      );
    }
    throw error;
  } finally {
    await mongoSession.endSession();
  }
}

export async function updateBillingSubmission(id, { sessionIds, billingAllocations, expectedVersion, userId }) {
  const mongoSession = await mongoose.startSession();
  try {
    let updated;
    await mongoSession.withTransaction(async () => {
      const submission = await BillingSubmission.findById(objectId(id, 'submissionId')).session(mongoSession);
      if (!submission) {
        throw new BillingSubmissionError('BILLING_SUBMISSION_NOT_FOUND', 'Submission não encontrado', 404);
      }
      if (submission.status !== BillingSubmissionStatus.DRAFT) {
        throw new BillingSubmissionError('BILLING_SUBMISSION_IMMUTABLE', 'Somente submissions em draft podem ser alterados', 409);
      }
      if (expectedVersion !== undefined && submission.__v !== Number(expectedVersion)) {
        throw new BillingSubmissionError('BILLING_SUBMISSION_VERSION_CONFLICT', 'O submission foi alterado em outra tela', 409);
      }

      const provider = await resolveProvider(submission.insuranceProviderId, mongoSession);
      const normalizedSessionIds = uniqueIds(sessionIds || submission.sessionIds)
        .map(value => new mongoose.Types.ObjectId(value));
      await validateSessionScope({
        patientId: submission.patientId,
        provider,
        billingCompetence: submission.billingCompetence,
        sessionIds: normalizedSessionIds,
        mongoSession
      });
      const allocations = billingAllocations
        ? normalizedAllocations(billingAllocations)
        : submission.billingAllocations;
      assertAllocationCoverage(normalizedSessionIds, allocations);
      await validateInvoiceDocuments(submission, allocations, mongoSession);

      submission.sessionIds = normalizedSessionIds;
      submission.billingAllocations = allocations;
      submission.updatedBy = objectId(userId, 'userId');
      await submission.save({ session: mongoSession });
      updated = submission;
    });
    return updated;
  } catch (error) {
    if (error?.code === 11000) {
      throw new BillingSubmissionError(
        'BILLING_SUBMISSION_SESSION_RESERVED',
        'Uma ou mais sessões já pertencem a outro submission em draft',
        409
      );
    }
    throw error;
  } finally {
    await mongoSession.endSession();
  }
}

export async function finalizeBillingSubmission(id, { userId } = {}) {
  const mongoSession = await mongoose.startSession();
  try {
    let finalizedId;
    let idempotent = false;
    await mongoSession.withTransaction(async () => {
      const submission = await BillingSubmission.findById(objectId(id, 'submissionId')).session(mongoSession);
      if (!submission) {
        throw new BillingSubmissionError('BILLING_SUBMISSION_NOT_FOUND', 'Submission não encontrado', 404);
      }
      if (submission.status === BillingSubmissionStatus.FINALIZED) {
        finalizedId = submission._id;
        idempotent = true;
        return;
      }
      if (submission.status !== BillingSubmissionStatus.DRAFT) {
        throw new BillingSubmissionError('BILLING_SUBMISSION_NOT_FINALIZABLE', 'Submission não pode ser finalizado', 409);
      }

      const allocations = submission.billingAllocations;
      assertAllocationCoverage(submission.sessionIds, allocations, { requireInvoices: true });
      await validateInvoiceDocuments(submission, allocations, mongoSession);
      const provider = await resolveProvider(submission.insuranceProviderId, mongoSession);
      const scope = await validateSessionScope({
        patientId: submission.patientId,
        provider,
        billingCompetence: submission.billingCompetence,
        sessionIds: submission.sessionIds,
        mongoSession
      });

      const now = new Date();
      for (const allocation of allocations) {
        const allocationSessionIds = allocation.sessionIds.map(value => value.toString());
        const allocationSessions = scope.sessions.filter(session => allocationSessionIds.includes(session._id.toString()));
        const amounts = allocationSessions.map(session => {
          const payment = scope.paymentBySession.get(session._id.toString());
          return payment.insurance?.grossAmount > 0 ? payment.insurance.grossAmount : payment.amount;
        });
        const totalGross = amounts.reduce((sum, amount) => sum + amount, 0);
        const issRate = Number(provider.issRate || 0);
        const issAmount = Math.round(totalGross * issRate) / 100;
        const totalNet = Math.round((totalGross - issAmount) * 100) / 100;
        const dates = allocationSessions.map(session => new Date(session.date));
        const correlationId = `billing_submission_${submission._id}_${allocation._id}`;
        const batchNumber = `SUB-${submission._id}-${allocation._id}`;

        const created = await InsuranceBatch.create([{
          billingSubmissionId: submission._id,
          billingAllocationId: allocation._id,
          batchNumber,
          insuranceProvider: provider.code,
          patient: submission.patientId,
          startDate: new Date(Math.min(...dates)),
          endDate: new Date(Math.max(...dates)),
          sentDate: now,
          sessions: allocationSessions.map((session, index) => {
            const payment = scope.paymentBySession.get(session._id.toString());
            return {
              session: session._id,
              sessionDate: session.date,
              appointment: session.appointmentId,
              guide: session.insuranceGuide,
              payment: payment._id,
              grossAmount: amounts[index],
              netAmount: amounts[index],
              status: 'sent',
              sentAt: now
            };
          }),
          totalGross,
          totalNet,
          totalSessions: allocationSessions.length,
          issRate,
          issAmount,
          invoiceNumber: allocation.invoice.invoiceNumber,
          invoiceDate: allocation.invoice.invoiceDate,
          invoiceDocumentId: allocation.invoice.documentId,
          status: 'sent',
          createdBy: objectId(userId, 'userId'),
          sentBy: objectId(userId, 'userId'),
          correlationId
        }], { session: mongoSession });
        const batch = created[0];

        const linkResult = await Session.updateMany(
          {
            _id: { $in: allocation.sessionIds },
            $or: [{ billingBatchId: null }, { billingBatchId: { $exists: false } }]
          },
          { $set: { billingBatchId: batch._id } },
          { session: mongoSession }
        );
        if (linkResult.modifiedCount !== allocation.sessionIds.length) {
          throw new BillingSubmissionError(
            'BILLING_SUBMISSION_SESSION_ALREADY_BILLED',
            'Uma sessão foi vinculada a outro lote durante a finalização',
            409
          );
        }

        for (const session of allocationSessions) {
          const payment = scope.paymentBySession.get(session._id.toString());
          const transition = await transitionPaymentStatus(payment._id, 'billed', {
            session: mongoSession,
            userId,
            reason: 'billing_submission_finalized'
          });
          await recordInsuranceBilled(transition.payment, {
            userId,
            billedAt: now,
            correlationId: `${correlationId}_${payment._id}`
          }, mongoSession);
        }

        await saveToOutbox({
          eventId: `${correlationId}_sent`,
          eventType: EventTypes.INSURANCE_BATCH_SENT,
          aggregateType: 'insurance_batch',
          aggregateId: batch._id,
          correlationId,
          payload: {
            batchId: batch._id.toString(),
            billingSubmissionId: submission._id.toString(),
            billingAllocationId: allocation._id.toString(),
            sentAt: now,
            sentBy: String(userId),
            totalItems: allocationSessions.length
          }
        }, mongoSession);
      }

      submission.status = BillingSubmissionStatus.FINALIZED;
      submission.finalizedAt = now;
      submission.finalizedBy = objectId(userId, 'userId');
      submission.updatedBy = objectId(userId, 'userId');
      await submission.save({ session: mongoSession });
      finalizedId = submission._id;
    });

    const data = await getBillingSubmission(finalizedId);
    return { ...data, idempotent };
  } finally {
    await mongoSession.endSession();
  }
}

export async function cancelBillingSubmission(id, { userId } = {}) {
  const submission = await BillingSubmission.findOneAndUpdate(
    { _id: objectId(id, 'submissionId'), status: BillingSubmissionStatus.DRAFT },
    {
      $set: {
        status: BillingSubmissionStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledBy: objectId(userId, 'userId'),
        updatedBy: objectId(userId, 'userId')
      }
    },
    { new: true, runValidators: true }
  );
  if (!submission) {
    const exists = await BillingSubmission.exists({ _id: objectId(id, 'submissionId') });
    throw new BillingSubmissionError(
      exists ? 'BILLING_SUBMISSION_NOT_CANCELLABLE' : 'BILLING_SUBMISSION_NOT_FOUND',
      exists ? 'Somente submissions em draft podem ser cancelados' : 'Submission não encontrado',
      exists ? 409 : 404
    );
  }
  return submission;
}

export async function getBillingSubmission(id) {
  const submission = await BillingSubmission.findById(objectId(id, 'submissionId'))
    .populate('patientId', 'fullName')
    .populate('insuranceProviderId', 'code name')
    .populate({
      path: 'sessionIds',
      select: 'date time sessionType patient insuranceGuide',
      populate: { path: 'insuranceGuide', select: 'number specialty insurance' }
    })
    .populate('billingAllocations.invoice.documentId', 'type name originalName url mimeType size patientId')
    .lean();
  if (!submission) {
    throw new BillingSubmissionError('BILLING_SUBMISSION_NOT_FOUND', 'Submission não encontrado', 404);
  }

  const [batches, communications] = await Promise.all([
    InsuranceBatch.find({ billingSubmissionId: submission._id }).sort({ createdAt: 1 }).lean(),
    InsuranceCommunication.find({ billingSubmissionId: submission._id }).sort({ createdAt: 1 }).lean()
  ]);
  const paymentIds = batches.flatMap(batch => batch.sessions || []).map(item => item.payment).filter(Boolean);
  const payments = paymentIds.length
    ? await Payment.find({ _id: { $in: paymentIds } }).select('_id session insurance status amount').lean()
    : [];

  const received = payments.filter(payment => payment.insurance?.status === 'received').length;
  const rejected = payments.filter(payment => ['rejected', 'glosa'].includes(payment.insurance?.status)).length;
  const billed = payments.filter(payment => payment.insurance?.status === 'billed').length;

  return {
    submission,
    batches,
    communications,
    summary: {
      sessions: submission.sessionIds.length,
      allocations: submission.billingAllocations.length,
      invoices: batches.length
        ? batches.filter(batch => batch.invoiceNumber).length
        : submission.billingAllocations.filter(allocation => allocation.invoice).length,
      communications: communications.length,
      financial: { billed, received, rejected, total: payments.length }
    }
  };
}

export async function listBillingSubmissions({ patientId, insuranceProviderId, billingCompetence, status, page = 1, limit = 50 }) {
  const query = {};
  if (patientId) query.patientId = objectId(patientId, 'patientId');
  if (insuranceProviderId) query.insuranceProviderId = objectId(insuranceProviderId, 'insuranceProviderId');
  if (billingCompetence) query.billingCompetence = billingCompetence;
  if (status) query.status = status;
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const [data, total] = await Promise.all([
    BillingSubmission.find(query)
      .populate('patientId', 'fullName')
      .populate('insuranceProviderId', 'code name')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    BillingSubmission.countDocuments(query)
  ]);
  return { data, pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } };
}

export const __testables = {
  assertAllocationCoverage,
  normalizedAllocations
};
