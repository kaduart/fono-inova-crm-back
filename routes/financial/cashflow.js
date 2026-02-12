// cashflow.js - VERSÃO CORRIGIDA COMPLETA
import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../../middleware/auth.js';
import Payment from '../../models/Payment.js';
import Expense from '../../models/Expense.js';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

/**
 * @route   GET /api/cashflow/summary
 * @desc    Resumo financeiro + atividade operacional do período
 * @query   ?period=day&date=2026-02-11 OU ?period=month&month=2&year=2026
 */
router.get('/summary', auth, async (req, res) => {
  try {
    const { period = 'month', month, year, date } = req.query;

    let startDateStr, endDateStr;

    // Definir período
    if (period === 'day' && date) {
      startDateStr = date;
      endDateStr = date;
    } else if (period === 'month' && month && year) {
      startDateStr = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      endDateStr = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    } else {
      const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
      startDateStr = today;
      endDateStr = today;
    }

    // Converter para Date objects com timezone BR (crucial para createdAt)
    const startDateTime = moment.tz(startDateStr, TIMEZONE).startOf('day').toDate();
    const endDateTime = moment.tz(endDateStr, TIMEZONE).endOf('day').toDate();

    console.log(`[Cashflow] Período: ${startDateStr} a ${endDateStr}`);
    console.log(`[Cashflow] Buscando createdAt entre: ${startDateTime.toISOString()} e ${endDateTime.toISOString()}`);

    // Queries paralelas otimizadas
    const [
      revenueData,
      expenseData,
      agendamentosCriados,
      pacotesCriados,
      agendamentosRealizados
    ] = await Promise.all([
      // 1. Receitas (pagamentos confirmados)
      Payment.aggregate([
        {
          $match: {
            status: 'paid',
            paymentDate: { $gte: startDateStr, $lte: endDateStr }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 },
            porMetodo: {
              $push: {
                k: '$paymentMethod',
                v: '$amount'
              }
            }
          }
        }
      ]),

      // 2. Despesas
      Expense.aggregate([
        {
          $match: {
            status: 'paid',
            date: { $gte: startDateStr, $lte: endDateStr }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ]),

      // 3. Agendamentos CRIADOS no período (novas entradas no sistema)
      Appointment.find({
        createdAt: { $gte: startDateTime, $lte: endDateTime }
      })
        .populate('patient', 'fullName phoneNumber')
        .populate('doctor', 'fullName specialty')
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),

      // 4. Pacotes CRIADOS no período (novas vendas)
      Package.find({
        createdAt: { $gte: startDateTime, $lte: endDateTime }
      })
        .populate('patient', 'fullName')
        .populate('doctor', 'fullName specialty')
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),

      // 5. Agendamentos REALIZADOS (atendidos) no período
      Appointment.countDocuments({
        date: { $gte: startDateStr, $lte: endDateStr },
        clinicalStatus: 'completed'
      })
    ]);

    const revenue = revenueData[0] || { total: 0, count: 0, porMetodo: [] };
    const expense = expenseData[0] || { total: 0, count: 0 };
    const balance = revenue.total - expense.total;

    // Calcular valores potenciais
    const valorAgendamentos = agendamentosCriados.reduce((sum, apt) => sum + (apt.sessionValue || 0), 0);
    const valorPacotes = pacotesCriados.reduce((sum, pkg) => sum + (pkg.totalValue || 0), 0);

    // Agrupar receita por método de pagamento
    const receitaPorMetodo = {};
    revenue.porMetodo?.forEach(item => {
      receitaPorMetodo[item.k] = (receitaPorMetodo[item.k] || 0) + item.v;
    });

    res.json({
      success: true,
      period: {
        startDate: startDateStr,
        endDate: endDateStr,
        type: period,
        label: period === 'day'
          ? moment(startDateStr).tz(TIMEZONE).format('DD/MM/YYYY')
          : `${startDateStr} a ${endDateStr}`
      },
      financeiro: {
        receitas: {
          total: revenue.total,
          count: revenue.count,
          porMetodo: receitaPorMetodo
        },
        despesas: {
          total: expense.total,
          count: expense.count
        },
        saldo: balance,
        status: balance >= 0 ? 'positive' : 'negative'
      },
      operacional: {
        agendamentosCriados: {
          count: agendamentosCriados.length,
          valorPotencial: valorAgendamentos,
          itens: agendamentosCriados.map(apt => ({
            id: apt._id,
            paciente: apt.patient?.fullName || 'N/A',
            telefone: apt.patient?.phoneNumber,
            profissional: apt.doctor?.fullName || 'N/A',
            especialidade: apt.doctor?.specialty || apt.specialty || 'N/A',
            dataAgendada: apt.date,
            hora: apt.time,
            valor: apt.sessionValue || 0,
            criadoEm: apt.createdAt
          }))
        },
        pacotesCriados: {
          count: pacotesCriados.length,
          valorTotal: valorPacotes,
          itens: pacotesCriados.map(pkg => ({
            id: pkg._id,
            paciente: pkg.patient?.fullName || 'N/A',
            profissional: pkg.doctor?.fullName || 'N/A',
            especialidade: pkg.doctor?.specialty || 'N/A',
            sessoes: pkg.totalSessions,
            valor: pkg.totalValue || 0,
            statusPagamento: pkg.financialStatus,
            criadoEm: pkg.createdAt
          }))
        },
        atendimentosRealizados: agendamentosRealizados,
        conversao: agendamentosCriados.length > 0
          ? ((agendamentosRealizados / agendamentosCriados.length) * 100).toFixed(1)
          : 0
      },
      indicadores: {
        ticketMedio: agendamentosRealizados > 0 ? revenue.total / agendamentosRealizados : 0,
        valorMedioPacote: pacotesCriados.length > 0 ? valorPacotes / pacotesCriados.length : 0,
        eficiencia: balance > 0 ? ((balance / revenue.total) * 100).toFixed(1) : 0
      }
    });

  } catch (error) {
    console.error('[Cashflow] Erro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao calcular fluxo de caixa',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

export default router;