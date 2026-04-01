// back/routes/patient.v2.debug.js
/**
 * Debug Routes - Patients V2
 * 
 * Endpoints internos para auditoria e validação da projeção.
 * NÃO devem ser expostos em produção (ou com auth estrita).
 */

import express from 'express';
import mongoose from 'mongoose';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { formatSuccess, formatError } from '../utils/apiMessages.js';
import Patient from '../models/Patient.js';
import PatientsView from '../models/PatientsView.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';
import PatientBalance from '../models/PatientBalance.js';
import { buildPatientView } from '../domains/clinical/services/patientProjectionService.js';
import { createContextLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createContextLogger('PatientV2Debug');

// ============================================
// MIDDLEWARE: Admin only em produção
// ============================================

const requireAdmin = (req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.user?.role !== 'admin') {
    return res.status(403).json(formatError('Acesso restrito a administradores', 403));
  }
  next();
};

// ============================================
// DEBUG: Comparação View vs Real
// ============================================

/**
 * GET /api/v2/patients/debug/:id
 * 
 * Retorna:
 * - View atual (do banco)
 * - View recalculada (fresh)
 * - Diff entre elas
 * - Diagnóstico de inconsistências
 */
router.get('/debug/:id', flexibleAuth, requireAdmin, async (req, res) => {
  const startTime = Date.now();
  const { id } = req.params;
  const correlationId = `debug_${Date.now()}`;
  
  logger.info(`[${correlationId}] 🔍 Debug patient`, { patientId: id });
  
  try {
    // 1. Busca view atual
    const currentView = await PatientsView.findOne({ patientId: id }).lean();
    
    // 2. Busca dados crus do domínio
    const [patient, appointments, payments, packages, balance] = await Promise.all([
      Patient.findById(id).lean(),
      Appointment.find({ patient: id }).lean(),
      Payment.find({ patient: id }).lean(),
      Package.find({ patient: id }).lean(),
      PatientBalance.findOne({ patient: id }).lean()
    ]);
    
    if (!patient) {
      return res.status(404).json(formatError('Paciente não encontrado', 404));
    }
    
    // 3. Recalcula view do zero
    const freshView = await buildPatientView(id, { 
      correlationId,
      force: true 
    });
    
    // 4. Calcula diff
    const diff = calculateDiff(currentView, freshView);
    
    // 5. Diagnóstico
    const diagnosis = {
      viewExists: !!currentView,
      isConsistent: diff.length === 0,
      staleness: currentView ? calculateStaleness(currentView) : null,
      issues: []
    };
    
    if (!currentView) {
      diagnosis.issues.push('View não existe (nunca foi criada ou foi deletada)');
    } else if (diff.length > 0) {
      diagnosis.issues.push(`View inconsistente: ${diff.length} campos divergentes`);
    }
    
    if (currentView?.snapshot?.isStale) {
      diagnosis.issues.push('View está stale (desatualizada)');
    }
    
    const duration = Date.now() - startTime;
    
    logger.info(`[${correlationId}] ✅ Debug completed`, {
      patientId: id,
      isConsistent: diagnosis.isConsistent,
      duration: `${duration}ms`
    });
    
    return res.json(formatSuccess({
      patient: {
        id: patient._id.toString(),
        fullName: patient.fullName,
        createdAt: patient.createdAt
      },
      currentView: currentView || null,
      freshView: {
        patientId: freshView.patientId,
        fullName: freshView.fullName,
        stats: freshView.stats,
        lastAppointment: freshView.lastAppointment,
        nextAppointment: freshView.nextAppointment,
        snapshot: freshView.snapshot
      },
      diff: {
        count: diff.length,
        fields: diff
      },
      diagnosis,
      rawData: {
        appointmentsCount: appointments.length,
        paymentsCount: payments.length,
        packagesCount: packages.length,
        hasBalance: !!balance
      },
      meta: {
        duration: `${duration}ms`,
        correlationId
      }
    }));
    
  } catch (error) {
    logger.error(`[${correlationId}] ❌ Debug error`, { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * POST /api/v2/patients/debug/:id/fix
 * 
 * Corrige view inconsistente (rebuild forçado).
 */
router.post('/debug/:id/fix', flexibleAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const correlationId = `fix_${Date.now()}`;
  
  logger.info(`[${correlationId}] 🔧 Fixing view`, { patientId: id });
  
  try {
    const oldView = await PatientsView.findOne({ patientId: id }).lean();
    
    const newView = await buildPatientView(id, { 
      force: true,
      correlationId
    });
    
    if (!newView) {
      return res.status(404).json(formatError('Paciente não encontrado', 404));
    }
    
    const diff = calculateDiff(oldView, newView);
    
    logger.info(`[${correlationId}] ✅ View fixed`, {
      patientId: id,
      oldVersion: oldView?.snapshot?.version,
      newVersion: newView.snapshot.version,
      changes: diff.length
    });
    
    return res.json(formatSuccess({
      patientId: id,
      wasFixed: true,
      oldVersion: oldView?.snapshot?.version,
      newVersion: newView.snapshot.version,
      changes: diff,
      view: {
        stats: newView.stats,
        snapshot: newView.snapshot
      }
    }, 'View reconstruída com sucesso'));
    
  } catch (error) {
    logger.error(`[${correlationId}] ❌ Fix error`, { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

// ============================================
// DEBUG: Auditoria em Massa
// ============================================

/**
 * GET /api/v2/patients/debug/audit/consistency
 * 
 * Audita todas as views e retorna inconsistências.
 */
router.get('/debug/audit/consistency', flexibleAuth, requireAdmin, async (req, res) => {
  const startTime = Date.now();
  const { sample = 100 } = req.query;
  
  logger.info(`🔍 Starting consistency audit`, { sampleSize: sample });
  
  try {
    const results = {
      totalChecked: 0,
      consistent: 0,
      inconsistent: 0,
      missing: 0,
      stale: 0,
      issues: []
    };
    
    // Pega amostra de pacientes
    const patients = await Patient.find({}, '_id fullName')
      .limit(parseInt(sample))
      .lean();
    
    for (const patient of patients) {
      results.totalChecked++;
      
      const view = await PatientsView.findOne({ patientId: patient._id }).lean();
      
      if (!view) {
        results.missing++;
        results.issues.push({
          patientId: patient._id.toString(),
          patientName: patient.fullName,
          issue: 'missing_view'
        });
        continue;
      }
      
      if (view.snapshot?.isStale) {
        results.stale++;
      }
      
      // Recalcula e compara (amostragem: só 10% para performance)
      if (Math.random() < 0.1) {
        const freshView = await buildPatientView(patient._id.toString(), { 
          correlationId: 'audit',
          force: true
        });
        
        const diff = calculateDiff(view, freshView);
        
        if (diff.length > 0) {
          results.inconsistent++;
          results.issues.push({
            patientId: patient._id.toString(),
            patientName: patient.fullName,
            issue: 'inconsistent',
            diffCount: diff.length,
            fields: diff.map(d => d.path)
          });
        } else {
          results.consistent++;
        }
      }
    }
    
    const duration = Date.now() - startTime;
    
    logger.info(`✅ Audit completed`, {
      total: results.totalChecked,
      issues: results.issues.length,
      duration: `${duration}ms`
    });
    
    return res.json(formatSuccess({
      summary: {
        totalChecked: results.totalChecked,
        consistent: results.consistent,
        inconsistent: results.inconsistent,
        missing: results.missing,
        stale: results.stale,
        healthScore: Math.round(
          ((results.totalChecked - results.issues.length) / results.totalChecked) * 100
        )
      },
      issues: results.issues.slice(0, 50), // limita para não sobrecarregar response
      meta: {
        duration: `${duration}ms`,
        sampleSize: sample
      }
    }));
    
  } catch (error) {
    logger.error('❌ Audit error', { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * GET /api/v2/patients/debug/audit/stale
 * 
 * Lista todas as views stale.
 */
router.get('/debug/audit/stale', flexibleAuth, requireAdmin, async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const staleViews = await PatientsView.find({
      $or: [
        { 'snapshot.isStale': true },
        { 'snapshot.calculatedAt': { $lt: fiveMinutesAgo } }
      ]
    })
    .select('patientId fullName snapshot stats')
    .limit(parseInt(limit))
    .lean();
    
    return res.json(formatSuccess({
      count: staleViews.length,
      views: staleViews.map(v => ({
        patientId: v.patientId,
        fullName: v.fullName,
        calculatedAt: v.snapshot?.calculatedAt,
        age: v.snapshot?.calculatedAt 
          ? Math.round((Date.now() - new Date(v.snapshot.calculatedAt)) / 1000)
          : null,
        isStale: v.snapshot?.isStale
      }))
    }));
    
  } catch (error) {
    logger.error('❌ Stale audit error', { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

// ============================================
// DEBUG: Simulação de Eventos
// ============================================

/**
 * POST /api/v2/patients/debug/simulate-event
 * 
 * Simula um evento para testar projection (sem afetar domínio).
 */
router.post('/debug/simulate-event', flexibleAuth, requireAdmin, async (req, res) => {
  const { patientId, eventType, payload = {} } = req.body;
  const correlationId = `sim_${Date.now()}`;
  
  logger.info(`[${correlationId}] 🎮 Simulating event`, { patientId, eventType });
  
  try {
    // Importa worker dinamicamente
    const { patientProjectionWorker } = await import('../domains/clinical/workers/patientProjectionWorker.js');
    
    const beforeView = await PatientsView.findOne({ patientId }).lean();
    
    // Processa evento simulado
    const result = await patientProjectionWorker.processJob({
      data: {
        eventType,
        payload: { patientId, ...payload },
        correlationId
      }
    });
    
    const afterView = await PatientsView.findOne({ patientId }).lean();
    
    return res.json(formatSuccess({
      simulation: {
        eventType,
        patientId,
        correlationId
      },
      result,
      before: beforeView ? {
        version: beforeView.snapshot?.version,
        stats: beforeView.stats
      } : null,
      after: afterView ? {
        version: afterView.snapshot?.version,
        stats: afterView.stats
      } : null
    }, 'Evento simulado processado'));
    
  } catch (error) {
    logger.error(`[${correlationId}] ❌ Simulation error`, { error: error.message });
    return res.status(500).json(formatError(error.message, 500));
  }
});

// ============================================
// HELPERS
// ============================================

function calculateDiff(current, fresh) {
  if (!current) return [{ path: 'view', status: 'missing' }];
  if (!fresh) return [{ path: 'view', status: 'rebuild_failed' }];
  
  const differences = [];
  
  // Compara campos específicos
  const fieldsToCompare = [
    { path: 'stats.totalAppointments', label: 'Total Appointments' },
    { path: 'stats.totalCompleted', label: 'Completed' },
    { path: 'stats.totalRevenue', label: 'Revenue' },
    { path: 'stats.totalPending', label: 'Pending' },
    { path: 'balance.current', label: 'Balance' }
  ];
  
  for (const { path, label } of fieldsToCompare) {
    const currentVal = getNestedValue(current, path);
    const freshVal = getNestedValue(fresh, path);
    
    if (currentVal !== freshVal) {
      differences.push({
        path,
        label,
        current: currentVal,
        fresh: freshVal,
        diff: freshVal - currentVal
      });
    }
  }
  
  return differences;
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

function calculateStaleness(view) {
  if (!view?.snapshot?.calculatedAt) return null;
  
  const age = Date.now() - new Date(view.snapshot.calculatedAt).getTime();
  return {
    ageSeconds: Math.round(age / 1000),
    ageMinutes: Math.round(age / 60000),
    isStale: view.snapshot.isStale || age > 5 * 60 * 1000
  };
}

export default router;
