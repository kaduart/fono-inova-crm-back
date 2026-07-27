// crons/communicationReconciliation.cron.js
/**
 * Reconciliador de InsuranceCommunication travadas em 'sending'.
 *
 * O endpoint POST /communications/:id/send transiciona o status para SENDING
 * antes de enfileirar o job de e-mail (communication-email). Se o enfileiramento
 * falhar (Redis instável, etc.) ou o worker lançar um erro antes de chegar na
 * própria lógica de transição de estado, a comunicação fica presa em 'sending'
 * para sempre — sem job, sem CommunicationEmailLog, sem chance de retry manual
 * (achado em produção em 2026-07-27: 3 comunicações órfãs nessa condição).
 *
 * Este cron detecta esses casos e devolve o status para READY (evento FAIL),
 * permitindo reenvio manual pela UI.
 */

import InsuranceCommunication from '../models/InsuranceCommunication.js';
import { transition, CommunicationEvents } from '../services/communication/CommunicationStateMachine.js';
import { getQueue } from '../infrastructure/queue/queueConfig.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger(null, 'communication_reconciliation');
let isRunning = false;
let intervalId = null;

const STUCK_THRESHOLD_MINUTES = 10;
const CHECK_INTERVAL_MINUTES = 5;

/**
 * Verifica, para uma comunicação presa, se existe job correspondente em
 * qualquer estado ativo (waiting/active/delayed) na fila communication-email.
 * Retorna também o job caso exista em 'failed', para logar o motivo real.
 */
async function findJobForCommunication(queue, communicationId) {
  const [waiting, active, delayed, failed] = await Promise.all([
    queue.getJobs(['waiting'], 0, 500),
    queue.getJobs(['active'], 0, 500),
    queue.getJobs(['delayed'], 0, 500),
    queue.getJobs(['failed'], 0, 500)
  ]);

  const inFlight = [...waiting, ...active, ...delayed]
    .find(job => job.data?.communicationId === communicationId);
  if (inFlight) return { status: 'in_flight', job: inFlight };

  const failedJob = failed.find(job => job.data?.communicationId === communicationId);
  if (failedJob) return { status: 'failed', job: failedJob };

  return { status: 'missing', job: null };
}

async function reconcileStuckCommunications() {
  const threshold = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000);

  const stuck = await InsuranceCommunication.find({
    status: 'sending',
    updatedAt: { $lt: threshold }
  }).sort({ updatedAt: 1 }).limit(100).lean();

  if (stuck.length === 0) {
    return { reverted: 0, skipped: 0, total: 0 };
  }

  log.warn('reconciliation_start', `Encontradas ${stuck.length} comunicação(ões) presas em 'sending'`, {
    thresholdMinutes: STUCK_THRESHOLD_MINUTES
  });

  const queue = getQueue('communication-email');
  let revertedCount = 0;
  let skippedCount = 0;

  for (const communication of stuck) {
    const communicationId = communication._id.toString();
    try {
      const { status, job } = await findJobForCommunication(queue, communicationId);

      if (status === 'in_flight') {
        skippedCount++;
        continue;
      }

      const reason = status === 'failed'
        ? `Job ${job.id} esgotou tentativas: ${job.failedReason || 'motivo desconhecido'}`
        : `Nenhum job encontrado na fila communication-email após ${STUCK_THRESHOLD_MINUTES}min em 'sending'`;

      await transition(communicationId, CommunicationEvents.FAIL, { statusReason: reason });
      revertedCount++;

      log.error('communication_reverted', `Comunicação ${communicationId} revertida para READY: ${reason}`, {
        communicationId,
        patientId: communication.patientId,
        guideId: communication.guideId,
        jobStatus: status
      });
    } catch (error) {
      log.error('reconciliation_item_error', `Erro ao reconciliar comunicação ${communicationId}`, {
        communicationId,
        error: error.message
      });
    }
  }

  return { reverted: revertedCount, skipped: skippedCount, total: stuck.length };
}

async function runOnce() {
  if (isRunning) {
    console.log('[CommunicationReconciliation] ⏭️ Já está rodando, pulando...');
    return;
  }

  isRunning = true;
  const startedAt = Date.now();
  console.log(`[CommunicationReconciliation] 🔁 [${new Date().toISOString()}] Verificando comunicações travadas...`);

  try {
    const result = await reconcileStuckCommunications();

    if (result.total > 0) {
      console.log(`[CommunicationReconciliation] ⚠️ ${result.reverted} revertida(s) | ${result.skipped} ainda em processamento | Total: ${result.total} em ${Date.now() - startedAt}ms`);
    } else {
      console.log(`[CommunicationReconciliation] ✅ nada a reconciliar em ${Date.now() - startedAt}ms`);
    }
  } catch (error) {
    console.error('[CommunicationReconciliation] ❌ Erro:', error.message);
  } finally {
    isRunning = false;
  }
}

export function initCommunicationReconciliationCron() {
  if (intervalId) {
    console.log('[CommunicationReconciliation] ⚠️ Já inicializado, ignorando');
    return { stop: () => clearInterval(intervalId) };
  }

  console.log('🔄 Inicializando Communication Reconciliation Cron...');

  intervalId = setInterval(runOnce, CHECK_INTERVAL_MINUTES * 60 * 1000);

  setTimeout(() => {
    console.log('[CommunicationReconciliation] 🚀 Primeira execução (warmup)...');
    runOnce().catch(e => console.error('[CommunicationReconciliation] Erro no warmup:', e.message));
  }, 2 * 60 * 1000);

  console.log(`✅ Communication Reconciliation Cron inicializado (a cada ${CHECK_INTERVAL_MINUTES} min)`);

  return {
    stop: () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }
  };
}

export { reconcileStuckCommunications };
export default { initCommunicationReconciliationCron };
