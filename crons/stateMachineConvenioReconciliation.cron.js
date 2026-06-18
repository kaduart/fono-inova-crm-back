// crons/stateMachineConvenioReconciliation.cron.js
// 🔄 Reconciliação diária de state machine para convênio
// Padrão: DRY-RUN — apenas monitora e reporta drift, sem alterar dados.
// Para execução real, use o script CLI: reconciliador-diario-state-machine-convenio.js --execute

import cron from 'node-cron';
import mongoose from 'mongoose';
import {
  StateMachineConvenioReconciler,
  measureStateMachineDrift,
  loadBaseline
} from '../services/stateMachineConvenioReconciliation.service.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger('cron', 'StateMachineConvenioReconciliation');
const TIMEZONE = 'America/Sao_Paulo';

async function runReconciliation() {
  const startedAt = Date.now();
  log.info('convenio_reconciliation_start', 'Iniciando reconciliação de state machine de convênio (dry-run)');

  try {
    const db = mongoose.connection.db;
    const baseline = await loadBaseline();
    const driftBefore = await measureStateMachineDrift(db);

    // Sempre dry-run no cron — correções manuais via CLI
    const reconciler = new StateMachineConvenioReconciler(db, { execute: false });
    const report = await reconciler.runSafeCorrections();

    const driftAfter = await measureStateMachineDrift(db);
    report.driftBefore = driftBefore;
    report.driftAfter = driftAfter;
    report.baseline = baseline;

    const delta = baseline?.drift?.total !== undefined
      ? driftAfter.total - baseline.drift.total
      : null;

    log.info('convenio_reconciliation_done', `Reconciliação concluída em ${Date.now() - startedAt}ms`, {
      modo: 'DRY-RUN',
      estatisticas: report.estatisticas,
      driftAntes: driftBefore.total,
      driftDepois: driftAfter.total,
      delta,
      acoesAutomaticas: report.estatisticas.sessionsReverted
        + report.estatisticas.paymentPointersFixed
        + report.estatisticas.sessionPointersFixed
        + report.estatisticas.guidesRecalculated
        + report.estatisticas.appointmentLinksCleaned
    });

    if (delta !== null && delta > 0) {
      log.error('convenio_reconciliation_drift_alert', `Drift aumentou em ${delta} — revisar fluxos de convênio`, {
        driftAfter,
        baseline: baseline.drift.total
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
