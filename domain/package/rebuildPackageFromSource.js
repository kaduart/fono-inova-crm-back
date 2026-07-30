/**
 * 🔧 Domain Service: Rebuild Package from Source of Truth
 * 
 * Recalcula TODO o estado de um Package a partir das collections:
 * - sessions (status, datas)
 * - appointments (vínculos)
 * - payments (financeiro)
 * 
 * NÃO usa os arrays legados `package.sessions` nem `package.appointments`.
 * Substitui todos os contadores manuais por queries reais.
 * 
 * ⚠️ NÃO afeta liminar/convenio (sessões sem package ou com modelos próprios)
 */

import Session from '../../models/Session.js';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Package from '../../models/Package.js';
import { buildPackageView } from '../../domains/billing/services/PackageProjectionService.js';

/**
 * Recalcula e persiste o estado derivado de um Package
 * @param {string|ObjectId} packageId
 * @param {Object} options
 * @param {mongoose.ClientSession} options.mongoSession
 * @returns {Promise<Object>} estado reconstruído
 */
/**
 * Calcula o estado reconstruído de um Package a partir das fontes de verdade.
 * NÃO persiste — retorna apenas o estado calculado.
 */
async function calculatePackageState(packageId, options = {}) {
  const { mongoSession } = options;
  const sessionOpt = mongoSession ? { session: mongoSession } : {};

  // ─── Carrega o package atual ───
  const pkg = await Package.findById(packageId, null, sessionOpt).lean();
  if (!pkg) {
    throw new Error(`Package ${packageId} not found`);
  }

  // ─── Fonte de verdade: Sessions ───
  const sessions = await Session.find({ package: packageId }, null, sessionOpt).lean();

  const completedSessions = sessions.filter(s => s.status === 'completed');
  const canceledSessions  = sessions.filter(s => s.status === 'canceled' || s.status === 'cancelled');
  const activeSessions    = sessions.filter(s =>
    ['scheduled', 'pending', 'unpaid', 'pre_agendado'].includes(s.status)
  );

  // ─── Fonte de verdade: Appointments ───
  const appointments = await Appointment.find({ package: packageId }, null, sessionOpt).lean();

  // ─── Fonte de verdade: Payments ───
  const payments = await Payment.find(
    { package: packageId, status: { $in: ['paid', 'completed'] } },
    null,
    sessionOpt
  ).lean();

  const totalPaid = payments.reduce((sum, p) => sum + (p.value || p.amount || 0), 0);

  // ─── Recálculo dos campos derivados ───
  const sessionValue = pkg.sessionValue || sessions[0]?.sessionValue || sessions[0]?.value || 0;

  // 🔥 PRESERVAR contrato original: totalSessions/totalValue são do pacote, não do banco
  const totalSessions = pkg.totalSessions || sessions.length;
  const totalValue = pkg.totalValue || (totalSessions * sessionValue);

  const sessionsDone = completedSessions.length;
  const sessionsCanceled = canceledSessions.length;
  const sessionsUsed = sessionsDone; // compatibilidade
  const sessionsRemaining = Math.max(0, totalSessions - sessionsDone - sessionsCanceled);

  // 🎯 consumedValue: valor estimado das sessões já consumidas (separado de totalPaid)
  // 💰 totalPaid: soma real dos payments (fonte de verdade financeira)
  // ⚖️ balance: crédito restante quando totalPaid > consumedValue
  const consumedValue = sessionsDone * sessionValue;
  const balance = Math.max(0, totalPaid - consumedValue);

  // Status do pacote
  let status = 'active';
  if (sessionsDone + sessionsCanceled >= totalSessions && activeSessions.length === 0) {
    status = 'finished';
  } else if (sessions.length === 0) {
    status = 'pending';
  }

  // Financial status
  let financialStatus = 'unpaid';
  if (totalPaid >= totalSessions * sessionValue && sessionValue > 0) {
    financialStatus = 'paid';
  } else if (totalPaid > 0) {
    financialStatus = 'partially_paid';
  }

  return {
    packageId: packageId.toString(),
    pkg,
    sessions,
    appointments,
    payments,
    totalSessions,
    sessionsDone,
    sessionsCanceled,
    sessionsUsed,
    sessionsRemaining,
    totalValue,
    sessionValue,
    totalPaid,
    consumedValue,
    balance,
    status,
    financialStatus
  };
}

/**
 * Recalcula e persiste o estado derivado de um Package
 */
async function rebuildPackageFromSource(packageId, options = {}) {
  const { mongoSession } = options;
  const sessionOpt = mongoSession ? { session: mongoSession } : {};

  const state = await calculatePackageState(packageId, options);

  // ─── Persistir (usando $set para não tocar em metadata) ───
  const update = {
    $set: {
      // Arrays legados são reconstruídos com IDs REAIS que existem no banco
      sessions: state.sessions.map(s => s._id),
      appointments: state.appointments.map(a => a._id),

      // Contadores derivados
      totalSessions: state.totalSessions,
      sessionsDone: state.sessionsDone,
      sessionsCanceled: state.sessionsCanceled,
      sessionsUsed: state.sessionsUsed,
      sessionsRemaining: state.sessionsRemaining,

      // Financeiro
      totalValue: state.totalValue,
      totalPaid: state.totalPaid,
      consumedValue: state.consumedValue,
      balance: state.balance,
      sessionValue: state.sessionValue || undefined,

      // Status
      status: state.status,
      financialStatus: state.financialStatus,

      updatedAt: new Date()
    },
    // Remove campos fantasmas criados por bugs antigos
    $unset: {
      remainingSessions: ''  // campo virtual que virou persistente por erro
    }
  };

  await Package.findByIdAndUpdate(packageId, update, sessionOpt);

  // 🔥 Reconstrói a view IMEDIATAMENTE para refletir as mudanças
  try {
    await buildPackageView(packageId.toString(), { correlationId: `rebuild_${Date.now()}` });
  } catch (viewError) {
    console.error(`[rebuildPackageFromSource] Erro ao reconstruir view: ${viewError.message}`);
  }

  return {
    packageId: state.packageId,
    totalSessions: state.totalSessions,
    sessionsDone: state.sessionsDone,
    sessionsCanceled: state.sessionsCanceled,
    sessionsRemaining: state.sessionsRemaining,
    totalPaid: state.totalPaid,
    consumedValue: state.consumedValue,
    balance: state.balance,
    status: state.status,
    financialStatus: state.financialStatus,
    sessionCount: state.sessions.length,
    appointmentCount: state.appointments.length,
    paymentCount: state.payments.length
  };
}

/**
 * Verifica se um package está inconsistente (sem persistir correção)
 */
async function auditPackage(packageId) {
  const pkg = await Package.findById(packageId).lean();
  if (!pkg) return null;

  const rebuilt = await calculatePackageState(packageId);

  const issues = [];
  if (pkg.sessionsDone !== rebuilt.sessionsDone) issues.push(`sessionsDone: ${pkg.sessionsDone} → ${rebuilt.sessionsDone}`);
  if (pkg.totalSessions !== rebuilt.totalSessions) issues.push(`totalSessions: ${pkg.totalSessions} → ${rebuilt.totalSessions}`);
  if (Math.abs((pkg.totalPaid || 0) - rebuilt.totalPaid) > 0.01) issues.push(`totalPaid: ${pkg.totalPaid} → ${rebuilt.totalPaid}`);
  if (Math.abs((pkg.consumedValue || 0) - rebuilt.consumedValue) > 0.01) issues.push(`consumedValue: ${pkg.consumedValue} → ${rebuilt.consumedValue}`);
  if (pkg.status !== rebuilt.status) issues.push(`status: ${pkg.status} → ${rebuilt.status}`);

  return {
    packageId: packageId.toString(),
    hasIssues: issues.length > 0,
    issues,
    current: {
      sessionsDone: pkg.sessionsDone,
      totalSessions: pkg.totalSessions,
      totalPaid: pkg.totalPaid,
      consumedValue: pkg.consumedValue,
      status: pkg.status
    },
    rebuilt: {
      packageId: rebuilt.packageId,
      totalSessions: rebuilt.totalSessions,
      sessionsDone: rebuilt.sessionsDone,
      sessionsCanceled: rebuilt.sessionsCanceled,
      sessionsRemaining: rebuilt.sessionsRemaining,
      totalValue: rebuilt.totalValue,
      totalPaid: rebuilt.totalPaid,
      consumedValue: rebuilt.consumedValue,
      balance: rebuilt.balance,
      status: rebuilt.status,
      financialStatus: rebuilt.financialStatus
    }
  };
}

export {
  calculatePackageState,
  rebuildPackageFromSource,
  auditPackage
};
