/**
 * 🔍 Health Check de Migração V1 → V2
 * 
 * Endpoint para monitorar estado da migração e decidir quando desativar V1
 */

import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/health/migration
 * 
 * Retorna métricas de migração V1 → V2
 */
router.get('/migration', auth, async (req, res) => {
  try {
    const Package = mongoose.model('Package');
    const Appointment = mongoose.model('Appointment');
    
    // 📊 Packages - breakdown por versão
    const packageStats = await Package.aggregate([
      {
        $group: {
          _id: {
            $cond: [
              { $ifNull: ['$model', false] },
              'v2',
              'v1'
            ]
          },
          count: { $sum: 1 },
          active: {
            $sum: {
              $cond: [
                { $in: ['$status', ['active', 'in-progress']] },
                1,
                0
              ]
            }
          },
          completed: {
            $sum: {
              $cond: [
                { $eq: ['$status', 'completed'] },
                1,
                0
              ]
            }
          }
        }
      }
    ]);
    
    // Formata resultado
    const v1Stats = packageStats.find(s => s._id === 'v1') || { count: 0, active: 0, completed: 0 };
    const v2Stats = packageStats.find(s => s._id === 'v2') || { count: 0, active: 0, completed: 0 };
    
    // 📊 Appointments vinculados a packages V1
    const appointmentsWithV1Packages = await Appointment.countDocuments({
      package: { $exists: true },
      $or: [
        { 'package.model': { $exists: false } },
        { package: { $in: await Package.find({ model: { $exists: false } }).distinct('_id') } }
      ]
    });
    
    // 📊 Packages V1 com atividade recente (últimos 30 dias)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const v1RecentActivity = await Package.countDocuments({
      model: { $exists: false },
      $or: [
        { updatedAt: { $gte: thirtyDaysAgo } },
        { lastPaymentAt: { $gte: thirtyDaysAgo } }
      ]
    });
    
    // 🎯 Recomendação de ação
    let recommendation = 'UNKNOWN';
    let canDisableV1 = false;
    
    if (v1Stats.active === 0 && v1Stats.count > 0) {
      recommendation = 'READY_FOR_CLEANUP';
      canDisableV1 = true;
    } else if (v1Stats.active === 0 && v1Stats.count === 0) {
      recommendation = 'V1_FULLY_MIGRATED';
      canDisableV1 = true;
    } else if (v1Stats.active > 0 && v1Stats.active <= 5) {
      recommendation = 'ALMOST_READY';
      canDisableV1 = false;
    } else if (v1Stats.active > 5) {
      recommendation = 'WAIT';
      canDisableV1 = false;
    }
    
    // 📈 Percentual de migração
    const totalPackages = v1Stats.count + v2Stats.count;
    const migrationPercent = totalPackages > 0 
      ? Math.round((v2Stats.count / totalPackages) * 100)
      : 100;
    
    res.json({
      success: true,
      data: {
        summary: {
          totalPackages,
          migrationPercent,
          canDisableV1,
          recommendation
        },
        v1: {
          total: v1Stats.count,
          active: v1Stats.active,
          completed: v1Stats.completed,
          recentActivity: v1RecentActivity,
          appointmentsLinked: appointmentsWithV1Packages,
          riskLevel: v1Stats.active > 10 ? 'HIGH' : v1Stats.active > 0 ? 'MEDIUM' : 'LOW'
        },
        v2: {
          total: v2Stats.count,
          active: v2Stats.active,
          completed: v2Stats.completed
        },
        criteria: {
          canDisableV1When: {
            v1ActivePackages: 0,
            v1RecentActivity: 0,
            allExplanation: 'Quando não houver mais packages V1 ativos nem atividade recente'
          }
        }
      },
      meta: {
        version: 'v2',
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('[Health Migration] Erro:', error);
    res.status(500).json({
      success: false,
      errorCode: 'MIGRATION_CHECK_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/health/migration/packages-v1
 * 
 * Lista packages V1 ainda ativos (para ação manual)
 */
router.get('/migration/packages-v1', auth, async (req, res) => {
  try {
    const Package = mongoose.model('Package');
    const { limit = 50, page = 1 } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Busca packages V1 (sem model) - prioriza ativos
    const packages = await Package.find({ model: { $exists: false } })
      .sort({ status: 1, updatedAt: -1 }) // Ativos primeiro, depois por atualização
      .skip(skip)
      .limit(parseInt(limit))
      .populate('patient', 'fullName')
      .lean();
    
    const total = await Package.countDocuments({ model: { $exists: false } });
    
    // Formata para resposta
    const formatted = packages.map(pkg => ({
      _id: pkg._id,
      status: pkg.status,
      patientName: pkg.patient?.fullName || 'Desconhecido',
      totalSessions: pkg.totalSessions,
      sessionsDone: pkg.sessionsDone,
      totalValue: pkg.totalValue,
      totalPaid: pkg.totalPaid,
      financialStatus: pkg.financialStatus,
      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt,
      actionNeeded: pkg.status === 'active' ? 'MIGRATE_OR_CLOSE' : 'CAN_ARCHIVE'
    }));
    
    res.json({
      success: true,
      data: {
        packages: formatted,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit))
        }
      },
      meta: {
        version: 'v2',
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('[Health Migration] Erro:', error);
    res.status(500).json({
      success: false,
      errorCode: 'MIGRATION_LIST_FAILED',
      message: error.message
    });
  }
});

export default router;
