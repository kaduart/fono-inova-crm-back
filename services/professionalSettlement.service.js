/**
 * 📋 Professional Settlement Service
 *
 * Processo formal de fechamento mensal por profissional.
 */

import moment from 'moment-timezone';
import mongoose from 'mongoose';
import ProfessionalSettlement from '../models/ProfessionalSettlement.js';
import Doctor from '../models/Doctor.js';
import { getProfessionalSummary } from './professionalFinancial.service.js';
import { getDoctorAdvances, attachToSettlement } from './professionalAdvance.service.js';
import { getDoctorReconciliation } from './reconciliation.service.js';
import { logMetric } from '../utils/logMetric.js';

const TIMEZONE = 'America/Sao_Paulo';

function buildPeriodDates(periodMonth, periodYear) {
  const start = moment.tz(`${periodYear}-${String(periodMonth).padStart(2, '0')}-01`, TIMEZONE).startOf('month').toDate();
  const end = moment.tz(start, TIMEZONE).endOf('month').toDate();
  return { startDate: start, endDate: end };
}

function toDateString(d) {
  return moment(d).tz(TIMEZONE).format('YYYY-MM-DD');
}

/**
 * ── Preview do fechamento ──
 */
export async function previewSettlement({ doctorId, periodMonth, periodYear }) {
  const startedAt = Date.now();
  const { startDate, endDate } = buildPeriodDates(periodMonth, periodYear);

  const [summary, advances, existing, reconciliation] = await Promise.all([
    getProfessionalSummary({ doctorId, startDate: toDateString(startDate), endDate: toDateString(endDate) }),
    getDoctorAdvances({ doctorId, startDate: toDateString(startDate), endDate: toDateString(endDate), status: 'active' }),
    ProfessionalSettlement.findOne({ doctor: doctorId, periodMonth, periodYear }).lean(),
    getDoctorReconciliation(doctorId, toDateString(startDate), toDateString(endDate)).catch(() => null)
  ]);

  const canClose = !existing || existing.status === 'cancelled';
  const hasFinancialIssues = reconciliation && (reconciliation.reconciliation?.orphanSessions || 0) > 0;

  const result = {
    doctorId,
    periodMonth,
    periodYear,
    canClose,
    alreadyClosed: existing?.status === 'closed',
    hasFinancialIssues,
    financialIssues: hasFinancialIssues ? {
      orphanSessions: reconciliation.reconciliation.orphanSessions,
      orphanPayments: 0,
      hasCommissionData: reconciliation.reconciliation.commission > 0
    } : null,
    preview: {
      ...summary,
      linkedAdvances: advances.map(a => ({
        advanceId: a._id,
        amount: a.amount,
        type: a.type,
        date: toDateString(a.date)
      }))
    }
  };

  logMetric('ProfessionalSettlementService', 'previewSettlement', {
    doctorId,
    periodMonth,
    periodYear,
    executionTimeMs: Date.now() - startedAt,
    cacheHit: false,
    canClose: result.canClose,
    hasFinancialIssues: result.hasFinancialIssues
  });

  return result;
}

/**
 * ── Fechamento mensal ──
 */
export async function closeMonthlySettlement({ doctorId, periodMonth, periodYear, closedBy = null, force = false, notes = null }) {
  const startedAt = Date.now();
  const { startDate, endDate } = buildPeriodDates(periodMonth, periodYear);
  const startStr = toDateString(startDate);
  const endStr = toDateString(endDate);

  // 1. Verificar se já existe fechamento
  const existing = await ProfessionalSettlement.findOne({ doctor: doctorId, periodMonth, periodYear });
  if (existing && existing.status === 'closed') {
    throw new Error(`Fechamento já existe para ${periodMonth}/${periodYear}`);
  }

  // 2. Preview e validação
  const preview = await previewSettlement({ doctorId, periodMonth, periodYear });

  if (!preview.canClose) {
    throw new Error('Não é possível fechar: período já possui fechamento ativo');
  }

  if (preview.hasFinancialIssues && !force) {
    const error = new Error('Problemas financeiros detectados. Use force=true para fechar mesmo assim.');
    error.code = 'FINANCIAL_ISSUES_DETECTED';
    error.issues = preview.financialIssues;
    throw error;
  }

  // 3. Buscar adiantamentos ativos do período
  const advances = await getDoctorAdvances({
    doctorId,
    startDate: startStr,
    endDate: endStr,
    status: 'active'
  });

  // 4. Criar/atualizar settlement
  const summary = preview.preview;

  // Buscar regras de comissão vigentes para congelar no snapshot
  const doctorSnapshot = await Doctor.findById(doctorId).select('commissionRules commissionRuleVersion').lean();

  const settlementData = {
    doctor: new mongoose.Types.ObjectId(doctorId),
    periodMonth,
    periodYear,
    status: 'closed',
    closedAt: new Date(),
    closedBy: closedBy ? new mongoose.Types.ObjectId(closedBy) : null,
    snapshot: {
      patients: summary.patients,
      sessions: summary.sessions,
      production: summary.production,
      received: summary.received,
      pending: summary.pending,
      commission: summary.commission,
      advances: summary.advances,
      balance: summary.balance,
      commissionRules: doctorSnapshot?.commissionRules || null,
      commissionRuleVersion: doctorSnapshot?.commissionRuleVersion || null
    },
    linkedAdvances: advances.map(a => ({
      advanceId: a._id,
      amount: a.amount,
      type: a.type,
      date: a.date
    })),
    reconciliationHealth: summary.health,
    notes
  };

  let settlement;
  if (existing) {
    settlement = await ProfessionalSettlement.findOneAndUpdate(
      { _id: existing._id },
      settlementData,
      { new: true }
    );
  } else {
    settlement = new ProfessionalSettlement(settlementData);
    await settlement.save();
  }

  // 5. Vincular adiantamentos ao fechamento
  await attachToSettlement({
    doctorId,
    settlementId: settlement._id.toString(),
    startDate: startStr,
    endDate: endStr
  });

  logMetric('ProfessionalSettlementService', 'closeMonthlySettlement', {
    doctorId,
    periodMonth,
    periodYear,
    executionTimeMs: Date.now() - startedAt,
    cacheHit: false,
    settlementId: settlement._id.toString(),
    advanceCount: advances.length,
    force
  });

  return settlement;
}

/**
 * ── Listar fechamentos do profissional ──
 */
export async function getDoctorSettlements(doctorId, options = {}) {
  const startedAt = Date.now();
  const { limit = 24, status = null } = options;

  const query = { doctor: new mongoose.Types.ObjectId(doctorId) };
  if (status) query.status = status;

  const result = await ProfessionalSettlement.find(query)
    .sort({ periodYear: -1, periodMonth: -1 })
    .limit(limit)
    .lean();

  logMetric('ProfessionalSettlementService', 'getDoctorSettlements', {
    doctorId,
    executionTimeMs: Date.now() - startedAt,
    cacheHit: false,
    count: result.length,
    status
  });

  return result;
}

/**
 * ── Buscar fechamento específico ──
 */
export async function getSettlement(doctorId, periodMonth, periodYear) {
  const startedAt = Date.now();
  const result = await ProfessionalSettlement.findOne({
    doctor: new mongoose.Types.ObjectId(doctorId),
    periodMonth,
    periodYear
  }).lean();

  logMetric('ProfessionalSettlementService', 'getSettlement', {
    doctorId,
    periodMonth,
    periodYear,
    executionTimeMs: Date.now() - startedAt,
    cacheHit: false,
    found: !!result
  });

  return result;
}

/**
 * ── Cancelar fechamento ──
 */
export async function cancelSettlement({ doctorId, periodMonth, periodYear, cancelledBy = null, reason = null }) {
  const startedAt = Date.now();
  const settlement = await ProfessionalSettlement.findOne({
    doctor: new mongoose.Types.ObjectId(doctorId),
    periodMonth,
    periodYear
  });

  if (!settlement) {
    throw new Error('Fechamento não encontrado');
  }

  if (settlement.status !== 'closed') {
    throw new Error('Apenas fechamentos fechados podem ser cancelados');
  }

  settlement.status = 'cancelled';
  settlement.cancelledAt = new Date();
  settlement.cancelledBy = cancelledBy ? new mongoose.Types.ObjectId(cancelledBy) : null;
  settlement.cancelReason = reason || null;

  await settlement.save();

  // Desvincular adiantamentos
  const { detachFromSettlement } = await import('./professionalAdvance.service.js');
  await detachFromSettlement(settlement._id.toString());

  logMetric('ProfessionalSettlementService', 'cancelSettlement', {
    doctorId,
    periodMonth,
    periodYear,
    executionTimeMs: Date.now() - startedAt,
    cacheHit: false,
    settlementId: settlement._id.toString(),
    cancelledBy
  });

  return settlement;
}
