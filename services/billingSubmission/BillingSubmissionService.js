import mongoose from 'mongoose';
import BillingSubmission, { BillingSubmissionStatus } from '../../models/BillingSubmission.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import InsuranceCommunication, { CommunicationStatus } from '../../models/InsuranceCommunication.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import PatientDocument from '../../models/PatientDocument.js';
import Convenio from '../../models/Convenio.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import { EventTypes } from '../../infrastructure/events/eventPublisher.js';
import { transitionPaymentStatusBatch, PaymentBatchTransitionError } from '../paymentStatusService.js';

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

  // A projeção precisa cobrir TODOS os campos lidos por paymentBillingInvariants
  // (asserções + reconstrução de patientId/appointmentId/kind). O faturamento
  // escreve via bulkWrite a partir destes documentos, sem reler o Payment — o que
  // não vier aqui simplesmente não existe para as invariantes, e uma projeção
  // curta faria uma asserção disparar contra um campo ausente em vez de errado.
  //
  // Vale em dobro para os campos de default materializado (`insurance.*` e
  // `splitMethods`): fora da projeção eles leriam `undefined` e o faturamento
  // sobrescreveria com o default um valor que já existia no documento.
  const paymentQuery = Payment.find({
    session: { $in: ids },
    billingType: 'convenio',
    status: { $in: ACTIVE_PAYMENT_STATUSES }
  }).select([
    '_id', 'session', 'sessions', 'patient', 'patientId', 'appointment', 'appointmentId',
    'amount', 'status', 'insurance', 'billingType', 'kind', 'isFromPackage',
    'financialDate', 'paidAt', 'paymentMethod', 'package', 'notes', 'splitMethods'
  ].join(' ')).lean();
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

/**
 * Coletor de métricas da finalização.
 *
 * `withTransaction` REEXECUTA o callback em TransientTransactionError (conflito
 * de escrita, eleição de primary). Por isso o coletor tem `resetAttempt()`: sem
 * ele, um retry somaria etapas e queries da tentativa abortada e o log mentiria.
 */
function createFinalizeMetrics(submissionId) {
  const startedAt = Date.now();
  let attempt = 0;
  let steps = [];
  let queries = 0;
  let payments = 0;

  return {
    resetAttempt() {
      attempt += 1;
      steps = [];
      queries = 0;
      payments = 0;
    },
    countQueries(n) { queries += n; },
    setPayments(n) { payments = n; },
    async step(name, fn) {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        steps.push({ step: name, ms: Date.now() - t0 });
      }
    },
    report(outcome) {
      const totalMs = Date.now() - startedAt;
      const summary = {
        submissionId: String(submissionId),
        outcome,
        totalMs,
        attempts: attempt,
        payments,
        queries,
        msPerPayment: payments ? Math.round((totalMs / payments) * 10) / 10 : null,
        steps
      };
      console.log(`[BillingSubmissionFinalize] ${JSON.stringify(summary)}`);
      return summary;
    }
  };
}

/**
 * Finaliza um submission: cria os lotes, vincula as sessões, move os Payments
 * para `billed`, lança no ledger e publica os eventos — tudo numa transação.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE ESCRITAS EM LOTE
 * ─────────────────────────────────────────────────────────────────────────────
 * A versão anterior percorria os Payments em série chamando
 * `transitionPaymentStatus` + `recordInsuranceBilled`, o que dava 4 round-trips
 * por sessão (findById + save + outbox + ledger). Na latência entre a aplicação
 * e o Atlas isso é ~0,7s POR SESSÃO: 16 sessões levavam ~12s e estouravam o
 * timeout do cliente. O cliente desistia, o servidor seguia e commitava, e a
 * interface anunciava falha para um faturamento que tinha dado certo.
 *
 * Agora o número de round-trips é ~constante em relação à quantidade de sessões.
 * O `findById` por Payment sumiu: `validateSessionScope` já carrega todos eles em
 * `scope.paymentBySession`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOOKS DO MONGOOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * `bulkWrite` não dispara `pre('validate')`/`pre('save')`/`post('save')` de
 * Payment. As invariantes desses hooks foram auditadas uma a uma e são aplicadas
 * explicitamente por ./paymentBillingInvariants.js — leia o cabeçalho de lá antes
 * de mexer aqui. Nenhum hook é ignorado em silêncio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROLLBACK E DESCONEXÃO DO CLIENTE
 * ─────────────────────────────────────────────────────────────────────────────
 * Falha em qualquer escrita do núcleo (lote, sessão, payment, ledger, outbox)
 * aborta a transação inteira. Já a desconexão do cliente NÃO é falha: um abort de
 * socket não cancela o handler nem a transação, e tentar provocar rollback a
 * partir disso criaria estado inconsistente em vez de evitá-lo. Quem reconcilia é
 * o cliente, relendo o submission (ver confirmFinalizeOutcome no frontend).
 *
 * @param {string} id
 * @param {Object} options
 * @param {string} options.userId
 * @param {{ reason: string }} [options.externalDelivery] quando o envio ao
 *   convênio aconteceu fora do sistema, registra a comunicação na MESMA
 *   transação — o registro do envio não pode sobreviver separado do faturamento.
 */
export async function finalizeBillingSubmission(id, { userId, externalDelivery } = {}) {
  const mongoSession = await mongoose.startSession();
  const metrics = createFinalizeMetrics(id);
  let committed = false;
  try {
    let finalizedId;
    let idempotent = false;

    await mongoSession.withTransaction(async () => {
      metrics.resetAttempt();

      const submission = await metrics.step('load_submission', () =>
        BillingSubmission.findById(objectId(id, 'submissionId')).session(mongoSession));
      metrics.countQueries(1);

      if (!submission) {
        throw new BillingSubmissionError('BILLING_SUBMISSION_NOT_FOUND', 'Submission não encontrado', 404);
      }
      // Idempotência lógica: um submission já finalizado devolve o estado atual
      // sem reescrever nada. É isto que torna seguro o retry do cliente depois de
      // um timeout, e o duplo clique.
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

      await metrics.step('validate', async () => {
        await validateInvoiceDocuments(submission, allocations, mongoSession);
      });
      metrics.countQueries(1);

      const provider = await metrics.step('resolve_provider', () =>
        resolveProvider(submission.insuranceProviderId, mongoSession));
      metrics.countQueries(1);

      const scope = await metrics.step('validate_scope', () => validateSessionScope({
        patientId: submission.patientId,
        provider,
        billingCompetence: submission.billingCompetence,
        sessionIds: submission.sessionIds,
        mongoSession
      }));
      metrics.countQueries(3); // sessions + guides + payments
      metrics.setPayments(scope.payments.length);

      const now = new Date();
      const actorId = objectId(userId, 'userId');

      // ── Fase 1: montar tudo em memória, sem tocar no banco ──────────────────
      const batchDocs = [];
      const sessionOps = [];
      const paymentTransitions = [];
      const outboxDocs = [];
      const invariantWarnings = [];

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

        // _id gerado no cliente porque as ops de Session/Payment/ledger precisam
        // referenciar o lote antes de qualquer ida ao banco. `batchNumber` e o
        // índice único (billingSubmissionId, billingAllocationId) continuam sendo
        // a defesa estrutural contra duplicata.
        const batchId = new mongoose.Types.ObjectId();

        batchDocs.push({
          _id: batchId,
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
          createdBy: actorId,
          sentBy: actorId,
          correlationId
        });

        sessionOps.push({
          updateMany: {
            filter: {
              _id: { $in: allocation.sessionIds },
              $or: [{ billingBatchId: null }, { billingBatchId: { $exists: false } }]
            },
            update: { $set: { billingBatchId: batchId } }
          }
        });

        for (const session of allocationSessions) {
          const payment = scope.paymentBySession.get(session._id.toString());

          const ledger = {
            type: 'insurance_billed',
            direction: 'credit',
            amount: payment.insurance?.grossAmount || payment.amount || 0,
            billingType: 'convenio',
            patient: payment.patient,
            appointment: payment.appointment,
            session: payment.session,
            payment: payment._id,
            correlationId: `${correlationId}_${payment._id}`,
            description: `Convênio faturado - ${payment.insurance?.provider || 'Convênio'}`,
            occurredAt: now,
            createdBy: actorId,
            metadata: {
              source: 'insurance_billing',
              provider: payment.insurance?.provider,
              authorizationCode: payment.insurance?.authorizationCode
            }
          };
          paymentTransitions.push({ payment, ledger });
        }

        outboxDocs.push({
          eventId: `${correlationId}_sent`,
          correlationId,
          eventType: EventTypes.INSURANCE_BATCH_SENT,
          aggregateType: 'insurance_batch',
          aggregateId: String(batchId),
          status: 'pending',
          createdAt: now,
          payload: {
            batchId: batchId.toString(),
            billingSubmissionId: submission._id.toString(),
            billingAllocationId: allocation._id.toString(),
            sentAt: now,
            sentBy: String(userId),
            totalItems: allocationSessions.length
          }
        });
      }

      // Truncado: num lote de 100 sessões legadas isso vira uma parede de log
      // que esconde o resto. A contagem é o sinal; a amostra serve para achar o
      // padrão e investigar pelo paymentId.
      if (invariantWarnings.length) {
        console.warn(
          `[BillingSubmissionFinalize] ${invariantWarnings.length} payment(s) tiveram campos ausentes reconstruídos `
          + `pelas invariantes. Amostra: ${JSON.stringify(invariantWarnings.slice(0, 3))}`
        );
      }

      // ── Fase 2: escrever em lote ────────────────────────────────────────────
      await metrics.step('insert_batches', () =>
        InsuranceBatch.insertMany(batchDocs, { session: mongoSession, ordered: true }));
      metrics.countQueries(1);

      const sessionResult = await metrics.step('link_sessions', () =>
        Session.bulkWrite(sessionOps, { session: mongoSession, ordered: true }));
      metrics.countQueries(1);
      if (sessionResult.modifiedCount !== submission.sessionIds.length) {
        throw new BillingSubmissionError(
          'BILLING_SUBMISSION_SESSION_ALREADY_BILLED',
          'Uma sessão foi vinculada a outro lote durante a finalização',
          409
        );
      }

      let paymentBatchResult;
      try {
        paymentBatchResult = await transitionPaymentStatusBatch(paymentTransitions, 'billed', {
          session: mongoSession,
          now,
          reason: 'billing_submission_finalized',
          userId,
          additionalOutboxDocs: outboxDocs,
          step: (name, operation) => metrics.step(name, operation)
        });
      } catch (error) {
        // Tradução HTTP fica aqui, na camada de billing — não em paymentStatusService.js.
        // O serviço canônico não deve saber o que é um status code; PaymentBatchTransitionError
        // só carrega .code/.details. Antes desta tradução, qualquer erro do serviço
        // canônico caía no branch genérico 500 do controller (não é BillingSubmissionError),
        // mesmo quando é um conflito de escrita concorrente — 409, não falha de servidor.
        const httpStatusByCode = {
          BILLING_SUBMISSION_PAYMENT_CONCURRENT_CHANGE: 409
        };
        const status = error instanceof PaymentBatchTransitionError ? httpStatusByCode[error.code] : undefined;
        if (status) {
          throw new BillingSubmissionError(error.code, error.message, status, error.details);
        }
        throw error;
      }
      // Contagem real reportada pelo serviço canônico — insert_outbox dentro dele é
      // condicional (só roda se sobrar evento novo após o dedupe), então um número
      // fixo aqui mentiria em cenários onde nem tudo é query nova.
      metrics.countQueries(paymentBatchResult.queriesExecuted);
      invariantWarnings.push(...paymentBatchResult.warnings);

      // Comunicação de envio externo: nasce junto do faturamento porque
      // representa um envio que JÁ aconteceu fora do sistema. Se ficasse para
      // depois do commit, um erro no meio deixaria faturamento sem registro de
      // entrega. E-mail é o caso oposto — ver nota no fim da função.
      if (externalDelivery?.reason) {
        await metrics.step('record_external_communication', async () => {
          const already = await InsuranceCommunication.findOne({
            billingSubmissionId: submission._id,
            deliveryMethod: 'external'
          }).session(mongoSession).lean();
          if (already) return;

          await InsuranceCommunication.create([{
            billingSubmissionId: submission._id,
            billingAllocationIds: allocations.map(allocation => allocation._id),
            patientId: submission.patientId,
            insuranceProvider: provider.code,
            purpose: 'billing',
            status: CommunicationStatus.SENT,
            statusReason: externalDelivery.reason,
            notes: `Envio externo registrado na finalização da competência ${submission.billingCompetence}`,
            deliveryMethod: 'external',
            sentAt: now,
            invoiceNumber: batchDocs[0]?.invoiceNumber || null,
            invoiceDate: batchDocs[0]?.invoiceDate || null,
            batchId: batchDocs[0]?._id || null,
            createdBy: actorId
          }], { session: mongoSession });
        });
        metrics.countQueries(2);
      }

      submission.status = BillingSubmissionStatus.FINALIZED;
      submission.finalizedAt = now;
      submission.finalizedBy = actorId;
      submission.updatedBy = actorId;
      await metrics.step('save_submission', () => submission.save({ session: mongoSession }));
      metrics.countQueries(1);
      finalizedId = submission._id;
    });

    committed = true;

    // Fora da transação: projeção de leitura da resposta. Nada aqui altera
    // estado, então uma falha daqui pra frente não desfaz o faturamento.
    const data = await metrics.step('build_response', () => getBillingSubmission(finalizedId));
    const instrumentation = metrics.report(idempotent ? 'idempotent' : 'finalized');
    return { ...data, idempotent, instrumentation };
  } catch (error) {
    // Depois do commit o faturamento EXISTE, mesmo que a montagem da resposta
    // tenha falhado. Registrar isso como 'failed' seria repetir no log o mesmo
    // erro que este trabalho corrige na interface: anunciar falha para uma
    // operação concluída. O outcome distingue os dois casos.
    metrics.report(
      committed
        ? `committed_response_failed:${error?.code || error?.name || 'unknown'}`
        : `rolled_back:${error?.code || error?.name || 'unknown'}`
    );
    throw error;
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
