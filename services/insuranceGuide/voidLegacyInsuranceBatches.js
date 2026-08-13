// back/services/insuranceGuide/voidLegacyInsuranceBatches.js
/**
 * Invalida lotes legados órfãos, preservando o documento para auditoria.
 *
 * PROBLEMA QUE RESOLVE
 * Cinco lotes de teste ficaram na base depois que suas sessões, guias,
 * appointments e payments foram apagados. Não têm débito, não têm NF, e não
 * aparecem na aba "Notas Fiscais" (que filtra por `invoiceNumber` presente) —
 * mas continuam sendo alcançados por qualquer varredura de lotes legados, e
 * bloqueiam a migração com LEGACY_SESSION_NOT_FOUND.
 *
 * POR QUE `voided` E NÃO DELETE
 * Apagar o documento apaga também a prova de que ele existiu. `voided` mantém o
 * registro, guarda o status anterior em `statusBeforeInvalidation` e permite
 * reverter. Distinto de `superseded`: aquele tinha faturamento válido e foi
 * substituído; este nunca teve débito.
 *
 * SEGURANÇA
 * Só aceita ids explicitamente informados — nunca descobre alvos sozinho. E o
 * preflight exige ausência TOTAL de vínculo: qualquer sessão, payment,
 * appointment, guia, NF, recebimento ou billingSubmission bloqueia o lote.
 *
 * `dryRun` é o padrão.
 */
import mongoose from 'mongoose';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import { saveToOutbox } from '../../infrastructure/outbox/outboxPattern.js';
import { createContextLogger } from '../../utils/logger.js';

const logger = createContextLogger('void_legacy_batches');

export const VOID_BLOCKING = {
  NOT_FOUND: 'VOID_BATCH_NOT_FOUND',
  HAS_SESSION: 'VOID_BATCH_HAS_LIVE_SESSION',
  HAS_PAYMENT: 'VOID_BATCH_HAS_LIVE_PAYMENT',
  HAS_APPOINTMENT: 'VOID_BATCH_HAS_LIVE_APPOINTMENT',
  HAS_GUIDE: 'VOID_BATCH_HAS_LIVE_GUIDE',
  HAS_INVOICE: 'VOID_BATCH_HAS_INVOICE',
  HAS_RECEIPT: 'VOID_BATCH_HAS_RECEIPT',
  HAS_SUBMISSION: 'VOID_BATCH_HAS_SUBMISSION',
  STATUS_NOT_ALLOWED: 'VOID_BATCH_STATUS_NOT_ALLOWED',
  NO_ALLOWLIST: 'VOID_BATCH_ALLOWLIST_REQUIRED'
};

const ALLOWED_STATUSES = ['ready', 'sent'];
const idOf = v => (v?._id ?? v)?.toString() ?? null;

/**
 * Preflight de um lote. Devolve a lista de bloqueios — vazia significa seguro.
 */
export async function inspectBatchForVoid(batchId, mongoSession = null) {
  const batch = await InsuranceBatch.findById(batchId).session(mongoSession).lean();
  if (!batch) return { batchId, batch: null, blockers: [{ code: VOID_BLOCKING.NOT_FOUND }] };

  const blockers = [];

  if (batch.invoiceNumber) blockers.push({ code: VOID_BLOCKING.HAS_INVOICE, detail: batch.invoiceNumber });
  if ((batch.receivedAmount || 0) > 0 || batch.receivedAt) {
    blockers.push({ code: VOID_BLOCKING.HAS_RECEIPT, detail: `receivedAmount=${batch.receivedAmount} receivedAt=${batch.receivedAt}` });
  }
  if (batch.billingSubmissionId) blockers.push({ code: VOID_BLOCKING.HAS_SUBMISSION, detail: idOf(batch.billingSubmissionId) });
  if (!ALLOWED_STATUSES.includes(batch.status)) {
    blockers.push({ code: VOID_BLOCKING.STATUS_NOT_ALLOWED, detail: batch.status });
  }

  // Nenhuma Session pode apontar para o lote.
  const vinculadas = await Session.countDocuments({ billingBatchId: batch._id }, { session: mongoSession });
  if (vinculadas > 0) blockers.push({ code: VOID_BLOCKING.HAS_SESSION, detail: `${vinculadas} sessões vinculadas` });

  // E nada referenciado pelos itens embutidos pode existir.
  for (const item of batch.sessions || []) {
    if (item.session) {
      const s = await Session.findById(item.session).select('_id').session(mongoSession).lean();
      if (s) blockers.push({ code: VOID_BLOCKING.HAS_SESSION, detail: `session ${idOf(item.session)} existe` });
    }
    if (item.payment) {
      const p = await Payment.findById(item.payment).select('_id status').session(mongoSession).lean();
      if (p) blockers.push({ code: VOID_BLOCKING.HAS_PAYMENT, detail: `payment ${idOf(item.payment)} existe (${p.status})` });
    }
    if (item.appointment) {
      const a = await Appointment.findById(item.appointment).select('_id').session(mongoSession).lean();
      if (a) blockers.push({ code: VOID_BLOCKING.HAS_APPOINTMENT, detail: `appointment ${idOf(item.appointment)} existe` });
    }
    if (item.guide) {
      const g = await InsuranceGuide.findById(item.guide).select('_id').session(mongoSession).lean();
      if (g) blockers.push({ code: VOID_BLOCKING.HAS_GUIDE, detail: `guia ${idOf(item.guide)} existe` });
    }
  }

  return {
    batchId: idOf(batch._id),
    batch: {
      status: batch.status, invoiceNumber: batch.invoiceNumber ?? null,
      totalGross: batch.totalGross, receivedAmount: batch.receivedAmount,
      items: (batch.sessions || []).length
    },
    blockers
  };
}

/**
 * @param {Object} opts
 * @param {string[]} opts.batchIds - allowlist obrigatória
 * @param {string} opts.userId
 * @param {string} opts.reason
 * @param {boolean} [opts.dryRun=true]
 */
export async function voidLegacyInsuranceBatches({ batchIds, userId, reason, dryRun = true } = {}) {
  if (!batchIds?.length) {
    return { dryRun, written: false, blocked: true, idempotent: false, inspections: [], conflicts: [{ code: VOID_BLOCKING.NO_ALLOWLIST }] };
  }
  if (!dryRun && !reason) {
    return { dryRun, written: false, blocked: true, idempotent: false, inspections: [], conflicts: [{ code: 'VOID_BATCH_REASON_REQUIRED' }] };
  }

  const ids = batchIds.map(id => new mongoose.Types.ObjectId(id));

  // Idempotência: já invalidados devolvem cedo, sem tocar em nada.
  const atuais = await InsuranceBatch.find({ _id: { $in: ids } }).select('_id status').lean();
  const jaVoided = atuais.filter(b => b.status === 'voided');
  if (jaVoided.length === atuais.length && atuais.length === batchIds.length) {
    return {
      dryRun, written: false, blocked: false, idempotent: true,
      voidedBatchIds: jaVoided.map(b => idOf(b._id)), inspections: [], conflicts: []
    };
  }
  if (jaVoided.length > 0) {
    return {
      dryRun, written: false, blocked: true, idempotent: false, inspections: [],
      conflicts: [{ code: 'VOID_BATCH_PARTIAL_STATE', detail: `${jaVoided.length} de ${atuais.length} já estão voided` }]
    };
  }

  const inspections = [];
  for (const id of ids) inspections.push(await inspectBatchForVoid(id));
  const comBloqueio = inspections.filter(i => i.blockers.length);

  if (comBloqueio.length) {
    return { dryRun, written: false, blocked: true, idempotent: false, inspections, conflicts: comBloqueio };
  }
  if (dryRun) {
    return { dryRun: true, written: false, blocked: false, idempotent: false, inspections, conflicts: [] };
  }

  const mongoSession = await mongoose.startSession();
  let committed = null;
  try {
    await mongoSession.withTransaction(async () => {
      const now = new Date();
      const voided = [];   // escopo POR TENTATIVA — o driver pode repetir o callback

      for (const id of ids) {
        // Revalida dentro da transação: entre o preflight e aqui algo pode ter mudado.
        const check = await inspectBatchForVoid(id, mongoSession);
        if (check.blockers.length) {
          throw new Error(`VOID_ABORT ${idOf(id)}: ${check.blockers.map(b => b.code).join(', ')}`);
        }

        // `updateOne` e não `.save()`: o save valida o documento inteiro, e um
        // lote legado pode ter itens que violam o schema atual. Invalidar não
        // pode depender de o lote estar íntegro — a falta de integridade é
        // justamente o motivo de ele estar sendo invalidado.
        const batch = await InsuranceBatch.findById(id).session(mongoSession).lean();
        await InsuranceBatch.updateOne(
          { _id: id },
          {
            $set: {
              statusBeforeInvalidation: batch.status,
              status: 'voided',
              voidedAt: now,
              voidedBy: new mongoose.Types.ObjectId(userId),
              voidReason: reason
            }
          },
          { session: mongoSession }
        );
        voided.push({ batchId: idOf(id), statusBeforeInvalidation: batch.status });

        await saveToOutbox({
          eventId: `insurance_batch_voided_${idOf(id)}_${now.getTime()}`,
          eventType: 'INSURANCE_BATCH_VOIDED',
          aggregateType: 'insurance_batch',
          aggregateId: batch._id,
          correlationId: `legacy_void_${now.getTime()}`,
          payload: {
            batchId: idOf(id),
            statusBeforeInvalidation: batch.status,
            voidedAt: now, voidedBy: String(userId), reason
          }
        }, mongoSession);
      }
      committed = voided;
    });

    logger.info('lotes legados invalidados', { total: committed.length });
    return { dryRun: false, written: true, blocked: false, idempotent: false, voided: committed, inspections, conflicts: [] };
  } finally {
    await mongoSession.endSession();
  }
}
