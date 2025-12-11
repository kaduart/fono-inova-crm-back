// routes/cashflowRoutes.js (NOVO ARQUIVO)
import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../../middleware/auth.js';
import Payment from '../../models/Payment.js';
import Expense from '../../models/Expense.js';

const router = express.Router();

/**
 * @route   GET /api/cashflow/summary
 * @desc    Resumo: Receitas - Despesas = Saldo
 * @query   ?period=month&month=11&year=2024
 * @access  Private (admin/secretary)
 */
router.get('/summary', auth, async (req, res) => {
  try {
    const { period = 'month', month, year } = req.query;
    
    // Definir intervalo
    let startDate, endDate;
    const now = new Date();
    
    if (period === 'month' && month && year) {
      startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    } else {
      // Default: mês atual
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();
      startDate = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
      const lastDay = new Date(currentYear, currentMonth, 0).getDate();
      endDate = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${lastDay}`;
    }
    
    // Queries paralelas
    const [revenueData, expenseData] = await Promise.all([
      Payment.aggregate([
        {
          $match: {
            status: 'paid',
            paymentDate: { $gte: startDate, $lte: endDate }
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
      
      Expense.aggregate([
        {
          $match: {
            status: 'paid',
            date: { $gte: startDate, $lte: endDate }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);
    
    const revenue = revenueData[0] || { total: 0, count: 0 };
    const expense = expenseData[0] || { total: 0, count: 0 };
    const balance = revenue.total - expense.total;
    
    res.json({
      success: true,
      period: { startDate, endDate },
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
        balanceStatus: balance >= 0 ? 'positive' : 'negative'
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