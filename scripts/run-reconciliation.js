#!/usr/bin/env node
/**
 * 🔗 Roda o Financial Reconciliation Engine
 *
 * Uso:
 *   node scripts/run-reconciliation.js
 *   node scripts/run-reconciliation.js --json > reconciliation.json
 */

import mongoose from 'mongoose';
import { FinancialReconciliationEngine } from '../services/financialGuard/reconciliationEngine.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const JSON_MODE = process.argv.includes('--json');

async function run() {
  console.log('🔗 Iniciando Financial Reconciliation Engine...');
  console.log('⚠️  MODO SIMULAÇÃO — nenhum dado será alterado\n');
  console.time('⏱️ Tempo de execução');

  const result = await FinancialReconciliationEngine.run({ mongoUri: MONGO_URI });

  console.timeEnd('⏱️ Tempo de execução');

  if (JSON_MODE) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { summary } = result;

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  🔗 RELATÓRIO DE RECONCILIAÇÃO FINANCEIRA                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`\nPackages com divergência: ${summary.totalPackages}`);
  console.log(`Matches encontrados: ${summary.totalMatches}`);
  console.log(`  🟢 Alta confiança (>80%): ${summary.highConfidence}`);
  console.log(`  🟡 Média confiança (60-80%): ${summary.mediumConfidence}`);
  console.log(`  🔴 Baixa confiança (30-60%): ${summary.lowConfidence}`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('DETALHES POR PACOTE (ordenado por confiança):');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Ordenar packages pelo maior score
  const sortedPackages = result.packages.sort((a, b) => {
    const maxA = a.matches[0]?.score || 0;
    const maxB = b.matches[0]?.score || 0;
    return maxB - maxA;
  });

  for (const pkg of sortedPackages.slice(0, 50)) {
    console.log(`📦 ${pkg.packageId}`);
    console.log(`   👤 ${pkg.patientName} (${pkg.patientId})`);
    console.log(`   🏥 ${pkg.specialty} | Session Value: R$ ${pkg.sessionValue}`);
    console.log(`   💡 Matches (${pkg.matches.length}):`);

    for (const m of pkg.matches) {
      const icon = m.confidence === 'HIGH' ? '🟢' : m.confidence === 'MEDIUM' ? '🟡' : '🔴';
      console.log(`      ${icon} [${m.score}%] Payment ${m.paymentId}`);
      console.log(`         R$ ${m.paymentAmount} | ${m.paymentMethod} | ${new Date(m.paymentDate).toLocaleDateString('pt-BR')}`);
      console.log(`         → ${m.reason}`);
    }
    console.log('');
  }

  if (sortedPackages.length > 50) {
    console.log(`... e mais ${sortedPackages.length - 50} packages (use --json para ver todos)`);
  }

  console.log('\n✅ Reconciliação completa. Nenhum dado foi alterado.');
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
