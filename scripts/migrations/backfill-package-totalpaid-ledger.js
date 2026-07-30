#!/usr/bin/env node
/**
 * 🔄 Backfill B3.1 — Corrigir Package.totalPaid a partir do ledger
 *
 * Recalcula APENAS totalPaid, balance e financialStatus a partir dos payments.
 * NÃO altera consumedValue, sessionsDone, sessionsRemaining, status nem arrays.
 *
 * Modo dry-run por padrão. Use --apply para persistir.
 *
 * Uso:
 *   node scripts/migrations/backfill-package-totalpaid-ledger.js
 *   node scripts/migrations/backfill-package-totalpaid-ledger.js --apply
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const INCLUDE_CANCELED = process.argv.includes('--include-canceled');

function calculateFinancialStatus(totalPaid, totalValue) {
  if (totalPaid === 0) return 'unpaid';
  if (totalPaid < totalValue) return 'partially_paid';
  return 'paid';
}

async function run() {
  console.log(`🔄 Backfill B3.1 — Corrigir totalPaid via ledger`);
  console.log(`   Modo: ${APPLY ? 'APLICAÇÃO REAL' : 'DRY-RUN'}`);
  console.log(`   Incluir cancelados: ${INCLUDE_CANCELED ? 'SIM' : 'NÃO'}`);
  console.log();

  console.time('⏱️ Tempo de execução');
  await mongoose.connect(MONGO_URI);

  const Package = mongoose.connection.db.collection('packages');
  const Payment = mongoose.connection.db.collection('payments');

  // Busca todos os packages. Por padrão exclui cancelados para ser conservador.
  const packageFilter = INCLUDE_CANCELED ? {} : { status: { $nin: ['canceled'] } };
  const packages = await Package.find(packageFilter).project({
    _id: 1,
    totalValue: 1,
    totalPaid: 1,
    balance: 1,
    financialStatus: 1
  }).toArray();

  console.log(`📦 ${packages.length} packages candidatos`);

  let processed = 0;
  let wouldChange = 0;
  let unchanged = 0;
  let errors = 0;
  const details = [];

  for (const pkg of packages) {
    processed++;
    if (processed % 100 === 0) {
      console.log(`  → ${processed}/${packages.length} processados...`);
    }

    try {
      const payments = await Payment.find({
        package: pkg._id,
        status: { $in: ['paid', 'completed'] }
      }).project({ amount: 1, value: 1 }).toArray();

      const totalPaidFromLedger = payments.reduce((sum, p) => sum + (Number(p.value) || Number(p.amount) || 0), 0);
      const totalValue = Number(pkg.totalValue) || 0;
      const currentTotalPaid = Number(pkg.totalPaid) || 0;

      if (Math.abs(totalPaidFromLedger - currentTotalPaid) < 0.01) {
        unchanged++;
        continue;
      }

      const balance = Math.max(0, totalValue - totalPaidFromLedger);
      const financialStatus = calculateFinancialStatus(totalPaidFromLedger, totalValue);

      wouldChange++;
      details.push({
        packageId: pkg._id.toString(),
        totalValue,
        totalPaidOld: currentTotalPaid,
        totalPaidNew: totalPaidFromLedger,
        balanceOld: pkg.balance,
        balanceNew: balance,
        financialStatusOld: pkg.financialStatus,
        financialStatusNew: financialStatus,
        paymentCount: payments.length
      });

      if (APPLY) {
        await Package.updateOne(
          { _id: pkg._id },
          {
            $set: {
              totalPaid: totalPaidFromLedger,
              balance,
              financialStatus,
              updatedAt: new Date()
            }
          }
        );
      }
    } catch (err) {
      errors++;
      details.push({ packageId: pkg._id.toString(), error: err.message });
    }
  }

  await mongoose.disconnect();
  console.timeEnd('⏱️ Tempo de execução');

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 RESUMO DO BACKFILL B3.1                                 ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`Processados:      ${processed}`);
  console.log(`Sem alteração:    ${unchanged}`);
  console.log(`Alterariam:       ${wouldChange}`);
  console.log(`Erros:            ${errors}`);
  console.log(`Modo:             ${APPLY ? 'apply' : 'dry-run'}`);

  if (!APPLY && wouldChange > 0) {
    console.log(`\n⚠️  DRY-RUN: nenhuma alteração foi persistida.`);
    console.log(`    Rode com --apply para executar o backfill.`);
  }

  if (details.length > 0) {
    console.log(`\n📝 Primeiras alterações previstas:`);
    for (const d of details.slice(0, 10)) {
      console.log(`  ${d.packageId}: totalPaid ${d.totalPaidOld} → ${d.totalPaidNew}, balance ${d.balanceOld} → ${d.balanceNew}`);
    }
  }

  const fs = await import('fs');
  const reportPath = `/tmp/backfill-b31-report-${Date.now()}.json`;
  fs.writeFileSync(reportPath, JSON.stringify({
    meta: { mode: APPLY ? 'apply' : 'dry-run', totalCandidates: packages.length },
    summary: { processed, unchanged, wouldChange, errors },
    details
  }, null, 2));
  console.log(`\n💾 Relatório detalhado: ${reportPath}`);
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
