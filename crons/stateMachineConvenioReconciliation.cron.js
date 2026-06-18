// crons/stateMachineConvenioReconciliation.cron.js
// 🔄 Reconciliação diária de state machine para convênio

import cron from 'node-cron';
import mongoose from 'mongoose';
import {
  StateMachineConvenioReconciler,
  measureStateMachineDrift,
  loadBaseline,
  saveBaseline
} from '../services/stateMachineConvenioReconciliation.service.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger('cron', 'StateMachineConvenioReconciliation');
const TIMEZONE = 'America/Sao_Paulo';

// Modo inicial: dry-run por padrão até validação em produção.
// Mudar para true quando quiser auto-correção ativa.
const AUTO_EXECUTE = process.env.CRON_CONVENIO_RECONCILIATION_EXECUTE === 'true';
// Threshold do cron: tolera drift residual histórico/conhecido (ex: manualReview)
// CI deve usar threshold=0 via flag --threshold=0
const ALERT_THRESHOLD = parseInt(process.env.CRON_CONVENIO_RECONCILIATION_THRESHOLD || '5', 10);

async function runReconciliation() {
  const startedAt = Date.now();
  log.info('convenio_reconciliation_start', 'Iniciando reconciliação de state machine de convênio');

  try {
    const db = mongoose.connection.db;
    const baseline = await loadBaseline();
    const driftBefore = await measureStateMachineDrift(db);

    const reconciler = new StateMachineConvenioReconciler(db, { execute: AUTO_EXECUTE });
    const report = await reconciler.runSafeCorrections();

    const driftAfter = await measureStateMachineDrift(db);
    report.driftBefore = driftBefore;
    report.driftAfter = driftAfter;
    report.baseline = baseline;

    const delta = baseline?.drift?.total !== undefined
      ? driftAfter.total - baseline.drift.total
      : null;

    log.info('convenio_reconciliation_done', `Reconciliação concluída em ${Date.now() - startedAt}ms`, {
      modo: AUTO_EXECUTE ? 'AUTO' : 'DRY-RUN',
      estatisticas: report.estatisticas,
      driftAntes: driftBefore.total,
      driftDepois: driftAfter.total,
      delta,
      threshold: ALERT_THRESHOLD
    });

    if (AUTO_EXECUTE) {
      await saveBaseline(driftAfter);
    }

    if (driftAfter.total > ALERT_THRESHOLD) {
      log.error('convenio_reconciliation_drift_alert', `Drift residual acima do limite: ${driftAfter.total}`, {
        driftAfter,
        threshold: ALERT_THRESHOLD
      });
    }

    return report;
  } catch (error) {
    log.error('convenio_reconciliation_error', error.message, { stack: error.stack });
    throw error;
  }
}

export function scheduleStateMachineConvenioReconciliation() {
  // Roda diariamente às 03:00 (horário de menor carga)
  const task = cron.schedule('0 3 * * *', async () => {
    await runReconciliation();
  }, {
    timezone: TIMEZONE,
    scheduled: false
  });

  task.runReconciliation = runReconciliation;
  return task;
}

export { runReconciliation };
