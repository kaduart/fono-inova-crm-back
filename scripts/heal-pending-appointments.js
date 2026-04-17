#!/usr/bin/env node
/**
 * 🩹 HEAL: Marca eventos de appointment travados em pending como processed
 *
 * Cenário: o appointmentWorker anterior não marcava eventos como processed
 * quando o appointment já estava com status 'scheduled'. Isso deixou eventos
 * APPOINTMENT_CREATED (e similares) presos em 'pending' no Event Store.
 *
 * Uso:
 *   cd /home/user/projetos/crm/back && node scripts/heal-pending-appointments.js
 *   # ou com dry-run:
 *   DRY_RUN=true node scripts/heal-pending-appointments.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = process.env.DRY_RUN === 'true';
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI não configurada');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 30000
  });

  await import('../models/index.js');
  const { default: EventStore } = await import('../models/EventStore.js');
  const { default: Appointment } = await import('../models/Appointment.js');

  // Busca eventos de appointment travados em pending
  const stuckEvents = await EventStore.find({
    aggregateType: 'appointment',
    status: { $in: ['pending', 'processing'] },
    createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // últimos 7 dias
  }).lean();

  console.log(`🔍 Encontrados ${stuckEvents.length} eventos de appointment pendentes/processing`);

  let healed = 0;
  let skipped = 0;
  let errors = 0;

  for (const event of stuckEvents) {
    const appointmentId = event.payload?.appointmentId || event.aggregateId;

    try {
      const appointment = await Appointment.findById(appointmentId).lean();

      if (!appointment) {
        console.log(`⏭️  [${event.eventId}] Appointment ${appointmentId} não encontrado — aguardando worker`);
        skipped++;
        continue;
      }

      // Se o appointment já foi processado (não está mais pending/processing_create),
      // o evento pode ser marcado como processed
      const processableStatuses = ['pending', 'processing_create'];
      if (!processableStatuses.includes(appointment.operationalStatus)) {
        if (!DRY_RUN) {
          await EventStore.updateOne(
            { _id: event._id },
            {
              $set: {
                status: 'processed',
                processedAt: new Date(),
                'metadata.healedBy': 'heal-pending-appointments.js',
                'metadata.healedAt': new Date().toISOString()
              }
            }
          );
        }
        console.log(`✅ [${event.eventId}] ${event.eventType} → healed (appointment status: ${appointment.operationalStatus})${DRY_RUN ? ' [DRY RUN]' : ''}`);
        healed++;
      } else {
        console.log(`⏭️  [${event.eventId}] Appointment ${appointmentId} ainda está ${appointment.operationalStatus} — mantendo pending`);
        skipped++;
      }
    } catch (err) {
      console.error(`❌ [${event.eventId}] Erro:`, err.message);
      errors++;
    }
  }

  console.log('\n📊 Resumo:');
  console.log(`   Healed:  ${healed}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors:  ${errors}`);
  console.log(DRY_RUN ? '\n⚠️  DRY RUN — nenhuma alteração foi feita' : '\n🩹 Heal concluído');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro fatal:', err.message);
  process.exit(1);
});
