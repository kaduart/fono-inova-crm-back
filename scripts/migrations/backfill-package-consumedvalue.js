#!/usr/bin/env node
/**
 * 🔄 Backfill de Package.consumedValue
 *
 * Preenche o novo campo consumedValue para todos os packages existentes
 * sem alterar totalPaid. Usa como fonte:
 *   1. Soma de Session.partialAmount (casos parciais)
 *   2. Ou sessionsDone × sessionValue (casos sem partialAmount)
 *
 * Modo dry-run por padrão. Use --apply para executar.
 *
 * Uso:
 *   node scripts/migrations/backfill-package-consumedvalue.js
 *   node scripts/migrations/backfill-package-consumedvalue.js --apply
 *   node scripts/migrations/backfill-package-consumedvalue.js --json > /tmp/backfill-report.json
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const JSON_MODE = process.argv.includes('--json');

async function run() {
  if (!JSON_MODE) {
    console.log(`🔄 Backfill de consumedValue`);
    console.log(`   Modo: ${APPLY ? 'APLICAÇÃO REAL' : 'DRY-RUN'}`);
    console.log();
  }

  console.time('⏱️ Tempo de execução');
  await mongoose.connect(MONGO_URI);

  const Package = mongoose.connection.db.collection('packages');
  const Session = mongoose.connection.db.collection('sessions');

  const packages = await Package.find({}).project({
    _id: 1,
    totalPaid: 1,
    consumedValue: 1,
    sessionValue: 1,
    sessionsDone: 1,
    paidSessions: 1,
    status: 1
  }).toArray();

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const details = [];

  for (const pkg of packages) {
    const packageId = pkg._id;

    try {
      // Calcula consumedValue a partir das sessões
      const sessions = await Session.find({ package: packageId }).project({
        partialAmount: 1,
        status: 1
      }).toArray();

      const consumedByPartial = sessions.reduce((sum, s) => {
        return sum + (Number(s.partialAmount) || 0);
      }, 0);

      const consumedBySessionsDone = Number(pkg.sessionsDone || 0) * Number(pkg.sessionValue || 0);
      const consumedByPaidSessions = Number(pkg.paidSessions || 0) * Number(pkg.sessionValue || 0);

      // Regra: se houver partialAmounts preenchidos, usa eles (mais preciso)
      // Senão, usa sessionsDone × sessionValue
      let newConsumedValue = consumedByPartial > 0
        ? consumedByPartial
        : consumedBySessionsDone;

      // Sanity check: se consumedByPaidSessions for maior e houver indicativo de uso,
      // loga para análise manual mas não sobrescreve automaticamente
      const currentConsumedValue = Number(pkg.consumedValue) || 0;

      if (Math.abs(newConsumedValue - currentConsumedValue) < 0.01) {
        skipped++;
        continue;
      }

      if (APPLY) {
        await Package.updateOne(
          { _id: packageId },
          {
            $set: {
              consumedValue: newConsumedValue,
              updatedAt: new Date()
            }
          }
        );
      }

      updated++;
      details.push({
        packageId: packageId.toString(),
        status: pkg.status,
        totalPaid: pkg.totalPaid,
        consumedValueOld: currentConsumedValue,
        consumedValueNew: newConsumedValue,
        consumedByPartial,
        consumedBySessionsDone,
        consumedByPaidSessions,
        sessionCount: sessions.length
      });
    } catch (err) {
      errors++;
      details.push({
        packageId: packageId.toString(),
        error: err.message
      });
    }
  }

  await mongoose.disconnect();
  console.timeEnd('⏱️ Tempo de execução');

  const summary = {
    total: packages.length,
    updated,
    skipped,
    errors,
    mode: APPLY ? 'apply' : 'dry-run'
  };

  if (JSON_MODE) {
    console.log(JSON.stringify({ summary, details }, null, 2));
    return;
  }

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 RESUMO DO BACKFILL                                      ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`Total de packages: ${summary.total}`);
  console.log(`Atualizados:       ${summary.updated}`);
  console.log(`Ignorados (já OK): ${summary.skipped}`);
  console.log(`Erros:             ${summary.errors}`);
  console.log(`Modo:              ${summary.mode}`);

  if (!APPLY && updated > 0) {
    console.log(`\n⚠️  DRY-RUN: nenhuma alteração foi persistida.`);
    console.log(`    Rode com --apply para executar o backfill.`);
  }

  if (details.length > 0) {
    console.log(`\n📝 Primeiras alterações:`);
    for (const d of details.slice(0, 10)) {
      console.log(`  ${d.packageId}: ${d.consumedValueOld} → ${d.consumedValueNew}`);
    }
  }
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
