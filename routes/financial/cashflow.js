import express from 'express';
import moment from 'moment-timezone'; // <-- Import ES Module
import { auth } from '../../middleware/auth.js';
import Appointment from '../../models/Appointment.js'; // <-- Importar
import Expense from '../../models/Expense.js';
import Package from '../../models/Package.js'; // <-- Importar
import Payment from '../../models/Payment.js';

const router = express.Router();

/**
 * @route   GET /api/cashflow/summary
 * @desc    Resumo: Receitas - Despesas = Saldo + Atividade do período
 * @query   ?period=day&date=2026-02-11 ou ?period=month&month=2&year=2026
 * @access  Private
 */
router.get('/summary', auth, async (req, res) => {
  try {
    const { period = 'month', month, year, date } = req.query;

    // Definir intervalo
    let startDateStr, endDateStr;

    if (period === 'day' && date) {
      startDateStr = date;
      endDateStr = date;
    } else if (period === 'month' && month && year) {
      startDateStr = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      endDateStr = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    } else {
      const today = new Date().toISOString().split('T')[0];
      startDateStr = today;
      endDateStr = today;
    }

    // Converter para Date com fuso horário Brasil (UTC-3)
    const startDateTime = moment.tz(startDateStr, 'America/Sao_Paulo').startOf('day').toDate();
    const endDateTime = moment.tz(endDateStr, 'America/Sao_Paulo').endOf('day').toDate();

    console.log('Buscando atividade de:', startDateStr, 'até', endDateStr);
    console.log('Intervalo UTC:', startDateTime, 'até', endDateTime);

    // Queries paralelas
    const [revenueData, expenseData, agendamentosCriados, pacotesCriados] = await Promise.all([
      // Receitas (pagamentos confirmados no período)
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
            count: { $sum: 1 }
          }
        }
      ]),

      // Despesas
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

      // Agendamentos CRIADOS no período (busca por createdAt)
      Appointment.find({
        createdAt: { $gte: startDateTime, $lte: endDateTime }
      })
        .populate('patient', 'fullName')
        .populate('doctor', 'fullName specialty')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),

      // Pacotes CRIADOS no período (busca por createdAt)
      Package.find({
        createdAt: { $gte: startDateTime, $lte: endDateTime }
      })
        .populate('patient', 'fullName')
        .populate('doctor', 'fullName specialty')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
    ]);

    const revenue = revenueData[0] || { total: 0, count: 0 };
    const expense = expenseData[0] || { total: 0, count: 0 };
    const balance = revenue.total - expense.total;

    // Calcular valores
    const valorAgendamentos = agendamentosCriados.reduce((sum, apt) => sum + (apt.sessionValue || 0), 0);
    const valorPacotes = pacotesCriados.reduce((sum, pkg) => sum + (pkg.totalValue || 0), 0);

    res.json({
      success: true,
      period: { startDate: startDateStr, endDate: endDateStr, type: period },
      data: {
        revenue: {
          total: revenue.total,
          count: revenue.count
        },
        expenses: {
          total: expense.total,
          count: expense.count
        },
        balance,
        balanceStatus: balance >= 0 ? 'positive' : 'negative',

        atividade: {
          agendamentosCriados: {
            count: agendamentosCriados.length,
            valorPotencial: valorAgendamentos,
            itens: agendamentosCriados.map(apt => ({
              id: apt._id,
              paciente: apt.patient?.fullName || 'N/A',
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
            valorPotencial: valorPacotes,
            itens: pacotesCriados.map(pkg => ({
              id: pkg._id,
              paciente: pkg.patient?.fullName || 'N/A',
              profissional: pkg.doctor?.fullName || 'N/A',
              especialidade: pkg.doctor?.specialty || 'N/A',
              sessoes: pkg.totalSessions,
              valor: pkg.totalValue || 0,
              criadoEm: pkg.createdAt
            }))
          },
          movimentacaoTotal: valorAgendamentos + valorPacotes + revenue.total
        }
      }
    });

  } catch (error) {
    console.error('Erro ao calcular fluxo de caixa:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao calcular fluxo de caixa',
      error: error.message
    });
  }
});

export default router;