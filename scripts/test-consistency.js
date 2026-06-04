/**
 * 🧪 TESTE DE CONSISTÊNCIA FINANCEIRA
 *
 * Compara realtime (unifiedFinancialService) vs snapshot (FinancialDailySnapshot)
 * para cada dia de um período.
 *
 * Uso: node scripts/test-consistency.js [YYYY-MM-DD] [YYYY-MM-DD]
 * Ex:  node scripts/test-consistency.js 2026-06-01 2026-06-03
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import unifiedFinancialService from '../services/unifiedFinancialService.v2.js';
import FinancialDailySnapshot from '../models/FinancialDailySnapshot.js';

const TIMEZONE = 'America/Sao_Paulo';

async function connect() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ MONGO_URI não definido');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('✅ MongoDB conectado');
}

async function disconnect() {
  await mongoose.disconnect();
  console.log('✅ MongoDB desconectado');
}

function formatDate(date) {
  return moment.tz(date, TIMEZONE).format('YYYY-MM-DD');
}

async function checkDay(dateStr) {
  const start = moment.tz(dateStr, TIMEZONE).startOf('day').toDate();
  const end = moment.tz(dateStr, TIMEZONE).endOf('day').toDate();

  // Realtime
  const cash = await unifiedFinancialService.calculateCash(start, end);
  const production = await unifiedFinancialService.calculateProduction(start, end);

  // Snapshot
  const snapshot = await FinancialDailySnapshot.findOne({ date: dateStr }).lean();

  return {
    date: dateStr,
    realtime: {
      cash: {
        total: cash.total,
        particular: cash.particular,
        pacote: cash.pacote,
        convenio: cash.convenio,
        liminar: cash.liminar,
        count: cash.count
      },
      production: {
        total: production.total,
        particular: production.particular,
        pacote: production.pacote,
        convenio: production.convenio,
        liminar: production.liminar,
        count: production.count
      }
    },
    snapshot: snapshot ? {
      cash: {
        total: snapshot.cash?.total || 0,
        particular: snapshot.cash?.particular || 0,
        pacote: snapshot.cash?.pacote || 0,
        convenio: snapshot.cash?.convenioAvulso || 0,
        liminar: snapshot.cash?.liminar || 0
      },
      production: {
        total: snapshot.production?.total || 0,
        particular: snapshot.production?.byBusinessType?.particular?.total || 0,
        pacote: snapshot.production?.byBusinessType?.pacote?.total || 0,
        convenio: snapshot.production?.byBusinessType?.convenio?.total || 0,
        liminar: snapshot.production?.byBusinessType?.liminar?.total || 0
      }
    } : null
  };
}

function printComparison(result) {
  const { date, realtime, snapshot } = result;

  console.log(`\n📅 ${date}`);
  console.log('───────────────────────────────────────────────────────────────');

  // Cash
  console.log('💰 CAIXA:');
  console.log(`  Realtime:  R$ ${realtime.cash.total.toFixed(2).padStart(10)} (P:${realtime.cash.particular} Pk:${realtime.cash.pacote} C:${realtime.cash.convenio} L:${realtime.cash.liminar}) [${realtime.cash.count} pagamentos]`);
  if (snapshot) {
    console.log(`  Snapshot:  R$ ${snapshot.cash.total.toFixed(2).padStart(10)} (P:${snapshot.cash.particular} Pk:${snapshot.cash.pacote} C:${snapshot.cash.convenio} L:${snapshot.cash.liminar})`);
    const diff = realtime.cash.total - snapshot.cash.total;
    const ok = Math.abs(diff) < 0.01;
    console.log(`  Status:    ${ok ? '✅ OK' : `❌ DIVERGÊNCIA: R$ ${diff.toFixed(2)}`}`);
  } else {
    console.log('  Snapshot:  ❌ NÃO EXISTE');
  }

  // Production
  console.log('🏭 PRODUÇÃO:');
  console.log(`  Realtime:  R$ ${realtime.production.total.toFixed(2).padStart(10)} (P:${realtime.production.particular} Pk:${realtime.production.pacote} C:${realtime.production.convenio} L:${realtime.production.liminar}) [${realtime.production.count} sessões]`);
  if (snapshot) {
    console.log(`  Snapshot:  R$ ${snapshot.production.total.toFixed(2).padStart(10)} (P:${snapshot.production.particular} Pk:${snapshot.production.pacote} C:${snapshot.production.convenio} L:${snapshot.production.liminar})`);
    const diff = realtime.production.total - snapshot.production.total;
    const ok = Math.abs(diff) < 0.01;
    console.log(`  Status:    ${ok ? '✅ OK' : `❌ DIVERGÊNCIA: R$ ${diff.toFixed(2)}`}`);
  } else {
    console.log('  Snapshot:  ❌ NÃO EXISTE');
  }
}

async function main() {
  const startStr = process.argv[2] || '2026-06-01';
  const endStr = process.argv[3] || '2026-06-03';

  console.log(`🧪 Teste de consistência: ${startStr} → ${endStr}`);
  console.log('Realtime = unifiedFinancialService.calculateCash/Production');
  console.log('Snapshot = FinancialDailySnapshot (cache/materialized view)');

  await connect();

  let current = moment.tz(startStr, TIMEZONE);
  const end = moment.tz(endStr, TIMEZONE);

  let divergenciasCash = 0;
  let divergenciasProd = 0;
  let snapshotsFaltando = 0;

  while (current.isSameOrBefore(end, 'day')) {
    const dateStr = current.format('YYYY-MM-DD');
    const result = await checkDay(dateStr);
    printComparison(result);

    if (!result.snapshot) snapshotsFaltando++;
    if (result.snapshot && Math.abs(result.realtime.cash.total - result.snapshot.cash.total) >= 0.01) divergenciasCash++;
    if (result.snapshot && Math.abs(result.realtime.production.total - result.snapshot.production.total) >= 0.01) divergenciasProd++;

    current.add(1, 'day');
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 RESUMO:');
  console.log(`  Dias verificados:     ${end.diff(moment.tz(startStr, TIMEZONE), 'days') + 1}`);
  console.log(`  Snapshots faltando:   ${snapshotsFaltando}`);
  console.log(`  Divergências Caixa:   ${divergenciasCash}`);
  console.log(`  Divergências Produção: ${divergenciasProd}`);
  console.log('═══════════════════════════════════════════════════════════════');

  await disconnect();
}

main().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
