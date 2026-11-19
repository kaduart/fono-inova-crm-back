// scripts/isolado/crmDispatcher.mjs
// OutboxDispatcher do CRM (código real: infrastructure/outbox/outboxPattern.js)
// contra o Mongo e o Redis descartáveis do ambiente integrado. Publica nas
// filas BullMQ com jobId = eventId__fila, como em produção. Não sobe workers:
// os jobs ficam no Redis para conferência.
import mongoose from 'mongoose';
import { requireIsolatedMongo, requireIsolatedRedis } from './_guard.mjs';

const { uri } = requireIsolatedMongo();
requireIsolatedRedis('REDIS_URL');
await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
const { startOutboxDispatcher } = await import('../../infrastructure/outbox/outboxPattern.js');
const stop = startOutboxDispatcher(Number(process.env.DISPATCHER_INTERVAL_MS || 500));
process.on('SIGTERM', async () => { stop(); await mongoose.disconnect().catch(() => {}); process.exit(0); });
