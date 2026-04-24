#!/usr/bin/env node
// scripts/reprocessPendingWhatsAppEvents.js
/**
 * Reprocessa eventos WHATSAPP_MESSAGE_RECEIVED pendentes no EventStore
 * que perderam seus jobs na fila BullMQ (ex: workers offline, fila limpa).
 *
 * Uso:
 *   node scripts/reprocessPendingWhatsAppEvents.js --dry-run
 *   node scripts/reprocessPendingWhatsAppEvents.js --limit 50
 */

import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import { bullMqConnection } from '../config/redisConnection.js';

async function connectMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/crm_development';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  console.log('[MongoDB] Conectado');
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex > -1 ? parseInt(args[limitIndex + 1], 10) : 200;

  console.log(`[Reprocess] Modo: ${dryRun ? 'DRY-RUN' : 'EXECUÇÃO'}`);
  console.log(`[Reprocess] Limite: ${limit}`);

  await connectMongo();

  const EventStore = (await import('../models/EventStore.js')).default;
  const queue = new Queue('whatsapp-inbound', { connection: bullMqConnection });

  // Busca eventos pendentes antigos (mais de 10 min)
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const pendingEvents = await EventStore.find({
    eventType: 'WHATSAPP_MESSAGE_RECEIVED',
    status: 'pending',
    createdAt: { $lte: cutoff }
  }).sort({ createdAt: 1 }).limit(limit).lean();

  console.log(`[Reprocess] Encontrados ${pendingEvents.length} eventos pendentes`);

  let success = 0;
  let skipped = 0;

  for (const evt of pendingEvents) {
    if (!evt.payload?.msg) {
      console.log(`[Reprocess] ⚠️ Pulando evento ${evt.eventId} (sem msg no payload)`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`[Reprocess] 📝 DRY-RUN: Reenviaria evento ${evt.eventId} (aggregateId: ${evt.aggregateId})`);
      success++;
      continue;
    }

    try {
      const jobData = {
        eventId: evt.eventId,
        eventType: evt.eventType,
        correlationId: evt.metadata?.correlationId || evt.eventId,
        idempotencyKey: evt.idempotencyKey,
        aggregateType: evt.aggregateType,
        aggregateId: evt.aggregateId,
        payload: evt.payload,
        publishedAt: evt.createdAt,
        eventStoreId: evt._id
      };

      await queue.add(evt.eventType, jobData, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 }
      });

      console.log(`[Reprocess] ✅ Reenviado evento ${evt.eventId}`);
      success++;
    } catch (err) {
      console.error(`[Reprocess] ❌ Falha ao reenviar ${evt.eventId}:`, err.message);
    }
  }

  await queue.close();
  await mongoose.disconnect();

  console.log(`\n[Reprocess] Resumo: ${success} reenviados, ${skipped} pulados`);
  process.exit(0);
}

main().catch(err => {
  console.error('[Reprocess] Erro fatal:', err);
  process.exit(1);
});
