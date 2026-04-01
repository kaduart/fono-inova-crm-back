#!/usr/bin/env node
// scripts/replay-events.js
// Script para reprocessar eventos do Event Store
// 
// USO:
// node scripts/replay-events.js --aggregate=appointment --id=123
// node scripts/replay-events.js --eventType=APPOINTMENT_CREATED --from=2026-03-01
// node scripts/replay-events.js --pending --limit=100

import 'dotenv/config';
import mongoose from 'mongoose';
import { 
  replayAggregate, 
  replayByEventType, 
  getPendingEvents,
  getStats 
} from '../infrastructure/events/eventStoreService.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger(null, 'replay');

// Parse args
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.split('=');
  if (key.startsWith('--')) {
    acc[key.slice(2)] = value || true;
  }
  return acc;
}, {});

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║           🔄 EVENT STORE REPLAY TOOL                   ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  // Conecta ao MongoDB
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Conectado ao MongoDB\n');

  try {
    // Modo: Estatísticas
    if (args.stats) {
      console.log('📊 Estatísticas do Event Store:\n');
      const stats = await getStats();
      console.table(stats);
      return;
    }

    // Modo: Reprocessar pendentes
    if (args.pending) {
      const limit = parseInt(args.limit) || 100;
      console.log(`🔍 Buscando eventos pendentes (limit: ${limit})...\n`);
      
      const pending = await getPendingEvents({ limit });
      
      if (pending.length === 0) {
        console.log('✅ Nenhum evento pendente encontrado');
        return;
      }

      console.log(`📋 ${pending.length} eventos pendentes encontrados:\n`);
      
      for (const event of pending) {
        console.log(`  - ${event.eventType} (${event.aggregateType} ${event.aggregateId})`);
        console.log(`    Status: ${event.status}, Tentativas: ${event.attempts}`);
        console.log(`    Erro: ${event.error?.message || 'N/A'}\n`);
      }
      
      return;
    }

    // Modo: Replay por aggregate
    if (args.aggregate && args.id) {
      console.log(`🔄 Reprocessando aggregate: ${args.aggregate} ${args.id}\n`);
      
      const fromSequence = parseInt(args.fromSequence) || 0;
      
      const result = await replayAggregate(
        args.aggregate,
        args.id,
        async (event) => {
          console.log(`  → ${event.eventType} (seq: ${event.sequenceNumber})`);
          // Aqui você chamaria o handler real
          // Por enquanto só loga
          return { replayed: true };
        },
        { fromSequence, stopOnError: args.stopOnError }
      );

      console.log(`\n✅ Replay concluído:`);
      console.log(`   Total: ${result.total}`);
      console.log(`   Sucesso: ${result.processed}`);
      console.log(`   Falhas: ${result.failed}`);
      
      return;
    }

    // Modo: Replay por tipo de evento
    if (args.eventType) {
      console.log(`🔄 Reprocessando eventos do tipo: ${args.eventType}\n`);
      
      const result = await replayByEventType(
        args.eventType,
        async (event) => {
          console.log(`  → ${event.eventId} (${event.aggregateId})`);
          return { replayed: true };
        },
        { 
          fromDate: args.from, 
          toDate: args.to,
          limit: parseInt(args.limit) || 1000,
          stopOnError: args.stopOnError 
        }
      );

      console.log(`\n✅ Replay concluído:`);
      console.log(`   Total: ${result.total}`);
      console.log(`   Sucesso: ${result.processed}`);
      console.log(`   Falhas: ${result.failed}`);
      
      return;
    }

    // Help
    console.log('❌ Uso incorreto. Opções:\n');
    console.log('  --stats                    Estatísticas do Event Store');
    console.log('  --pending [--limit=N]      Lista eventos pendentes');
    console.log('  --aggregate=TYPE --id=ID   Replay de um aggregate');
    console.log('  --eventType=TYPE           Replay por tipo de evento');
    console.log('  [--from=YYYY-MM-DD]        Data inicial');
    console.log('  [--to=YYYY-MM-DD]          Data final');
    console.log('  [--stopOnError]            Parar no primeiro erro');
    console.log('\nExemplos:');
    console.log('  node scripts/replay-events.js --stats');
    console.log('  node scripts/replay-events.js --pending --limit=10');
    console.log('  node scripts/replay-events.js --aggregate=appointment --id=123');
    console.log('  node scripts/replay-events.js --eventType=APPOINTMENT_CREATED --from=2026-03-01');

  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Desconectado');
  }
}

main().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
