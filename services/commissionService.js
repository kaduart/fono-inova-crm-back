// services/commissionService.js
import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Doctor from '../models/Doctor.js';
import Expense from '../models/Expense.js';
import Session from '../models/Session.js';
import { expenseCache } from '../routes/expenses.v2.js';

/**
 * Calcula comissão personalizada por profissional
 * Regras:
 * 1. Sessões regulares: valor fixo por sessão (ex: R$ 60) ou específico por convênio (ex: Unimed = R$ 50)
 * 2. Avaliação neuropsicológica: R$ 1.200 ao completar 10 sessões
 * 3. Outros tipos: conforme customRules do profissional
 */
export const calculateDoctorCommission = async (doctorId, startDate, endDate) => {
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
      // Excluir se tem canceledAt preenchido
      if (s.canceledAt && s.canceledAt !== null) {
        return false;
      }
      // Excluir se status for canceled (redundante mas seguro)
      if (s.status === 'canceled') {
        return false;
      }
      return true;
    });
    
    let totalCommission = 0;
    const breakdown = {
      standardSessions: { count: 0, value: 0, byInsurance: {} },
      evaluations: { count: 0, value: 0 },
      neuropsychEvaluations: { count: 0, value: 0 },
      custom: []
    };

    // 🔹 NEUROPEDIATRIA: modelo percentual — clínica retém 20%, profissional recebe 80%
    const isNeuropediatria = ['neuroped', 'neuropediatria'].includes(
      (doctor.specialty || '').toLowerCase().trim()
    );

    if (isNeuropediatria) {
      for (const s of sessions) {
        const valor = s.sessionValue || 0;
        if (valor <= 0) continue;
        const doctorShare = Math.round(valor * 0.80 * 100) / 100;
        breakdown.standardSessions.count++;
        breakdown.standardSessions.value += doctorShare;
        totalCommission += doctorShare;

        const insuranceKey = getInsuranceName(s) || 'particular';
        if (!breakdown.standardSessions.byInsurance[insuranceKey]) {
          breakdown.standardSessions.byInsurance[insuranceKey] = { count: 0, value: 0, rate: '80%' };
        }
        breakdown.standardSessions.byInsurance[insuranceKey].count++;
        breakdown.standardSessions.byInsurance[insuranceKey].value += doctorShare;
      }

      return {
        doctorId,
        doctorName: doctor.fullName,
        totalCommission,
        totalSessions: sessions.length,
        breakdown,
        period: { startDate, endDate },
        commissionModel: 'neuropediatria_percentage'
      };
    }

    // Agrupar avaliações neuropsicológicas por pacote (para contar 10 sessões)
    const neuropsychPackages = new Map();

    for (const session of sessions) {
      const sessionType = session.sessionType || session.package?.sessionType;

      // 🔹 AVALIAÇÃO NEUROPSICOLÓGICA (acumula por pacote)
      if (sessionType === 'neuropsych_evaluation') {
        const pkgId = session.package?._id?.toString();

        if (pkgId) {
          if (!neuropsychPackages.has(pkgId)) {
            neuropsychPackages.set(pkgId, {
              completedSessions: 0,
              totalSessions: session.package?.totalSessions || 10
            });
          }
          neuropsychPackages.get(pkgId).completedSessions++;
        }
        continue; // Processa depois
      }

      // 🔹 AVALIAÇÃO REGULAR
      if (sessionType === 'evaluation' || session.serviceType === 'evaluation') {
        const evalValue = doctor.commissionRules?.evaluationSession || doctor.commissionRules?.standardSession || 60;
        breakdown.evaluations.count++;
        breakdown.evaluations.value += evalValue;
        totalCommission += evalValue;
        continue;
      }

      // 🔹 SESSÃO PADRÃO - Verificar convênio
      const insuranceName = getInsuranceName(session);
      
      // Verificar se tem regra específica para este convênio
      const byInsuranceRules = doctor.commissionRules?.byInsurance || {};
      const insuranceValue = byInsuranceRules[insuranceName?.toLowerCase()];
      
      // Usar valor do convênio se existir, senão usar valor padrão
      const sessionValue = insuranceValue || doctor.commissionRules?.standardSession || 60;
      
      breakdown.standardSessions.count++;
      breakdown.standardSessions.value += sessionValue;
      totalCommission += sessionValue;

      // Registrar por convênio
      const insuranceKey = insuranceName || 'particular';
      if (!breakdown.standardSessions.byInsurance[insuranceKey]) {
        breakdown.standardSessions.byInsurance[insuranceKey] = {
          count: 0,
          value: 0,
          rate: insuranceValue || doctor.commissionRules?.standardSession || 60
        };
      }
      breakdown.standardSessions.byInsurance[insuranceKey].count++;
      breakdown.standardSessions.byInsurance[insuranceKey].value += sessionValue;
    }

    // 🔹 PROCESSAR AVALIAÇÕES NEUROPSICOLÓGICAS COMPLETAS
    const neuropsychValue = doctor.commissionRules?.neuropsychEvaluation || 1200;

    for (const [pkgId, data] of neuropsychPackages.entries()) {
      if (data.completedSessions >= data.totalSessions) {
        breakdown.neuropsychEvaluations.count++;
        breakdown.neuropsychEvaluations.value += neuropsychValue;
        totalCommission += neuropsychValue;
      }
    }

    return {
      doctorId,
      doctorName: doctor.fullName,
      totalCommission,
      totalSessions: sessions.length,
      breakdown,
      period: { startDate, endDate }
    };

  } catch (error) {
    console.error(`Erro ao calcular comissão do Dr. ${doctorId}:`, error);
    throw error;
  }
};

/**
 * Extrai o nome do convênio da sessão
 */
function getInsuranceName(session) {
  // Prioridade 1: insuranceGuide.populated
  if (session.insuranceGuide?.insurance) {
    return session.insuranceGuide.insurance;
  }
  
  // Prioridade 2: package.insuranceProvider
  if (session.package?.insuranceProvider) {
    return session.package.insuranceProvider;
  }
  
  // Prioridade 3: paymentMethod
  if (session.paymentMethod === 'convenio') {
    return 'convenio';
  }
  
  return null; // Particular
}

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
