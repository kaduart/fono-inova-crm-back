#!/usr/bin/env node
/**
 * 🔄 Backfill PR B.1 — Preencher financialBalance e consumptionBalance
 *
 * Para cada Package, calcula:
 *   financialBalance   = totalValue - totalPaid
 *   consumptionBalance = totalValue - consumedValue
 *
 * O campo legado `balance` continua refletindo financialBalance.
 *
 * Modo dry-run por padrão. Use --apply para persistir.
 *
 * Uso:
 *   node scripts/migrations/backfill-package-balances-b1-1.js
 *   node scripts/migrations/backfill-package-balances-b1-1.js --apply
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

async function run() {
  console.log(`🔄 Backfill PR B.1 — financialBalance / consumptionBalance`);
  console.log(`   Modo: ${APPLY ? 'APLICAÇÃO REAL' : 'DRY-RUN'}`);
  console.log();

  console.time('⏱️ Tempo de execução');
  await mongoose.connect(MONGO_URI);

  const Package = mongoose.connection.db.collection('packages');
  const packages = await Package.find({}).project({
    _id: 1,
    totalValue: 1,
    totalPaid: 1,
    consumedValue: 1,
    balance: 1,
    financialBalance: 1,
    consumptionBalance: 1
  }).toArray();

  console.log(`📦 ${packages.length} packages candidatos`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const details = [];

  for (const pkg of packages) {
    const totalValue = Number(pkg.totalValue) || 0;
    const totalPaid = Number(pkg.totalPaid) || 0;
    const consumedValue = Number(pkg.consumedValue) || 0;

    const financialBalance = totalValue - totalPaid;
    const consumptionBalance = totalValue - consumedValue;

    const currentFinancial = Number(pkg.financialBalance);
    const currentConsumption = Number(pkg.consumptionBalance);
    const currentBalance = Number(pkg.balance);

    if (
      Math.abs(financialBalance - currentFinancial) < 0.01 &&
      Math.abs(consumptionBalance - currentConsumption) < 0.01 &&
      Math.abs(financialBalance - currentBalance) < 0.01
    ) {
      skipped++;
      continue;
    }

    if (APPLY) {
      await Package.updateOne(
        { _id: pkg._id },
        {
          $set: {
            financialBalance,
            consumptionBalance,
            balance: financialBalance,
            updatedAt: new Date()
          }
        }
      );
    }

    updated++;
    details.push({
      packageId: pkg._id.toString(),
      totalValue,
      totalPaid,
      consumedValue,
      financialBalanceOld: pkg.financialBalance,
      financialBalanceNew: financialBalance,
      consumptionBalanceOld: pkg.consumptionBalance,
      consumptionBalanceNew: consumptionBalance,
      balanceOld: pkg.balance,
      balanceNew: financialBalance
    });
  }

  await mongoose.disconnect();
  console.timeEnd('⏱️ Tempo de execução');

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 RESUMO DO BACKFILL B.1                                  ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`Total de packages: ${packages.length}`);
  console.log(`Atualizados:       ${updated}`);
  console.log(`Ignorados (já OK): ${skipped}`);
  console.log(`Erros:             ${errors}`);
  console.log(`Modo:              ${APPLY ? 'apply' : 'dry-run'}`);

  if (!APPLY && updated > 0) {
    console.log(`\n⚠️  DRY-RUN: nenhuma alteração foi persistida.`);
    console.log(`    Rode com --apply para executar o backfill.`);
  }

  if (details.length > 0) {
    console.log(`\n📝 Primeiras alterações:`);
    for (const d of details.slice(0, 10)) {
      console.log(`  ${d.packageId}: financialBalance=${d.financialBalanceOld}→${d.financialBalanceNew}, consumptionBalance=${d.consumptionBalanceOld}→${d.consumptionBalanceNew}`);
    }
  }
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
