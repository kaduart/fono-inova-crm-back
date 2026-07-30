#!/usr/bin/env node
/**
 * 🔄 Backfill PR B3 — Recalcular Package.totalPaid via ledger
 *
 * Para cada Package, recalcula a partir das fontes de verdade:
 *   - totalPaid = SUM(Payment.amount WHERE status='paid' AND package=this._id)
 *   - consumedValue = sessionsDone × sessionValue
 *   - balance = max(0, totalPaid - consumedValue)  [prepaid / crédito restante]
 *
 * ⚠️ Este script usa rebuildPackageFromSource, que RECONSTRÓI vários campos
 * derivados (sessionsDone, sessionsRemaining, arrays sessions/appointments, etc).
 * NÃO altera campos transacionais (totalValue, sessionValue original).
 *
 * Modo dry-run por padrão. Use --apply para persistir.
 *
 * Uso:
 *   node scripts/migrations/backfill-package-financials-b3.js
 *   node scripts/migrations/backfill-package-financials-b3.js --apply
 *   node scripts/migrations/backfill-package-financials-b3.js --only-inconsistent
 */

import mongoose from 'mongoose';
import { auditPackage, rebuildPackageFromSource } from '../../domain/package/rebuildPackageFromSource.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const ONLY_INCONSISTENT = process.argv.includes('--only-inconsistent');

async function run() {
  console.log(`🔄 Backfill PR B3 — Recalcular totalPaid via ledger`);
  console.log(`   Modo: ${APPLY ? 'APLICAÇÃO REAL' : 'DRY-RUN'}`);
  console.log(`   Filtro: ${ONLY_INCONSISTENT ? 'apenas inconsistentes' : 'todos'}`);
  console.log();

  console.time('⏱️ Tempo de execução');
  await mongoose.connect(MONGO_URI);

  const Package = mongoose.connection.db.collection('packages');

  let filter = {};
  if (ONLY_INCONSISTENT) {
    // Exclui packages já cancelados — não vamos reconstruir pacotes mortos
    filter = { status: { $nin: ['canceled'] } };
  }

  const packages = await Package.find(filter).project({ _id: 1 }).toArray();
  console.log(`📦 ${packages.length} packages candidatos`);

  let processed = 0;
  let wouldChange = 0;
  let unchanged = 0;
  let errors = 0;
  const details = [];

  for (const { _id } of packages) {
    processed++;
    if (processed % 100 === 0) {
      console.log(`  → ${processed}/${packages.length} processados...`);
    }

    try {
      const audit = await auditPackage(_id);
      if (!audit) {
        errors++;
        details.push({ packageId: _id.toString(), error: 'auditPackage retornou null' });
        continue;
      }

      if (!audit.hasIssues) {
        unchanged++;
        continue;
      }

      wouldChange++;
      details.push({
        packageId: _id.toString(),
        issues: audit.issues,
        current: audit.current,
        rebuilt: audit.rebuilt
      });

      if (APPLY) {
        await rebuildPackageFromSource(_id);
      }
    } catch (err) {
      errors++;
      details.push({ packageId: _id.toString(), error: err.message });
    }
  }

  await mongoose.disconnect();
  console.timeEnd('⏱️ Tempo de execução');

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 RESUMO DO BACKFILL B3                                   ║');
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
      console.log(`  ${d.packageId}: ${d.issues?.join(' | ') || d.error}`);
    }
  }

  // Salva relatório detalhado
  const fs = await import('fs');
  const reportPath = `/tmp/backfill-b3-report-${Date.now()}.json`;
  fs.writeFileSync(reportPath, JSON.stringify({
    meta: {
      mode: APPLY ? 'apply' : 'dry-run',
      onlyInconsistent: ONLY_INCONSISTENT,
      totalCandidates: packages.length
    },
    summary: { processed, unchanged, wouldChange, errors },
    details
  }, null, 2));
  console.log(`\n💾 Relatório detalhado: ${reportPath}`);
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
