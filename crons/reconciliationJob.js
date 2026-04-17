// crons/reconciliationJob.js
/**
 * Job de Reconciliação Diária
 * 
 * Executa às 3h da manhã para:
 * - Verificar consistência entre write e view models
 * - Detectar invoices faltantes
 * - Rebuild views desatualizadas
 * - Reportar anomalias
 */

import cron from 'node-cron';
import { createContextLogger } from '../utils/logger.js';
import mongoose from 'mongoose';

const logger = createContextLogger('ReconciliationJob');

// Configuração
const CONFIG = {
  // Executa às 3:00 AM todos os dias
  schedule: '0 3 * * *',
  timezone: 'America/Sao_Paulo'
};

export function startReconciliationJob() {
  logger.info('reconciliation_job_init', 'Inicializando job de reconciliação', CONFIG);

  cron.schedule(CONFIG.schedule, async () => {
    const startTime = Date.now();
    logger.info('reconciliation_start', 'Iniciando reconciliação diária');

    const report = {
      timestamp: new Date().toISOString(),
      checks: [],
      anomalies: [],
      actions: []
    };

    try {
      // Check 1: Consistência InsuranceBatch
      report.checks.push(await checkInsuranceBatchConsistency());

      // Check 2: Invoices faltantes
      report.checks.push(await checkMissingInvoices());

      // Check 3: Eventos órfãos
      report.checks.push(await checkOrphanEvents());

      // Check 4: DLQ
      report.checks.push(await checkDLQStatus());

      // Compila anomalias
      report.anomalies = report.checks.filter(c => c.status !== 'ok');

      // Ações corretivas automáticas
      for (const anomaly of report.anomalies) {
        if (anomaly.autoFixable) {
          const action = await autoFix(anomaly);
          report.actions.push(action);
        }
      }

      const duration = Date.now() - startTime;
      
      logger.info('reconciliation_complete', 'Reconciliação finalizada', {
        duration: `${duration}ms`,
        checks: report.checks.length,
        anomalies: report.anomalies.length,
        actions: report.actions.length
      });

      // Se houver anomalias críticas, alerta
      if (report.anomalies.some(a => a.severity === 'critical')) {
        logger.error('reconciliation_critical', 'Anomalias críticas detectadas', {
          anomalies: report.anomalies.filter(a => a.severity === 'critical')
        });
        // Aqui poderia disparar alerta para on-call
      }

      return report;

    } catch (error) {
      logger.error('reconciliation_error', 'Erro na reconciliação', { error: error.message });
      throw error;
    }
  }, {
    scheduled: true,
    timezone: CONFIG.timezone
  });

  logger.info('reconciliation_job_scheduled', `Job agendado: ${CONFIG.schedule}`);
}

// ============================================
// CHECKS
// ============================================

async function checkInsuranceBatchConsistency() {
  const InsuranceBatch = (await import('../models/InsuranceBatch.js')).default;
  const InsuranceBatchView = (await import('../models/InsuranceBatchView.js')).default;

  const [writeCount, viewCount] = await Promise.all([
    InsuranceBatch.countDocuments(),
    InsuranceBatchView.countDocuments()
  ]);

  const difference = writeCount - viewCount;
  const status = difference === 0 ? 'ok' : (difference > 10 ? 'critical' : 'warning');

  return {
    name: 'insurance_batch_consistency',
    status,
    severity: status === 'critical' ? 'critical' : (status === 'warning' ? 'warning' : 'info'),
    details: { writeCount, viewCount, difference },
    autoFixable: difference > 0
  };
}

async function checkMissingInvoices() {
  const Payment = (await import('../models/Payment.js')).default;
  const Invoice = (await import('../models/Invoice.js')).default;

  // Payments completados nas últimas 24h sem invoice
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const payments = await Payment.find({
    status: 'completed',
    type: { $in: ['session', 'per_session'] },
    updatedAt: { $gte: yesterday }
  }).select('_id').lean();

  const paymentIds = payments.map(p => p._id.toString());

  const invoices = await Invoice.find({
    payment: { $in: paymentIds }
  }).select('payment').lean();

  const invoicedIds = new Set(invoices.map(i => i.payment?.toString()));
  const missing = paymentIds.filter(id => !invoicedIds.has(id));

  const status = missing.length === 0 ? 'ok' : (missing.length > 10 ? 'critical' : 'warning');

  return {
    name: 'missing_invoices',
    status,
    severity: status === 'critical' ? 'critical' : 'warning',
    details: { totalPayments: paymentIds.length, missingCount: missing.length, missingIds: missing.slice(0, 5) },
    autoFixable: false // Não auto-corrige - precisa investigar
  };
}

async function checkOrphanEvents() {
  const EventStore = (await import('../models/EventStore.js')).default;

  // Eventos em status 'processing' por mais de 1 hora (provavelmente travados)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const orphanEvents = await EventStore.countDocuments({
    status: 'processing',
    createdAt: { $lt: oneHourAgo }
  });

  const status = orphanEvents === 0 ? 'ok' : (orphanEvents > 50 ? 'critical' : 'warning');

  return {
    name: 'orphan_events',
    status,
    severity: status === 'critical' ? 'critical' : 'warning',
    details: { orphanCount: orphanEvents },
    autoFixable: true // Pode marcar como failed para retry
  };
}

async function checkDLQStatus() {
  // Verificar tamanho das DLQs
  const { getQueue } = await import('../infrastructure/queue/queueConfig.js');

  const dlqs = [
    'sync-medical-dlq',
    'insurance-orchestrator-dlq'
  ];

  const results = [];

  for (const dlqName of dlqs) {
    try {
      const queue = getQueue(dlqName);
      const count = await queue.getWaitingCount();
      results.push({ name: dlqName, count });
    } catch (error) {
      results.push({ name: dlqName, count: 0, error: error.message });
    }
  }

  const totalDLQ = results.reduce((sum, r) => sum + (r.count || 0), 0);
  const status = totalDLQ === 0 ? 'ok' : (totalDLQ > 100 ? 'critical' : 'warning');

  return {
    name: 'dlq_status',
    status,
    severity: status === 'critical' ? 'critical' : 'warning',
    details: { queues: results, total: totalDLQ },
    autoFixable: false // DLQ precisa de análise manual
  };
}

// ============================================
// AUTO-FIX
// ============================================

async function autoFix(anomaly) {
  logger.info('autofix_start', `Iniciando auto-fix para ${anomaly.name}`, anomaly.details);

  try {
    switch (anomaly.name) {
      case 'insurance_batch_consistency':
        return await fixBatchConsistency(anomaly.details);

      case 'orphan_events':
        return await fixOrphanEvents(anomaly.details);

      default:
        return {
          name: anomaly.name,
          status: 'skipped',
          reason: 'No auto-fix available'
        };
    }
  } catch (error) {
    logger.error('autofix_error', `Erro no auto-fix de ${anomaly.name}`, { error: error.message });
    return {
      name: anomaly.name,
      status: 'failed',
      error: error.message
    };
  }
}

async function fixBatchConsistency(details) {
  const { buildInsuranceBatchView } = await import('../domains/billing/services/InsuranceBatchProjectionService.js');
  const InsuranceBatch = (await import('../models/InsuranceBatch.js')).default;
  const InsuranceBatchView = (await import('../models/InsuranceBatchView.js')).default;

  // Rebuild views faltantes
  const batches = await InsuranceBatch.find().select('_id').lean();
  const views = await InsuranceBatchView.find().select('batchId').lean();
  const viewIds = new Set(views.map(v => v.batchId));

  const missing = batches.filter(b => !viewIds.has(b._id.toString()));
  let fixed = 0;

  for (const batch of missing) {
    try {
      await buildInsuranceBatchView(batch._id.toString(), { correlationId: 'reconciliation_job' });
      fixed++;
    } catch (error) {
      logger.error('batch_rebuild_error', `Erro ao rebuild batch ${batch._id}`, { error: error.message });
    }
  }

  return {
    name: 'fix_batch_consistency',
    status: 'completed',
    fixed,
    totalMissing: missing.length
  };
}

async function fixOrphanEvents(details) {
  const EventStore = (await import('../models/EventStore.js')).default;

  // Marca eventos travados como 'failed' para permitir retry
  const result = await EventStore.updateMany(
    {
      status: 'processing',
      createdAt: { $lt: new Date(Date.now() - 60 * 60 * 1000) }
    },
    {
      $set: {
        status: 'failed',
        failedAt: new Date(),
        failureReason: 'Marked as failed by reconciliation job (orphan)'
      }
    }
  );

  return {
    name: 'fix_orphan_events',
    status: 'completed',
    modified: result.modifiedCount
  };
}

export default { startReconciliationJob };
