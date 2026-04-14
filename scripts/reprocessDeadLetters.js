#!/usr/bin/env node
// scripts/reprocessDeadLetters.js
/**
 * Script CLI para reprocessar eventos em dead letter
 *
 * Uso:
 *   node scripts/reprocessDeadLetters.js --dry-run
 *   node scripts/reprocessDeadLetters.js --eventId <uuid>
 *   node scripts/reprocessDeadLetters.js --aggregateType appointment --limit 10
 *   node scripts/reprocessDeadLetters.js --all
 */

import mongoose from 'mongoose';
import { listDeadLetters, retryDeadLetter, retryBatchDeadLetters } from '../infrastructure/observability/deadLetterService.js';

function printHelp() {
    console.log(`
Uso: node scripts/reprocessDeadLetters.js [opções]

Opções:
  --dry-run                Simula o retry sem executar
  --eventId <uuid>         Retry de um evento específico
  --aggregateType <type>   Filtra por aggregateType (appointment, payment, etc)
  --eventType <type>       Filtra por eventType
  --limit <n>              Limite de eventos para retry em lote (default: 50)
  --all                    Retry de todos os eventos em dead letter (até o limite)
  --help                   Exibe esta ajuda

Exemplos:
  node scripts/reprocessDeadLetters.js --dry-run
  node scripts/reprocessDeadLetters.js --eventId abc-123 --dry-run
  node scripts/reprocessDeadLetters.js --aggregateType appointment --limit 5
  node scripts/reprocessDeadLetters.js --all
`);
}

async function connectMongo() {
    const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/crm_development';
    await mongoose.connect(uri);
    console.log(`[MongoDB] Conectado: ${uri}`);
}

async function disconnectMongo() {
    await mongoose.disconnect();
    console.log('[MongoDB] Desconectado');
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help')) {
        printHelp();
        process.exit(0);
    }

    const dryRun = args.includes('--dry-run');
    const eventIdIndex = args.indexOf('--eventId');
    const eventId = eventIdIndex > -1 ? args[eventIdIndex + 1] : null;
    const aggregateTypeIndex = args.indexOf('--aggregateType');
    const aggregateType = aggregateTypeIndex > -1 ? args[aggregateTypeIndex + 1] : null;
    const eventTypeIndex = args.indexOf('--eventType');
    const eventType = eventTypeIndex > -1 ? args[eventTypeIndex + 1] : null;
    const limitIndex = args.indexOf('--limit');
    const limit = limitIndex > -1 ? Number(args[limitIndex + 1]) : 50;
    const all = args.includes('--all');

    try {
        await connectMongo();

        if (eventId) {
            console.log(`\n[Retry Individual] eventId=${eventId} dryRun=${dryRun}`);
            const result = await retryDeadLetter(eventId, { dryRun });
            console.log(JSON.stringify(result, null, 2));
        } else if (all || aggregateType || eventType) {
            console.log(`\n[Retry em Lote] aggregateType=${aggregateType || '*'} eventType=${eventType || '*'} limit=${limit} dryRun=${dryRun}`);
            const result = await retryBatchDeadLetters({
                aggregateType,
                eventType,
                limit,
                dryRun
            });
            console.log(`Total: ${result.total} | Sucesso: ${result.success} | Falhou: ${result.failed}`);
            if (result.failed > 0) {
                console.log('\nFalhas:');
                result.results.filter(r => !r.success).forEach(r => {
                    console.log(`  - ${r.eventId}: ${r.error} (${r.code})`);
                });
            }
            if (dryRun) {
                console.log('\nDry-run completo. Nenhum evento foi alterado.');
            }
        } else {
            console.log('\n[Listagem de Dead Letters]');
            const list = await listDeadLetters({ limit: 20 });
            console.log(`Total em DLQ: ${list.pagination.total}`);
            list.items.forEach((item, i) => {
                console.log(`\n[${i + 1}] ${item.eventId}`);
                console.log(`  Tipo: ${item.eventType}`);
                console.log(`  Domínio: ${item.aggregateType}`);
                console.log(`  Tentativas: ${item.attempts}`);
                console.log(`  Erro: ${item.error?.message || 'N/A'}`);
                console.log(`  Criado em: ${item.createdAt}`);
            });
            if (list.pagination.total === 0) {
                console.log('Nenhum evento em dead letter.');
            } else {
                console.log('\nDica: use --dry-run --all para simular reprocessamento de todos.');
            }
        }
    } catch (error) {
        console.error('\n[ERRO]', error.message);
        process.exitCode = 1;
    } finally {
        await disconnectMongo();
    }
}

main();
