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
 */

import dotenv from 'dotenv';
import path from 'path';
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
  const INTERVAL_MS = 1000;
  const THRESHOLD_MS = 100;
  let last = Date.now();

  setInterval(() => {
    const now = Date.now();
    const lag = now - last - INTERVAL_MS;
    last = now;
    if (lag > THRESHOLD_MS) {
      console.warn(`[cron-worker][event-loop] LAG DETECTED: ${lag}ms (threshold ${THRESHOLD_MS}ms)`);
    }
  }, INTERVAL_MS);

  console.log('⏱️  [cron-worker] Event loop monitor iniciado');
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
