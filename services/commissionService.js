// services/commissionService.js (SUBSTITUIR TUDO)
import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Doctor from '../models/Doctor.js';
import Expense from '../models/Expense.js';
import Session from '../models/Session.js';

/**
 * Calcula comissão personalizada por profissional
 * Regras:
 * 1. Sessões regulares: valor fixo por sessão (ex: R$ 60 ou R$ 65)
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

    // Buscar todas as sessões COMPLETADAS no período
    const sessions = await Session.find({
      doctor: doctorId,
      status: 'completed',
      date: { $gte: startDate, $lte: endDate }
    })
      .populate('package', 'sessionType totalSessions')
      .lean();

    let totalCommission = 0;
    const breakdown = {
      standardSessions: { count: 0, value: 0 },
      evaluations: { count: 0, value: 0 },
      neuropsychEvaluations: { count: 0, value: 0 },
      custom: []
    };

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

      // 🔹 SESSÃO PADRÃO
      const standardValue = doctor.commissionRules?.standardSession || 60;
      breakdown.standardSessions.count++;
      breakdown.standardSessions.value += standardValue;
      totalCommission += standardValue;
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
 * Gera despesas de comissão para todos os profissionais ativos
 */
export const generateMonthlyCommissions = async () => {
  const session = await mongoose.startSession();

  try {
    await session.startTransaction();

    const now = moment.tz('America/Sao_Paulo');
    const lastMonth = now.clone().subtract(1, 'month');
    const startDate = lastMonth.startOf('month').format('YYYY-MM-DD');
    const endDate = lastMonth.endOf('month').format('YYYY-MM-DD');
    const monthRef = lastMonth.format('MMM/YYYY');

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
        const expense = await Expense.create([{
          description: `Comissão ${doctor.fullName} - ${monthRef}`,
          category: 'commission',
          subcategory: 'salary',
          amount: commission.totalCommission,
          date: now.format('YYYY-MM-DD'),
          relatedDoctor: doctor._id,
          workPeriod: {
            start: startDate,
            end: endDate,
            sessionsCount: commission.totalSessions,
            revenueGenerated: 0 // não usado nesse modelo
          },
          paymentMethod: 'transferencia_bancaria',
          status: 'pending',
          notes: JSON.stringify(commission.breakdown, null, 2), // detalhamento
          createdBy: new mongoose.Types.ObjectId('000000000000000000000000')
        }], { session });

        results.push({
          doctor: doctor.fullName,
          sessions: commission.totalSessions,
          commission: commission.totalCommission,
          breakdown: commission.breakdown,
          expenseId: expense[0]._id
        });

        console.log(`✅ ${doctor.fullName}: R$ ${commission.totalCommission.toFixed(2)}`);
        console.log(`   - Sessões padrão: ${commission.breakdown.standardSessions.count} × R$ ${doctor.commissionRules?.standardSession || 60}`);
        console.log(`   - Avaliações: ${commission.breakdown.evaluations.count}`);
        console.log(`   - Neuro completas: ${commission.breakdown.neuropsychEvaluations.count} × R$ ${doctor.commissionRules?.neuropsychEvaluation || 1200}`);
      }
    }

    await session.commitTransaction();

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