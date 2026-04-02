// back/domains/billing/services/PackageProjectionService.js
/**
 * Package Projection Service
 * 
 * Responsabilidade: Construir/reconstruir a view de pacotes
 * 
 * Princípios:
 * - FULL REBUILD sempre (idempotência total)
 * - NUNCA update parcial
 * - SEMPRE recalcular do zero
 */

import mongoose from 'mongoose';
import Package from '../../../models/Package.js';
import Session from '../../../models/Session.js';
import Patient from '../../../models/Patient.js';
import Doctor from '../../../models/Doctor.js';
import PackagesView from '../../../models/PackagesView.js';
import { createContextLogger } from '../../../utils/logger.js';

const logger = createContextLogger('PackageProjectionService');

/**
 * Busca dados brutos do pacote e relacionados
 */
async function fetchRawData(packageId, correlationId) {
  logger.info('[PackageProjectionService] Fetching raw data', {
    correlationId,
    packageId: packageId.toString(),
    operation: 'fetch_raw_data'
  });
  
  const pkg = await Package.findById(packageId)
    .populate('patient', 'fullName')
    .populate('doctor', 'fullName specialty')
    .populate('insuranceGuide', 'number insurance')
    .populate('payments', 'amount status paymentMethod')
    .lean();
  
  if (!pkg) {
    logger.error('[PackageProjectionService] Package not found', {
      correlationId,
      packageId: packageId.toString()
    });
    throw new Error(`Package ${packageId} not found`);
  }
  
  // Busca TODAS as sessões do pacote (incluindo canceladas)
  const sessions = await Session.find({ package: packageId })
    .sort({ date: 1, time: 1 })
    .lean();
  
  logger.info('[PackageProjectionService] Raw data fetched', {
    correlationId,
    packageId: packageId.toString(),
    sessionsCount: sessions.length,
    patientId: pkg.patient?._id?.toString(),
    packageType: pkg.type,
    duration: 'pending'
  });
  
  return { pkg, sessions };
}

/**
 * Calcula métricas de sessões
 */
function calculateSessionMetrics(sessions, pkgTotalSessions) {
  // totalSessions = do contrato (pkg.totalSessions), não das criadas
  const totalSessions = pkgTotalSessions || sessions.length;
  const sessionsUsed = sessions.filter(s => s.status === 'completed').length;
  const sessionsCanceled = sessions.filter(s => s.status === 'canceled').length;
  const sessionsRemaining = Math.max(0, totalSessions - sessionsUsed - sessionsCanceled);
  
  // Resumo das sessões para a view
  const sessionsSummary = sessions.map(s => ({
    sessionId: s._id,
    date: s.date,
    time: s.time,
    status: s.status,
    isPaid: s.isPaid || false
  }));
  
  return {
    totalSessions,
    sessionsUsed,
    sessionsCanceled,
    sessionsRemaining,
    sessionsSummary
  };
}

/**
 * Determina datas de início e fim do pacote
 */
function calculateDates(sessions, pkg) {
  if (sessions.length === 0) {
    return {
      startDate: pkg.date,
      endDate: null
    };
  }
  
  const sortedSessions = [...sessions].sort((a, b) => {
    const dateA = new Date(a.date + 'T' + a.time);
    const dateB = new Date(b.date + 'T' + b.time);
    return dateA - dateB;
  });
  
  return {
    startDate: new Date(sortedSessions[0].date),
    endDate: sortedSessions[sortedSessions.length - 1].date
      ? new Date(sortedSessions[sortedSessions.length - 1].date)
      : null
  };
}

/**
 * Constrói a view completa do pacote (FULL REBUILD)
 */
export async function buildPackageView(packageId, options = {}) {
  const { correlationId = `pkg_${Date.now()}`, force = false } = options;
  const startTime = Date.now();
  
  logger.info(`[${correlationId}] 🏗️ Building package view for ${packageId}`);
  
  try {
    // 1. Busca dados brutos
    const { pkg, sessions } = await fetchRawData(packageId, correlationId);
    
    // 2. Calcula métricas
    const sessionMetrics = calculateSessionMetrics(sessions, pkg.totalSessions);
    const dates = calculateDates(sessions, pkg);
    
    // 3. Prepara dados da view
    const viewData = {
      packageId: pkg._id,
      patientId: pkg.patient?._id,
      doctorId: pkg.doctor?._id,
      
      type: pkg.type,
      status: pkg.status,
      specialty: pkg.specialty,
      sessionType: pkg.sessionType,
      
      ...sessionMetrics,
      sessionsDone: sessionMetrics.sessionsUsed,
      paidSessions: pkg.paidSessions || 0,
      
      sessionValue: pkg.sessionValue,
      totalValue: pkg.totalValue,
      totalPaid: pkg.totalPaid,
      balance: pkg.balance,
      financialStatus: pkg.financialStatus,
      
      ...dates,
      expiresAt: pkg.liminarExpirationDate || null,
      
      insuranceGuideId: pkg.insuranceGuide?._id,
      insuranceProvider: pkg.insuranceProvider || pkg.insuranceGuide?.insurance,
      insuranceGrossAmount: pkg.insuranceGrossAmount || 0,
      insuranceBillingStatus: pkg.insuranceBillingStatus || null,
      
      liminarProcessNumber: pkg.liminarProcessNumber || null,
      liminarCourt: pkg.liminarCourt || null,
      liminarTotalCredit: pkg.liminarTotalCredit || 0,
      liminarCreditBalance: pkg.liminarCreditBalance || 0,
      recognizedRevenue: pkg.recognizedRevenue || 0,
      
      payments: (pkg.payments || []).map(p => ({
        paymentId: p._id,
        amount: p.amount,
        status: p.status,
        method: p.paymentMethod
      })),
      
      sessions: sessionMetrics.sessionsSummary,
      
      searchFields: {
        patientName: pkg.patient?.fullName,
        doctorName: pkg.doctor?.fullName
      },
      
      snapshot: {
        version: 1,
        calculatedAt: new Date(),
        ttl: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        isStale: false
      }
    };
    
    // 4. Upsert na view (atualiza ou cria)
    const result = await PackagesView.findOneAndUpdate(
      { packageId: pkg._id },
      viewData,
      { 
        upsert: true, 
        new: true,
        setDefaultsOnInsert: true
      }
    );
    
    const duration = Date.now() - startTime;
    logger.info('[PackageProjectionService] View built successfully', {
      correlationId,
      packageId: packageId.toString(),
      version: result.snapshot.version,
      sessionsCount: sessionMetrics.totalSessions,
      sessionsUsed: sessionMetrics.sessionsUsed,
      sessionsRemaining: sessionMetrics.sessionsRemaining,
      durationMs: duration,
      operation: 'build_view',
      status: 'success'
    });
    
    return {
      success: true,
      packageId: packageId.toString(),
      view: result,
      duration: `${duration}ms`,
      correlationId
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('[PackageProjectionService] Failed to build view', {
      correlationId,
      packageId: packageId.toString(),
      error: error.message,
      errorType: error.name,
      durationMs: duration,
      operation: 'build_view',
      status: 'error'
    });
    
    throw error;
  }
}

/**
 * Reconstrói views de TODOS os pacotes de um paciente
 */
export async function rebuildAllPatientPackages(patientId, options = {}) {
  const { correlationId = `rebuild_${Date.now()}` } = options;
  
  logger.info(`[${correlationId}] 🔄 Rebuilding all packages for patient ${patientId}`);
  
  const packages = await Package.find({ patient: patientId })
    .select('_id')
    .lean();
  
  const results = [];
  for (const pkg of packages) {
    try {
      const result = await buildPackageView(pkg._id, { correlationId });
      results.push({ packageId: pkg._id, status: 'success', duration: result.duration });
    } catch (error) {
      results.push({ packageId: pkg._id, status: 'error', error: error.message });
    }
  }
  
  const successCount = results.filter(r => r.status === 'success').length;
  logger.info(`[${correlationId}] ✅ Rebuilt ${successCount}/${results.length} packages`);
  
  return {
    patientId: patientId.toString(),
    total: results.length,
    success: successCount,
    failed: results.length - successCount,
    results,
    correlationId
  };
}

/**
 * Marca view como stale (para rebuild posterior)
 */
export async function markViewAsStale(packageId, reason = 'manual') {
  const view = await PackagesView.findOne({ packageId });
  if (view) {
    await view.markAsStale();
    logger.info(`Marked package view ${packageId} as stale`, { reason });
  }
}

/**
 * Deleta view (quando pacote é removido)
 */
export async function deletePackageView(packageId) {
  const result = await PackagesView.deleteOne({ packageId });
  logger.info(`Deleted package view ${packageId}`, { deletedCount: result.deletedCount });
  return result;
}

export default {
  buildPackageView,
  rebuildAllPatientPackages,
  markViewAsStale,
  deletePackageView
};
