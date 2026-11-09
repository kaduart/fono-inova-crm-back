// services/commissionService.js
import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Doctor from '../models/Doctor.js';
import Expense from '../models/Expense.js';
import Session from '../models/Session.js';
import { invalidateExpenseCache } from '../routes/expenses.v2.js';
import { calculateCommissionBatch, classifySessionForCommission } from './commissionRule.service.js';
import { resolveSessionFinancialValue } from '../utils/resolveSessionFinancialValue.js';

// Regra mais comum da equipe (09/11/2026: particular/pacote 65, convênio 50, liminar 65).
// Só para SIMULAR quanto custaria por comissão um profissional de salário fixo que
// não tem regra própria. Nunca é usada para gerar repasse.
const STANDARD_SIMULATION_RULES = [
  { serviceType: 'session', billingType: 'particular', commissionType: 'fixed', value: 65, active: true },
  { serviceType: 'session', billingType: 'convenio', commissionType: 'fixed', value: 50, active: true },
  { serviceType: 'session', billingType: 'liminar', commissionType: 'fixed', value: 65, active: true }
];

// Faturamento por origem + pacientes distintos das sessões completadas
function summarizeRevenue(sessions) {
  const byOrigin = { convenio: 0, pacote: 0, liminar: 0, avulso: 0 };
  const sessionsByOrigin = { convenio: 0, pacote: 0, liminar: 0, avulso: 0 };
  const patients = new Set();
  for (const s of sessions) {
    const value = resolveSessionFinancialValue(s) || s.sessionValue || 0;
    const { billingType } = classifySessionForCommission(s);
    const key = billingType === 'convenio' ? 'convenio'
      : billingType === 'liminar' ? 'liminar'
        : billingType === 'package' ? 'pacote' : 'avulso';
    byOrigin[key] += value;
    sessionsByOrigin[key] += 1;
    const pid = s.patient?._id || s.patient;
    if (pid) patients.add(String(pid));
  }
  for (const k of Object.keys(byOrigin)) byOrigin[k] = Math.round(byOrigin[k] * 100) / 100;
  return { revenueByOrigin: byOrigin, sessionsByOrigin, patientsCount: patients.size };
}

// Cache: 60s por (doctorId, startDate, endDate) — evita N×2 queries em calculateProfissionais
const _commCache = new Map();
const COMM_TTL = 60_000;

// 🔒 Lock em memória para evitar geração concorrente de comissões
let commissionGenerationLock = false;
function _commCacheGet(key) {
    const entry = _commCache.get(key);
    if (entry && Date.now() - entry.ts < COMM_TTL) return entry.data;
    return null;
}
function _commCacheSet(key, data) {
    _commCache.set(key, { data, ts: Date.now() });
    if (_commCache.size > 200) {
        const oldest = _commCache.keys().next().value;
        _commCache.delete(oldest);
    }
}

/**
 * Calcula comissão personalizada por profissional
 *
 * Regras:
 * 1. Usa o motor de regras de comissão (commissionRule.service).
 * 2. Sessões: valor fixo ou percentual por tipo/atendimento.
 * 3. Neuropsicologia: repasse por atendimento realizado no período, inclusive em pacote.
 */
export const calculateDoctorCommission = async (doctorId, startDate, endDate) => {
  const cacheKey = `${doctorId}_${startDate instanceof Date ? startDate.toISOString() : startDate}_${endDate instanceof Date ? endDate.toISOString() : endDate}`;
  const cached = _commCacheGet(cacheKey);
  if (cached) return cached;

  try {
    const doctor = await Doctor.findById(doctorId)
      .select('fullName specialty commissionRules')
      .lean();

    if (!doctor) {
      throw new Error('Profissional não encontrado');
    }

    // 🚨 IMPORTANTE: Buscar APENAS sessões REALMENTE completadas (não canceladas)
    const allSessions = await Session.find({
      doctor: doctorId,
      date: { $gte: startDate, $lte: endDate },
      status: 'completed'
    })
      .populate('package', 'sessionType totalSessions insuranceProvider sessionValue totalValue')
      .populate('insuranceGuide', 'insurance')
      .lean();

    // Filtrar manualmente sessões canceladas (garantia extra)
    const sessions = allSessions.filter(s => {
      if (s.canceledAt && s.canceledAt !== null) return false;
      if (s.status === 'canceled') return false;
      return true;
    });

    const { totalCommission, breakdown, totalProductionBase } = calculateCommissionBatch(doctor, sessions);
    const revenueSummary = summarizeRevenue(sessions);
    const hasOwnRules = (doctor.commissionRules?.rules || []).some(r => r.active !== false);
    const simulatedCommission = hasOwnRules
      ? totalCommission
      : calculateCommissionBatch(
        { specialty: doctor.specialty, commissionRules: { rules: STANDARD_SIMULATION_RULES } },
        sessions
      ).totalCommission;

    const isNeuropediatria = ['neuroped', 'neuropediatria'].includes(
      (doctor.specialty || '').toLowerCase().trim()
    );

    const effectiveRate = totalProductionBase > 0
      ? parseFloat(((totalCommission / totalProductionBase) * 100).toFixed(1))
      : 0;

    const result = {
      doctorId,
      doctorName: doctor.fullName,
      totalCommission,
      totalSessions: sessions.length,
      breakdown,
      productionBase: totalProductionBase,
      ...revenueSummary,
      simulatedCommission,
      simulatedWithStandardRules: !hasOwnRules,
      commissionRate: effectiveRate,
      period: { startDate, endDate },
      commissionModel: isNeuropediatria ? 'neuropediatria_percentage' : 'rule_based',
      lastUpdated: new Date().toISOString()
    };
    _commCacheSet(cacheKey, result);
    return result;

  } catch (error) {
    console.error(`Erro ao calcular comissão do Dr. ${doctorId}:`, error);
    throw error;
  }
};

/**
 * Forma de remuneração efetiva do profissional.
 * Só é "fixo" quando model = fixed_monthly E há valor > 0; senão, segue por comissão.
 */
export function resolveCompensation(doctor) {
  const c = doctor?.compensation || {};
  const fixed = Number(c.fixedMonthlyAmount) || 0;
  const isFixed = c.model === 'fixed_monthly' && fixed > 0;
  return { model: isFixed ? 'fixed_monthly' : 'commission', fixedMonthlyAmount: isFixed ? fixed : 0 };
}

function resolveMonthPeriod(month, year) {
  const now = moment.tz('America/Sao_Paulo');
  const target = (month && year)
    ? moment.tz({ year, month: month - 1 }, 'America/Sao_Paulo')
    : now.clone().subtract(1, 'month');
  return {
    target,
    startDate: target.clone().startOf('month').toDate(),
    endDate: target.clone().endOf('month').toDate(),
    monthRef: target.format('MMM/YYYY')
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Faturamento x custo por profissional no mês (somente leitura).
 * Faturamento = produção das sessões completadas (mesma base da comissão:
 * resolveSessionFinancialValue). Custo = salário fixo mensal, se houver; senão a
 * comissão calculada pelas regras. Não grava nada.
 */
export const buildProfessionalPerformance = async (month, year) => {
  const { startDate, endDate, monthRef } = resolveMonthPeriod(month, year);

  const doctors = await Doctor.find({ active: true })
    .select('_id fullName specialty compensation')
    .lean();

  const rows = [];
  for (const doctor of doctors) {
    const comp = resolveCompensation(doctor);
    const commission = await calculateDoctorCommission(doctor._id, startDate, endDate);
    const revenue = round2(commission.productionBase);
    const sessions = commission.totalSessions;

    // Sem atendimento e sem custo fixo: não tem o que medir
    if (sessions === 0 && comp.model !== 'fixed_monthly') continue;

    const cost = comp.model === 'fixed_monthly' ? comp.fixedMonthlyAmount : round2(commission.totalCommission);
    const result = round2(revenue - cost);
    rows.push({
      doctorId: String(doctor._id),
      doctorName: doctor.fullName,
      specialty: doctor.specialty || null,
      compensationModel: comp.model,
      fixedMonthlyAmount: comp.fixedMonthlyAmount,
      sessions,
      revenue,
      commission: round2(commission.totalCommission),
      cost,
      result,
      costShare: revenue > 0 ? round2((cost / revenue) * 100) : null,
      ticketAverage: sessions > 0 ? round2(revenue / sessions) : 0,
      patientsCount: commission.patientsCount || 0,
      revenueByOrigin: commission.revenueByOrigin,
      // Quanto custaria por comissão (regras próprias; sem regra, regra padrão da equipe)
      commissionIfPerSession: round2(commission.simulatedCommission),
      simulatedWithStandardRules: !!commission.simulatedWithStandardRules,
      // Profissional por comissão sem nenhuma regra: não entra no "Gerar comissões"
      missingCommissionRules: comp.model === 'commission' && sessions > 0 && commission.totalCommission === 0
    });
  }

  rows.sort((a, b) => b.revenue - a.revenue);
  const totals = rows.reduce((acc, r) => ({
    sessions: acc.sessions + r.sessions,
    revenue: round2(acc.revenue + r.revenue),
    cost: round2(acc.cost + r.cost),
    result: round2(acc.result + r.result)
  }), { sessions: 0, revenue: 0, cost: 0, result: 0 });

  return {
    period: { startDate, endDate, monthRef },
    rows,
    totals: { ...totals, costShare: totals.revenue > 0 ? round2((totals.cost / totals.revenue) * 100) : null }
  };
};

/**
 * Salário fixo: cria (ou recria, se pendente e regenerate) a despesa de folha do mês
 * com o faturamento que o profissional gerou, para comparar custo x resultado.
 * Idempotente pela description. Se já existe outra despesa de folha do mesmo
 * profissional no mês (lançada à mão ou por despesa fixa), não cria — evita pagar 2x.
 */
async function upsertFixedSalaryExpense({ doctor, comp, commission, target, monthRef, regenerate, session }) {
  const description = `${doctor.fullName} - ${monthRef} (salário fixo)`;
  const monthStart = target.clone().startOf('month').format('YYYY-MM-DD');
  const monthEnd = target.clone().endOf('month').format('YYYY-MM-DD');
  const revenue = round2(commission.productionBase);
  const base = {
    doctor: doctor.fullName,
    reason: 'fixed_salary',
    sessions: commission.totalSessions,
    revenueGenerated: revenue,
    fixedMonthlyAmount: comp.fixedMonthlyAmount
  };

  const existing = await Expense.findOne({
    category: 'payroll',
    relatedDoctor: doctor._id,
    description,
    status: { $ne: 'canceled' }
  }).session(session);

  if (existing) {
    if (!regenerate) return { ...base, skipped: true, existingId: existing._id };
    if (existing.status === 'paid') return { ...base, skipped: true, reason: 'already_paid', existingId: existing._id };
    await Expense.deleteOne({ _id: existing._id }, { session });
  } else {
    const otherPayroll = await Expense.findOne({
      category: 'payroll',
      relatedDoctor: doctor._id,
      date: { $gte: monthStart, $lte: monthEnd },
      status: { $ne: 'canceled' }
    }).session(session);
    if (otherPayroll) {
      console.log(`⚠️ ${doctor.fullName} já tem despesa de folha em ${monthRef} (${otherPayroll._id}), não criando o fixo`);
      return { ...base, skipped: true, reason: 'payroll_already_exists', existingId: otherPayroll._id };
    }
  }

  const notes = {
    type: 'fixed_salary_performance',
    revenueGenerated: revenue,
    revenueByOrigin: commission.revenueByOrigin,
    sessionsByOrigin: commission.sessionsByOrigin,
    patientsCount: commission.patientsCount,
    commissionIfPerSession: round2(commission.simulatedCommission),
    simulatedWithStandardRules: !!commission.simulatedWithStandardRules,
    result: round2(revenue - comp.fixedMonthlyAmount)
  };

  const expense = await Expense.create([{
    description,
    category: 'payroll',
    subcategory: 'salary',
    amount: comp.fixedMonthlyAmount,
    date: monthEnd,
    relatedDoctor: doctor._id,
    workPeriod: {
      start: monthStart,
      end: monthEnd,
      sessionsCount: commission.totalSessions,
      revenueGenerated: revenue
    },
    paymentMethod: 'transferencia_bancaria',
    status: 'pending',
    notes: JSON.stringify(notes),
    createdBy: new mongoose.Types.ObjectId('000000000000000000000000'),
    createdByRole: 'system'
  }], { session });

  console.log(`✅ ${doctor.fullName} (fixo): R$ ${comp.fixedMonthlyAmount.toFixed(2)} | faturou R$ ${revenue.toFixed(2)}`);
  return { ...base, expenseId: expense[0]._id, ...notes };
}

/**
 * Gera despesas de comissão para todos os profissionais ativos
 */
export const generateMonthlyCommissions = async (month, year, options = {}) => {
  const { regenerate = false } = options;
  if (commissionGenerationLock) {
    throw new Error('GENERATION_ALREADY_IN_PROGRESS');
  }

  commissionGenerationLock = true;
  const session = await mongoose.startSession();

  try {
    await session.startTransaction();

    const { target, startDate, endDate, monthRef } = resolveMonthPeriod(month, year);

    console.log(`\n💰 Gerando comissões para ${monthRef}`);
    console.log(`📅 Período: ${startDate} até ${endDate}\n`);

    const doctors = await Doctor.find({ active: true })
      .select('_id fullName specialty commissionRules compensation')
      .lean();

    if (doctors.length === 0) {
      await session.abortTransaction();
      return { success: false, message: 'Nenhum profissional ativo' };
    }

    const results = [];

    for (const doctor of doctors) {
      const commission = await calculateDoctorCommission(doctor._id, startDate, endDate);
      const comp = resolveCompensation(doctor);

      // Salário fixo: não gera comissão por sessão (o fixo é despesa fixa/folha),
      // mas entra no retorno com o faturamento para comparação.
      if (comp.model === 'fixed_monthly') {
        const r = await upsertFixedSalaryExpense({ doctor, comp, commission, target, monthRef, regenerate, session });
        results.push(r);
        continue;
      }

      if (commission.totalCommission > 0) {
        // 🛡️ Idempotência: não gera duplicata se já existe comissão para este médico/mês
        const existing = await Expense.findOne({
          category: 'commission',
          relatedDoctor: doctor._id,
          description: `${doctor.fullName} - ${monthRef}`,
          status: { $ne: 'canceled' }
        }).session(session);

        if (existing) {
          if (!regenerate) {
            console.log(`⚠️ Comissão já existe para ${doctor.fullName} - ${monthRef}, ignorando`);
            results.push({ doctor: doctor.fullName, skipped: true, existingId: existing._id });
            continue;
          }

          // 🔒 Comissão já paga é definitiva — nunca cancelar/substituir automaticamente
          if (existing.status === 'paid') {
            console.log(`🔒 Comissão de ${doctor.fullName} - ${monthRef} já está paga, mantendo (não regenerada)`);
            results.push({ doctor: doctor.fullName, skipped: true, reason: 'already_paid', existingId: existing._id });
            continue;
          }

          // ♻️ Regenerar: apaga a despesa desatualizada e recria com os dados
          // atuais de sessões completadas — só a versão nova permanece.
          await Expense.deleteOne(
            { _id: existing._id },
            { session }
          );
          console.log(`♻️ Comissão anterior de ${doctor.fullName} - ${monthRef} apagada, gerando nova`);
        }

        const notes = {
          ...commission.breakdown,
          byInsurance: commission.breakdown.standardSessions.byInsurance
        };

        const expense = await Expense.create([{
          description: `${doctor.fullName} - ${monthRef}`,
          category: 'commission',
          subcategory: 'salary',
          amount: commission.totalCommission,
          date: target.clone().endOf('month').format('YYYY-MM-DD'),
          relatedDoctor: doctor._id,
          workPeriod: {
            start: target.clone().startOf('month').format('YYYY-MM-DD'),
            end: target.clone().endOf('month').format('YYYY-MM-DD'),
            sessionsCount: commission.totalSessions,
            revenueGenerated: round2(commission.productionBase)
          },
          paymentMethod: 'transferencia_bancaria',
          status: 'pending',
          notes: JSON.stringify(notes),
          createdBy: new mongoose.Types.ObjectId('000000000000000000000000'),
          createdByRole: 'system'
        }], { session });

        results.push({
          doctor: doctor.fullName,
          sessions: commission.totalSessions,
          commission: commission.totalCommission,
          revenueGenerated: round2(commission.productionBase),
          breakdown: commission.breakdown,
          expenseId: expense[0]._id
        });

        console.log(`✅ ${doctor.fullName}: R$ ${commission.totalCommission.toFixed(2)}`);
        console.log(`   - Sessões: ${commission.breakdown.standardSessions.count}`);

        // Mostrar por convênio
        for (const [ins, data] of Object.entries(commission.breakdown.standardSessions.byInsurance || {})) {
          console.log(`     • ${ins}: ${data.count} × R$ ${data.rate} = R$ ${data.value}`);
        }

        console.log(`   - Avaliações: ${commission.breakdown.evaluations.count}`);
        console.log(`   - Atendimentos de neuropsicologia: ${commission.breakdown.neuropsychEvaluations.count}, R$ ${commission.breakdown.neuropsychEvaluations.value.toFixed(2)}`);
      }
    }

    await session.commitTransaction();

    // Invalida cache de despesas para que a listagem reflita as novas comissões
    await invalidateExpenseCache();

    const generated = results.filter(r => r.expenseId).length;
    console.log(`\n🎉 Comissões geradas: ${generated}/${doctors.length} profissionais\n`);

    return {
      success: true,
      period: { startDate, endDate, monthRef },
      generated,
      totalDoctors: doctors.length,
      details: results
    };

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Erro ao gerar comissões:', error);
    throw error;
  } finally {
    session.endSession();
    commissionGenerationLock = false;
  }
};

export default { calculateDoctorCommission, generateMonthlyCommissions, buildProfessionalPerformance, resolveCompensation };
