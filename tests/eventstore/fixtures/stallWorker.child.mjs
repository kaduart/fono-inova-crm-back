// Processo filho: worker BullMQ que reivindica o evento e trava, para o teste
// matá-lo com SIGKILL no meio da execução (queda real, sem finally).
import mongoose from 'mongoose';
import IORedis from 'ioredis';
import { Worker } from 'bullmq';
import { processWithGuarantees } from '../../../infrastructure/events/eventStoreService.js';

const [mongoUri, dbName, redisUrl, queueName] = process.argv.slice(2);
await mongoose.connect(mongoUri, { dbName });
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
new Worker(queueName, async (job) => {
  await processWithGuarantees({ eventId: job.data.eventId }, async () => {
    process.send?.({ started: true });
    await new Promise(() => {}); // trava até o SIGKILL
  }, 'filho');
}, { connection, lockDuration: 1000, stalledInterval: 1000, maxStalledCount: 1 });
process.send?.({ ready: true });
