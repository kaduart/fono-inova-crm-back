/**
 * 🚀 Admin Dashboard V2 API - Otimizado com Cache
 * 
 * Endpoints específicos para o Admin Dashboard com:
 * - Cache Redis (5 minutos)
 * - Lazy loading (não carrega tudo de uma vez)
 * - Resumos em vez de listas completas
 */

import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import { dashboardCache } from '../services/adminDashboardCacheService.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';

const router = express.Router();

/**
 * GET /api/v2/admin/dashboard/payments-summary
 * 
 * Retorna resumo dos pagamentos (não a lista completa)
 * Muito mais rápido que /api/payments
 */
router.get('/payments-summary', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const cacheKey = `payments-summary:${startDate || 'all'}:${endDate || 'all'}`;
    
    const data = await dashboardCache.getOrSet(cacheKey, async () => {
      const matchStage = {};
      
      if (startDate && endDate) {
        matchStage.paymentDate = {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        };
      }
      
      // Aggregation para resumo (muito mais rápido)
      const [totals, recent] = await Promise.all([
        // Totais por status
        Payment.aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 },
              total: { $sum: '$amount' }
            }
          }
        ]),
        
        // Últimos 5 pagamentos (só os campos necessários)
        Payment.find(matchStage)
          .select('amount status paymentDate patient')
          .populate('patient', 'fullName')
          .sort({ createdAt: -1 })
          .limit(5)
          .lean()
      ]);
      
      return {
        totals: totals.reduce((acc, t) => {
          acc[t._id] = { count: t.count, total: t.total };
          return acc;
        }, {}),
        recent,
        count: totals.reduce((sum, t) => sum + t.count, 0)
      };
    }, 300);
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('[AdminDashboardV2] Erro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v2/admin/dashboard/overview
 * 
 * Overview completo do dashboard (cacheado)
 * Substitui /api/dashboard/overview
 */
router.get('/overview', auth, async (req, res) => {
  try {
    const cacheKey = 'admin-overview';
    
    // 🔥 OTIMIZAÇÃO: TTL aumentado pra 10min + stale-while-revalidate
    const data = await dashboardCache.getOrSet(cacheKey, async () => {
      const today = new Date();
      const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      
      // 🔥 OTIMIZAÇÃO: Contagens otimizadas
      const [
        totalPatients,
        todaySessions,
        monthRevenue,
        pendingPayments
      ] = await Promise.all([
        Patient.estimatedDocumentCount(), // ⚡ OK: contagem geral sem filtro
        Session.countDocuments({
          date: {
            $gte: new Date(today.setHours(0, 0, 0, 0)),
            $lte: new Date(today.setHours(23, 59, 59, 999))
          }
        }),
        Payment.aggregate([
          {
            $match: {
              status: 'paid',
              paymentDate: { $gte: startOfMonth, $lte: endOfMonth }
            }
          },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]).limit(1), // 🔥 Limita resultado
        Payment.countDocuments({ status: 'pending' }).limit(1000) // 🔥 Limita count
      ]);
      
      return {
        patients: { total: totalPatients },
        sessions: { today: todaySessions },
        revenue: { month: monthRevenue[0]?.total || 0 },
        payments: { pending: pendingPayments },
        updatedAt: new Date()
      };
    }, 600); // 🔥 10 minutos de TTL
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('[AdminDashboardV2] Erro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v2/admin/dashboard/quick-stats
 * 
 * Stats rápidas para cards do dashboard
 */
router.get('/quick-stats', auth, async (req, res) => {
  try {
    const cacheKey = 'quick-stats';
    
    const data = await dashboardCache.getOrSet(cacheKey, async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      const [
        todayAppointments,
        pendingPayments,
        monthRevenue
      ] = await Promise.all([
        Appointment.countDocuments({
          date: { $gte: today, $lt: tomorrow }
        }),
        Payment.countDocuments({ status: 'pending' }),
        Payment.aggregate([
          {
            $match: {
              status: 'paid',
              createdAt: { $gte: new Date(today.getFullYear(), today.getMonth(), 1) }
            }
          },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      ]);
      
      return {
        todayAppointments,
        pendingPayments,
        monthRevenue: monthRevenue[0]?.total || 0
      };
    }, 300);
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('[AdminDashboardV2] Erro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
