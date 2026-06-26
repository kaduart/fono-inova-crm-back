/**
 * 📐 Commission Rule Service
 *
 * Governança de regras de comissão por profissional.
 *
 * Regras:
 *   - Uma sessão completa usa a regra mais específica possível.
 *   - Ordem de prioridade: (billingType + insurance + serviceType + vigência).
 *   - Não usa mais fallback para campos legados do Doctor.commissionRules.
 *   - Especialidade neuropediatria mantém percentual fixo (80%) quando não houver regra específica.
 */

import mongoose from 'mongoose';
import Doctor from '../models/Doctor.js';
import { resolveSessionFinancialValue } from '../utils/resolveSessionFinancialValue.js';

const NEUROPED_PERCENTAGE = 0.80;
const NEUROPSYCH_THRESHOLD = 10;

/**
 * Extrai o nome do convênio da sessão.
 */
export function getInsuranceName(session) {
  if (session.insuranceGuide?.insurance) {
    return session.insuranceGuide.insurance;
  }
  if (session.package?.insuranceProvider) {
    return session.package.insuranceProvider;
  }
  if (session.paymentMethod === 'convenio') {
    return 'convenio';
  }
  return null;
}

/**
 * Classifica a sessão para matching de regras.
 */
export function classifySessionForCommission(session) {
  const method = (session.paymentMethod || '').toLowerCase();
  const origin = (session.paymentOrigin || '').toLowerCase();
  const sessionType = (session.sessionType || session.package?.sessionType || '').toLowerCase();

  let billingType = 'particular';
  if (method === 'liminar_credit' || origin === 'liminar' || origin === 'liminar_credit') {
    billingType = 'liminar';
  } else if (method === 'convenio' || origin === 'convenio' || session.insuranceGuide) {
    billingType = 'convenio';
  } else if (session.package) {
    billingType = 'package';
  }

  let serviceType = 'session';
  if (sessionType === 'neuropsych_evaluation' || sessionType === 'neuropsychological') {
    serviceType = 'neuropsychological';
  } else if (sessionType === 'evaluation') {
    serviceType = 'evaluation';
  }

  const insurance = getInsuranceName(session);

  return { billingType, serviceType, insurance };
}

/**
 * Encontra a regra aplicável para uma sessão.
 */
export function findApplicableCommissionRule(doctor, session, sessionDate = null) {
  const date = sessionDate || session.date || new Date();
  const { billingType, serviceType, insurance } = classifySessionForCommission(session);
  const rules = doctor.commissionRules?.rules || [];

  const sessionValue = session.sessionValue || 0;

  const activeRules = rules.filter(r => {
    if (r.active === false) return false;
    if (r.startDate && new Date(date) < new Date(r.startDate)) return false;
    if (r.endDate && new Date(date) > new Date(r.endDate)) return false;
    if (r.effectiveDate && new Date(date) < new Date(r.effectiveDate)) return false;
    if (r.minValue !== undefined && r.minValue !== null && sessionValue < r.minValue) return false;
    if (r.maxValue !== undefined && r.maxValue !== null && sessionValue > r.maxValue) return false;
    return true;
  });

  // Ordem de especificidade: billingType + insurance + serviceType
  const candidates = activeRules.filter(r => {
    const matchBilling = r.billingType === billingType;
    const matchService = r.serviceType === serviceType;
    const matchInsurance = billingType === 'convenio'
      ? r.insurance && insurance && r.insurance.toLowerCase() === insurance.toLowerCase()
      : true;
    return matchBilling && matchService && matchInsurance;
  });

  if (candidates.length > 0) {
    // Prioridade: maior priority → regra mais específica → mais recente
    candidates.sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) {
        return (b.priority || 0) - (a.priority || 0);
      }
      const aSpecific = (a.insurance ? 1 : 0) + (a.serviceType && a.serviceType !== 'session' ? 1 : 0);
      const bSpecific = (b.insurance ? 1 : 0) + (b.serviceType && b.serviceType !== 'session' ? 1 : 0);
      if (bSpecific !== aSpecific) return bSpecific - aSpecific;
      // Regras com vigência mais recente vencem em caso de empate
      const aEffective = a.effectiveDate || a.startDate || 0;
      const bEffective = b.effectiveDate || b.startDate || 0;
      return new Date(bEffective) - new Date(aEffective);
    });
    return candidates[0];
  }

  const sortByPriority = (a, b) => {
    if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
    const aEff = a.effectiveDate || a.startDate || 0;
    const bEff = b.effectiveDate || b.startDate || 0;
    return new Date(bEff) - new Date(aEff);
  };

  // Fallback 2: mesmo billingType, qualquer serviceType
  const fallbackBilling = activeRules.filter(r =>
    r.billingType === billingType && (!r.serviceType || r.serviceType === 'session')
  );
  if (fallbackBilling.length > 0) {
    fallbackBilling.sort(sortByPriority);
    return fallbackBilling[0];
  }

  // Fallback 3: sessões de pacote → tenta regras de 'particular'
  // Pacotes são pagamentos particulares — a regra de 'particular' deve se aplicar.
  if (billingType === 'package') {
    const partCandidates = activeRules.filter(r =>
      r.billingType === 'particular' && r.serviceType === serviceType
    );
    if (partCandidates.length > 0) {
      partCandidates.sort(sortByPriority);
      return partCandidates[0];
    }
    const partFallback = activeRules.filter(r =>
      r.billingType === 'particular' && (!r.serviceType || r.serviceType === 'session')
    );
    if (partFallback.length > 0) {
      partFallback.sort(sortByPriority);
      return partFallback[0];
    }
  }

  // Catch-all: usa a regra ativa de maior prioridade configurada no perfil
  // (garante que a regra personalizada do profissional sempre se aplica)
  if (activeRules.length > 0) {
    const catchAll = [...activeRules].sort(sortByPriority);
    return catchAll[0];
  }

  return null;
}

/**
 * Calcula a comissão de UMA sessão.
 */
export function calculateSessionCommission(doctor, session, sessionDate = null) {
  // Usa o mesmo valor base da produção (package.sessionValue > prorata > session.sessionValue)
  // Evita divergência entre produção e comissão quando session.sessionValue ≠ package.sessionValue
  const value = resolveSessionFinancialValue(session) || session.sessionValue || 0;
  const sessionType = (session.sessionType || session.package?.sessionType || '').toLowerCase();
  const isNeuropediatria = ['neuroped', 'neuropediatria'].includes(
    (doctor.specialty || '').toLowerCase().trim()
  );

  // Neuropediatria: percentual fixo quando não há regra específica
  if (isNeuropediatria) {
    const rule = findApplicableCommissionRule(doctor, session, sessionDate);
    if (rule) {
      return rule.commissionType === 'fixed'
        ? rule.value
        : Math.round(value * (rule.value / 100) * 100) / 100;
    }
    if (value > 0) {
      return Math.round(value * NEUROPED_PERCENTAGE * 100) / 100;
    }
    return 0;
  }

  // Avaliação neuropsicológica em PACOTE: processada em batch (retorna 0 aqui)
  // Avulsa (particular/liminar) usa o motor de regras normalmente
  if (
    (sessionType === 'neuropsych_evaluation' || sessionType === 'neuropsychological') &&
    (session.package || session.packageId)
  ) {
    return 0;
  }

  const rule = findApplicableCommissionRule(doctor, session, sessionDate);
  if (rule) {
    return rule.commissionType === 'fixed'
      ? rule.value
      : Math.round(value * (rule.value / 100) * 100) / 100;
  }

  // Sem regra configurada: sem comissão (exceto neuropediatria, tratada acima)
  return 0;
}

/**
 * Calcula comissão total de um conjunto de sessões.
 * Retorna total e breakdown.
 */
export function calculateCommissionBatch(doctor, sessions) {
  let totalCommission = 0;
  let totalProductionBase = 0;
  const breakdown = {
    standardSessions: { count: 0, value: 0, byInsurance: {} },
    evaluations: { count: 0, value: 0 },
    neuropsychEvaluations: { count: 0, value: 0 },
    custom: []
  };

  const isNeuropediatria = ['neuroped', 'neuropediatria'].includes(
    (doctor.specialty || '').toLowerCase().trim()
  );

  const neuropsychPackages = new Map();

  for (const session of sessions) {
    const sessionType = (session.sessionType || session.package?.sessionType || '').toLowerCase();

    if (sessionType === 'neuropsych_evaluation' || sessionType === 'neuropsychological') {
      const pkgId = session.package?._id?.toString?.() || session.package;
      if (pkgId) {
        if (!neuropsychPackages.has(pkgId)) {
          neuropsychPackages.set(pkgId, {
            completedSessions: 0,
            totalSessions: session.package?.totalSessions || NEUROPSYCH_THRESHOLD
          });
        }
        neuropsychPackages.get(pkgId).completedSessions++;
      }
      continue;
    }

    const value = session.sessionValue || 0;
    totalProductionBase += value;
    const commission = calculateSessionCommission(doctor, session);

    totalCommission += commission;

    const { billingType, insurance } = classifySessionForCommission(session);

    if (sessionType === 'evaluation') {
      breakdown.evaluations.count++;
      breakdown.evaluations.value += commission;
    } else {
      breakdown.standardSessions.count++;
      breakdown.standardSessions.value += commission;

      const insuranceKey = insurance || 'particular';
      if (!breakdown.standardSessions.byInsurance[insuranceKey]) {
        breakdown.standardSessions.byInsurance[insuranceKey] = {
          count: 0,
          value: 0,
          rate: isNeuropediatria ? `${Math.round(NEUROPED_PERCENTAGE * 100)}%` : commission
        };
      }
      breakdown.standardSessions.byInsurance[insuranceKey].count++;
      breakdown.standardSessions.byInsurance[insuranceKey].value += commission;
    }
  }

  // Processar neuropsicologia completa
  const neuropsychValue = doctor.commissionRules?.neuropsychEvaluation || 1200;
  for (const data of neuropsychPackages.values()) {
    if (data.completedSessions >= data.totalSessions) {
      breakdown.neuropsychEvaluations.count++;
      breakdown.neuropsychEvaluations.value += neuropsychValue;
      totalCommission += neuropsychValue;
    }
  }

  return { totalCommission, breakdown, neuropsychPackages, totalProductionBase };
}

// ═════════════════════════════════════════════════════════════════
// CRUD de regras
// ═════════════════════════════════════════════════════════════════

export async function getDoctorCommissionRules(doctorId) {
  const doctor = await Doctor.findById(doctorId).select('commissionRules').lean();
  if (!doctor) throw new Error('Profissional não encontrado');
  return doctor.commissionRules?.rules || [];
}

export async function createCommissionRule(doctorId, ruleData) {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw new Error('Profissional não encontrado');

  const rule = {
    _id: new mongoose.Types.ObjectId(),
    serviceType: ruleData.serviceType || 'session',
    billingType: ruleData.billingType || 'particular',
    insurance: ruleData.insurance || null,
    commissionType: ruleData.commissionType || 'fixed',
    value: ruleData.value ?? 0,
    minValue: ruleData.minValue ?? null,
    maxValue: ruleData.maxValue ?? null,
    priority: ruleData.priority ?? 0,
    startDate: ruleData.startDate || null,
    endDate: ruleData.endDate || null,
    effectiveDate: ruleData.effectiveDate || null,
    active: ruleData.active !== false,
    notes: ruleData.notes || ''
  };

  doctor.commissionRules = doctor.commissionRules || {};
  doctor.commissionRules.rules = doctor.commissionRules.rules || [];
  doctor.commissionRules.rules.push(rule);
  doctor.commissionRuleVersion = (doctor.commissionRuleVersion || 1) + 1;
  await doctor.save();

  return rule;
}

export async function updateCommissionRule(doctorId, ruleId, ruleData) {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw new Error('Profissional não encontrado');

  doctor.commissionRules = doctor.commissionRules || {};
  const rules = doctor.commissionRules.rules || [];
  const rule = rules.find(r => r._id.toString() === ruleId);
  if (!rule) throw new Error('Regra não encontrada');

  if (ruleData.serviceType !== undefined) rule.serviceType = ruleData.serviceType;
  if (ruleData.billingType !== undefined) rule.billingType = ruleData.billingType;
  if (ruleData.insurance !== undefined) rule.insurance = ruleData.insurance || null;
  if (ruleData.commissionType !== undefined) rule.commissionType = ruleData.commissionType;
  if (ruleData.value !== undefined) rule.value = ruleData.value;
  if (ruleData.minValue !== undefined) rule.minValue = ruleData.minValue ?? null;
  if (ruleData.maxValue !== undefined) rule.maxValue = ruleData.maxValue ?? null;
  if (ruleData.priority !== undefined) rule.priority = ruleData.priority;
  if (ruleData.startDate !== undefined) rule.startDate = ruleData.startDate || null;
  if (ruleData.endDate !== undefined) rule.endDate = ruleData.endDate || null;
  if (ruleData.effectiveDate !== undefined) rule.effectiveDate = ruleData.effectiveDate || null;
  if (ruleData.active !== undefined) rule.active = ruleData.active;
  if (ruleData.notes !== undefined) rule.notes = ruleData.notes;

  doctor.commissionRuleVersion = (doctor.commissionRuleVersion || 1) + 1;
  await doctor.save();
  return rule;
}

export async function deleteCommissionRule(doctorId, ruleId) {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw new Error('Profissional não encontrado');

  doctor.commissionRules = doctor.commissionRules || {};
  doctor.commissionRules.rules = (doctor.commissionRules.rules || [])
    .filter(r => r._id.toString() !== ruleId);

  doctor.commissionRuleVersion = (doctor.commissionRuleVersion || 1) + 1;
  await doctor.save();
  return { deleted: true };
}

/**
 * Cria um snapshot da comissão aplicada a uma sessão.
 */
export function createCommissionSnapshot(doctor, session, sessionDate = null) {
  const rule = findApplicableCommissionRule(doctor, session, sessionDate);
  const calculatedCommission = calculateSessionCommission(doctor, session, sessionDate);

  return {
    ruleId: rule?._id?.toString?.() || null,
    version: doctor.commissionRuleVersion || 1,
    commissionType: rule?.commissionType || null,
    value: rule?.value ?? null,
    minValue: rule?.minValue ?? null,
    maxValue: rule?.maxValue ?? null,
    effectiveDate: rule?.effectiveDate ?? null,
    calculatedCommission,
    calculatedAt: new Date().toISOString()
  };
}

/**
 * Simula comissão de um profissional em um período.
 */
export async function simulateCommission(doctorId, startDate, endDate) {
  const doctor = await Doctor.findById(doctorId)
    .select('fullName specialty commissionRules commissionRuleVersion')
    .lean();

  if (!doctor) throw new Error('Profissional não encontrado');

  // Importação dinâmica para evitar circular dependency
  const { default: Session } = await import('../models/Session.js');

  const start = startDate instanceof Date ? startDate : new Date(startDate);
  const end = endDate instanceof Date ? endDate : new Date(endDate);

  const sessions = await Session.find({
    doctor: doctorId,
    date: { $gte: start, $lte: end },
    status: 'completed'
  })
    .populate('package', 'sessionType totalSessions insuranceProvider sessionValue totalValue')
    .populate('insuranceGuide', 'insurance')
    .lean();

  const { totalCommission, breakdown } = calculateCommissionBatch(doctor, sessions);

  const production = sessions.reduce((sum, s) => sum + (s.sessionValue || 0), 0);

  const rulesApplied = [...new Set(
    sessions
      .map(s => findApplicableCommissionRule(doctor, s, s.date))
      .filter(Boolean)
      .map(r => r._id.toString())
  )].map(ruleId => {
    const rule = doctor.commissionRules?.rules?.find(r => r._id.toString() === ruleId);
    return rule || { _id: ruleId, note: 'Regra não encontrada no documento atual' };
  });

  return {
    doctorId,
    doctorName: doctor.fullName,
    version: doctor.commissionRuleVersion || 1,
    period: {
      start: start.toISOString().split('T')[0],
      end: end.toISOString().split('T')[0]
    },
    sessions: sessions.length,
    production: Math.round(production * 100) / 100,
    commission: Math.round(totalCommission * 100) / 100,
    breakdown,
    rulesApplied
  };
}
