#!/usr/bin/env node
/**
 * =============================================================================
 * SCRIPT DE REPROCESSAMENTO DE EVENTOS WHATSAPP
 * =============================================================================
 * 
 * Recupera mensagens que foram salvas no Event Store (MongoDB) quando o Redis
 * estava fora do ar, e reenfileira elas para processamento.
 * 
 * Uso:
 *   node scripts/reprocessar-eventos-whatsapp.js [opções]
 * 
 * Opções:
 *   --dry-run       Apenas mostra o que seria reprocessado, não executa
 *   --since=DATA    Data de início (ISO 8601), padrão: 7 dias atrás
 *   --status=STATUS Status dos eventos (pending,failed,all), padrão: pending
 *   --limit=N       Limite de eventos, padrão: 1000
 * 
 * Exemplos:
 *   node scripts/reprocessar-eventos-whatsapp.js --dry-run
 *   node scripts/reprocessar-eventos-whatsapp.js --since=2026-04-01T00:00:00Z
 *   node scripts/reprocessar-eventos-whatsapp.js --status=failed --limit=100
 * =============================================================================
 */

import mongoose from 'mongoose';
import { config } from 'dotenv';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import EventStore from '../models/EventStore.js';

// Carrega .env
config();

// Parse args
const args = process.argv.slice(2).reduce((acc, arg) => {
  if (arg === '--dry-run') acc.dryRun = true;
  if (arg.startsWith('--since=')) acc.since = arg.split('=')[1];
  if (arg.startsWith('--status=')) acc.status = arg.split('=')[1];
  if (arg.startsWith('--limit=')) acc.limit = parseInt(arg.split('=')[1]);
  return acc;
}, { 
  dryRun: false, 
  since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 dias
  status: 'pending', // pending, failed, all
  limit: 1000 
});

console.log('🔧 Configuração:');
console.log(`   Dry run: ${args.dryRun ? 'SIM' : 'NÃO'}`);
console.log(`   Desde: ${args.since}`);
console.log(`   Status: ${args.status}`);
console.log(`   Limite: ${args.limit}`);

// Eventos WhatsApp que queremos reprocessar
const WHATSAPP_EVENT_TYPES = [
  EventTypes.WHATSAPP_MESSAGE_RECEIVED,
  EventTypes.WHATSAPP_MESSAGE_REQUESTED,
  EventTypes.MESSAGE_RESPONSE_DETECTED,
  EventTypes.FOLLOWUP_REQUESTED,
  EventTypes.FOLLOWUP_SCHEDULED
];

async function connectDB() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI ou MONGO_URI não definido no .env');
  }
  
  console.log('\n📡 Conectando ao MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('✅ MongoDB conectado');
}

async function buscarEventosPendentes() {
  const sinceDate = new Date(args.since);
  
  const statusFilter = args.status === 'all' 
    ? ['pending', 'failed'] 
    : [args.status];
  
  const query = {
    eventType: { $in: WHATSAPP_EVENT_TYPES },
    status: { $in: statusFilter },
    createdAt: { $gte: sinceDate }
  };
  
  console.log(`\n🔍 Buscando eventos...`);
  console.log(`   Filtro: ${JSON.stringify(query, null, 2)}`);
  
  const eventos = await EventStore.find(query)
    .sort({ createdAt: 1 })
    .limit(args.limit)
    .lean();
  
  console.log(`   Encontrados: ${eventos.length} eventos`);
  
  return eventos;
}

async function reprocessarEvento(evento) {
  const { eventId, eventType, payload, correlationId, idempotencyKey, aggregateId, aggregateType } = evento;
  
  console.log(`\n📨 Reprocessando: ${eventType}`);
  console.log(`   Event ID: ${eventId}`);
  console.log(`   Criado em: ${evento.createdAt}`);
  console.log(`   Aggregate: ${aggregateType}/${aggregateId}`);
  
  if (args.dryRun) {
    console.log('   [DRY-RUN] Não enviado para fila');
    return { success: true, dryRun: true };
  }
  
  try {
    // Re-publica o evento nas filas
    const result = await publishEvent(eventType, payload, {
      correlationId: correlationId || eventId,
      idempotencyKey: idempotencyKey || `${eventId}_reprocess`,
      aggregateType,
      aggregateId,
      metadata: {
        ...evento.metadata,
        reprocessed: true,
        originalEventId: eventId,
        reprocessedAt: new Date().toISOString()
      }
    });
    
    // Atualiza status do evento original para 'processed' para não reprocessar de novo
    await EventStore.updateOne(
      { eventId },
      { 
        $set: { 
          status: 'processed',
          processedAt: new Date(),
          processedBy: 'reprocess-script',
          'metadata.reprocessedTo': result.eventId
        }
      }
    );
    
    console.log(`   ✅ Reenfileirado: ${result.jobs?.length || 0} jobs criados`);
    return { success: true, result };
    
  } catch (error) {
    console.error(`   ❌ Erro: ${error.message}`);
    
    // Incrementa tentativas e mantém como failed
    await EventStore.updateOne(
      { eventId },
      { 
        $inc: { attempts: 1 },
        $set: { 
          status: 'failed',
          'error.message': error.message,
          'error.code': error.code
        }
      }
    );
    
    return { success: false, error: error.message };
  }
}

async function gerarRelatorio(eventos, resultados) {
  const sucessos = resultados.filter(r => r.success);
  const falhas = resultados.filter(r => !r.success);
  
  // Agrupa por tipo de evento
  const porTipo = eventos.reduce((acc, e, i) => {
    const tipo = e.eventType;
    if (!acc[tipo]) acc[tipo] = { total: 0, sucesso: 0, falha: 0 };
    acc[tipo].total++;
    if (resultados[i]?.success) acc[tipo].sucesso++;
    else acc[tipo].falha++;
    return acc;
  }, {});
  
  console.log('\n' + '='.repeat(70));
  console.log('📊 RELATÓRIO DE REPROCESSAMENTO');
  console.log('='.repeat(70));
  console.log(`Total de eventos: ${eventos.length}`);
  console.log(`✅ Sucessos: ${sucessos.length}`);
  console.log(`❌ Falhas: ${falhas.length}`);
  
  if (args.dryRun) {
    console.log('\n⚠️  MODO DRY-RUN: Nenhum evento foi realmente reprocessado');
  }
  
  console.log('\n📈 Por tipo de evento:');
  Object.entries(porTipo).forEach(([tipo, stats]) => {
    console.log(`   ${tipo}:`);
    console.log(`      Total: ${stats.total}`);
    console.log(`      Sucesso: ${stats.sucesso}`);
    console.log(`      Falha: ${stats.falha}`);
  });
  
  if (falhas.length > 0) {
    console.log('\n❌ Falhas detalhadas:');
    falhas.forEach((f, i) => {
      console.log(`   ${i + 1}. ${f.error}`);
    });
  }
  
  console.log('='.repeat(70));
}

async function main() {
  try {
    await connectDB();
    
    // Busca eventos
    const eventos = await buscarEventosPendentes();
    
    if (eventos.length === 0) {
      console.log('\n✨ Nenhum evento pendente encontrado');
      process.exit(0);
    }
    
    // Confirmação em modo real
    if (!args.dryRun) {
      console.log(`\n⚠️  ATENÇÃO: Você está prestes a reprocessar ${eventos.length} eventos.`);
      console.log('   Os eventos serão reenfileirados nas filas BullMQ.');
      
      // Se quiser confirmação interativa, descomente:
      // const readline = await import('readline');
      // ... código de confirmação ...
    }
    
    // Processa eventos
    console.log('\n🚀 Iniciando reprocessamento...\n');
    const resultados = [];
    
    for (let i = 0; i < eventos.length; i++) {
      const evento = eventos[i];
      console.log(`[${i + 1}/${eventos.length}]`);
      
      const resultado = await reprocessarEvento(evento);
      resultados.push(resultado);
      
      // Pequeno delay para não sobrecarregar
      if (!args.dryRun) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    
    // Relatório final
    await gerarRelatorio(eventos, resultados);
    
    console.log('\n✅ Script concluído');
    process.exit(0);
    
  } catch (error) {
    console.error('\n💥 Erro fatal:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Executa
main();
