// services/commissionService.js
import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Doctor from '../models/Doctor.js';
import Expense from '../models/Expense.js';
import Session from '../models/Session.js';
import { expenseCache } from '../routes/expenses.v2.js';
import { calculateCommissionBatch } from './commissionRule.service.js';

// Cache: 60s por (doctorId, startDate, endDate) — evita N×2 queries em calculateProfissionais
const _commCache = new Map();
const COMM_TTL = 60_000;
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
 * 2. Mantém fallback para campos legados de Doctor.commissionRules.
 * 3. Sessões regulares: valor fixo ou percentual por tipo/atendimento.
 * 4. Avaliação neuropsicológica: valor ao completar N sessões.
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
      .populate('package', 'sessionType totalSessions insuranceProvider')
      .populate('insuranceGuide', 'insurance')
      .lean();

    // Filtrar manualmente sessões canceladas (garantia extra)
    const sessions = allSessions.filter(s => {
      if (s.canceledAt && s.canceledAt !== null) return false;
      if (s.status === 'canceled') return false;
      return true;
    });

    const { totalCommission, breakdown } = calculateCommissionBatch(doctor, sessions);

    const isNeuropediatria = ['neuroped', 'neuropediatria'].includes(
      (doctor.specialty || '').toLowerCase().trim()
    );

    const result = {
      doctorId,
      doctorName: doctor.fullName,
      totalCommission,
      totalSessions: sessions.length,
      breakdown,
      period: { startDate, endDate },
      commissionModel: isNeuropediatria ? 'neuropediatria_percentage' : 'rule_based'
    };
    _commCacheSet(cacheKey, result);
    return result;

  } catch (error) {
    console.error(`Erro ao calcular comissão do Dr. ${doctorId}:`, error);
    throw error;
  }
};

/**
 * Gera despesas de comissão para todos os profissionais ativos
 */
export const generateMonthlyCommissions = async (month, year) => {
  const session = await mongoose.startSession();

  try {
    await session.startTransaction();

    const now = moment.tz('America/Sao_Paulo');
    const target = (month && year)
      ? moment.tz({ year, month: month - 1 }, 'America/Sao_Paulo')
      : now.clone().subtract(1, 'month');
    const startDate = target.clone().startOf('month').toDate();
    const endDate = target.clone().endOf('month').toDate();
    const monthRef = target.format('MMM/YYYY');

    console.log(`\n💰 Gerando comissões para ${monthRef}`);
    console.log(`📅 Período: ${startDate} até ${endDate}\n`);

    const doctors = await Doctor.find({ active: true })
      .select('_id fullName specialty commissionRules')
      .lean();

    if (doctors.length === 0) {
      await session.abortTransaction();
      return { success: false, message: 'Nenhum profissional ativo' };
    }

    const results = [];

    for (const doctor of doctors) {
      const commission = await calculateDoctorCommission(doctor._id, startDate, endDate);

      if (commission.totalCommission > 0) {
        // 🛡️ Idempotência: não gera duplicata se já existe comissão para este médico/mês
        const existing = await Expense.findOne({
          category: 'commission',
          relatedDoctor: doctor._id,
          description: `${doctor.fullName} - ${monthRef}`
        }).session(session);

        if (existing) {
          console.log(`⚠️ Comissão já existe para ${doctor.fullName} - ${monthRef}, ignorando`);
          results.push({ doctor: doctor.fullName, skipped: true, existingId: existing._id });
          continue;
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
            revenueGenerated: 0
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
        console.log(`   - Neuro completas: ${commission.breakdown.neuropsychEvaluations.count} × R$ ${doctor.commissionRules?.neuropsychEvaluation || 1200}`);
      }
    }

    await session.commitTransaction();

    // Invalida cache de despesas para que a listagem reflita as novas comissões
    expenseCache.flushAll();

    console.log(`\n🎉 Comissões geradas: ${results.length}/${doctors.length} profissionais\n`);

    return {
      success: true,
      period: { startDate, endDate, monthRef },
      generated: results.length,
      totalDoctors: doctors.length,
      details: results
    };

  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Erro ao gerar comissões:', error);
    throw error;
  } finally {
    session.endSession();
  }
};

export default { calculateDoctorCommission, generateMonthlyCommissions };
