/**
 * replay-patient-projection-dlq.mjs
 *
 * Drena a patient-projection-dlq e reenvia cada job para a fila principal.
 * Executar APÓS o deploy do fix no patientProjectionWorker.
 *
 * Uso: node scripts/replay-patient-projection-dlq.mjs [--dry-run]
 */

import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const DRY_RUN = process.argv.includes('--dry-run');

const redis = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

const dlqQueue   = new Queue('patient-projection-dlq', { connection: redis });
const mainQueue  = new Queue('patient-projection',     { connection: redis });

async function run() {
  const jobs = await dlqQueue.getJobs(['wait', 'waiting', 'completed', 'failed'], 0, 500);
  console.log(`🔍 Encontrados ${jobs.length} jobs na DLQ${DRY_RUN ? ' [DRY-RUN]' : ''}`);

  let replayed = 0;
  let skipped  = 0;

  for (const job of jobs) {
    const originalData = job.data?.originalJob;

    if (!originalData?.eventType || !originalData?.payload?.patientId) {
      console.warn(`⚠️  Job ${job.id} sem dados válidos — ignorado`, job.data);
      skipped++;
      continue;
    }

    console.log(`▶  Replay ${originalData.eventType} | patient=${originalData.payload.patientId} | correlationId=${originalData.correlationId}`);

    if (!DRY_RUN) {
      await mainQueue.add(originalData.eventType, originalData, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail:     { age: 3600 * 6 },
      });

      await job.remove();
    }

    replayed++;
  }

  console.log(`\n✅ Resultado: ${replayed} reenviados, ${skipped} ignorados${DRY_RUN ? ' [DRY-RUN — nada foi alterado]' : ''}`);

  await dlqQueue.close();
  await mainQueue.close();
  await redis.quit();
}

run().catch(err => {
  console.error('❌ Erro no replay:', err);
  process.exit(1);
});
