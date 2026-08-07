// workers/entrypoints/cron-worker.js
/**
 * Processo dedicado para crons críticos.
 *
 * Separa o agendamento de tarefas do processo HTTP da API,
 * eliminando NODE-CRON missed execution causado por carga no event loop da API.
 *
 * Crons iniciados:
 *  - appointmentRecovery
 *  - eventReaper
 *  - financialSnapshotAudit
 *  - patientConsistency
 *  - preAgendamentoExpiration
 *  - stateMachineConvenioReconciliation
 */

import dotenv from 'dotenv';
import path from 'path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { redisConnection } from '../../config/redisConnection.js';
import { startAllCrons, stopAllCrons } from '../../config/cronManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não configurado');
  process.exit(1);
}

// ======================================================
// ⏱️ Event Loop Lag Monitor
// ======================================================
function startEventLoopMonitor() {
  const REPORT_INTERVAL_MS = 30_000;
  const P99_THRESHOLD_MS = 200;

  // Histograma do libuv (nanossegundos) — imune a salto de relógio e a
  // suspensão do processo, que geravam falsos "LAG DETECTED" com Date.now().
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const timer = setInterval(() => {
    const p99 = histogram.percentile(99) / 1e6;
    const max = histogram.max / 1e6;
    const mean = histogram.mean / 1e6;
    histogram.reset();

    if (p99 > P99_THRESHOLD_MS) {
      console.warn(
        `[cron-worker][event-loop] LAG: p99=${p99.toFixed(0)}ms max=${max.toFixed(0)}ms mean=${mean.toFixed(0)}ms ` +
        `(janela ${REPORT_INTERVAL_MS / 1000}s, threshold p99 ${P99_THRESHOLD_MS}ms)`
      );
    }
  }, REPORT_INTERVAL_MS);

  timer.unref();

  console.log(`⏱️  [cron-worker] Event loop monitor iniciado (p99 a cada ${REPORT_INTERVAL_MS / 1000}s)`);
}

// ======================================================
// 🚀 Inicialização
// ======================================================
(async () => {
  try {
    console.log('🕒 [cron-worker] Iniciando processo dedicado de crons...');

    // Redis
    try {
      await redisConnection.ping();
      console.log('✅ [cron-worker] Redis conectado');
    } catch (redisErr) {
      console.warn('⚠️ [cron-worker] Redis indisponível:', redisErr.message);
    }

    // MongoDB
    await mongoose.connect(MONGO_URI, {
      readPreference: 'primary',
      retryWrites: true,
      w: 'majority',
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      autoIndex: process.env.NODE_ENV !== 'production',
    });
    console.log('✅ [cron-worker] MongoDB conectado');

    // Monitoramento
    startEventLoopMonitor();

    // Crons
    await startAllCrons();

    console.log('🕒 [cron-worker] Pronto — crons rodando em processo isolado');
  } catch (err) {
    console.error('❌ [cron-worker] Erro crítico na inicialização:', err);
    process.exit(1);
  }
})();

// ======================================================
// 🛑 Graceful shutdown
// ======================================================
process.on('SIGTERM', async () => {
  console.log('\n🛑 [cron-worker] SIGTERM recebido, parando crons...');
  stopAllCrons();
  await mongoose.connection.close(false);
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 [cron-worker] SIGINT recebido, parando crons...');
  stopAllCrons();
  await mongoose.connection.close(false);
  process.exit(0);
});
