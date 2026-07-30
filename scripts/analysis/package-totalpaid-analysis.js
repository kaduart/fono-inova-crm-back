#!/usr/bin/env node
/**
 * 📊 Análise de divergência Package.totalPaid vs ledger real
 *
 * Objetivo: gerar baseline para a PR B — Separação Financeiro x Consumo.
 *
 * Para cada Package, calcula:
 *   - totalPaid atual no documento
 *   - soma real dos Payment.amount com status='paid' vinculados ao package
 *   - consumedValue estimado a partir de sessões quitadas × sessionValue
 *   - divergências entre esses três números
 *
 * Uso:
 *   node scripts/analysis/package-totalpaid-analysis.js
 *   node scripts/analysis/package-totalpaid-analysis.js --json > /tmp/pkg-analysis.json
 *   node scripts/analysis/package-totalpaid-analysis.js --csv > /tmp/pkg-analysis.csv
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const JSON_MODE = process.argv.includes('--json');
const CSV_MODE = process.argv.includes('--csv');

async function run() {
  console.error('🔍 Iniciando análise de Package.totalPaid...\n');
  console.error('⏱️ Timer iniciado');
  console.time('⏱️ Tempo de execução');

  await mongoose.connect(MONGO_URI);

  const Package = mongoose.connection.db.collection('packages');
  const Payment = mongoose.connection.db.collection('payments');

  // Carrega todos os packages relevantes (excluímos canceled/finished sem sessões)
  const packages = await Package.find({
    status: { $nin: ['canceled'] }
  }).project({
    _id: 1,
    patient: 1,
    totalPaid: 1,
    totalValue: 1,
    consumedValue: 1,
    sessionValue: 1,
    sessionsDone: 1,
    paidSessions: 1,
    preConsumedCount: 1,
    canceledSessions: 1,
    status: 1,
    model: 1,
    type: 1,
    payments: 1
  }).toArray();

  console.error(`📦 ${packages.length} packages carregados`);

  const results = [];
  let i = 0;

  for (const pkg of packages) {
    i++;
    if (i % 500 === 0) {
      console.error(`  → processados ${i}/${packages.length}`);
    }

    const packageId = pkg._id.toString();

    // Soma de payments pagos vinculados ao package
    const payments = await Payment.find({
      package: pkg._id,
      status: 'paid'
    }).project({ amount: 1, status: 1, kind: 1, billingType: 1 }).toArray();

    const sumPaidPayments = payments.reduce((acc, p) => acc + (Number(p.amount) || 0), 0);

    // Estimativas de consumedValue
    const sessionValue = Number(pkg.sessionValue) || 0;
    const consumedBySessionsDone = Number(pkg.sessionsDone || 0) * sessionValue;
    const consumedByPaidSessions = Number(pkg.paidSessions || 0) * sessionValue;
    const consumedByPreConsumed = Number(pkg.preConsumedCount || 0) * sessionValue;

    const totalPaid = Number(pkg.totalPaid) || 0;
    const totalValue = Number(pkg.totalValue) || 0;

    const financialDivergence = totalPaid - sumPaidPayments;
    const consumedDivergencePaid = totalPaid - consumedByPaidSessions;
    const consumedDivergenceDone = totalPaid - consumedBySessionsDone;

    // Classificação
    const classifications = [];

    if (Math.abs(financialDivergence) > 0.01) {
      if (totalPaid > sumPaidPayments) {
        classifications.push('OVERPAID_VS_LEDGER');
      } else {
        classifications.push('UNDERPAID_VS_LEDGER');
      }
    }

    // Se totalPaid bate com consumed mas não bate com ledger,
    // é forte indício de que totalPaid estava sendo usado como consumedValue
    if (Math.abs(consumedDivergencePaid) < 0.01 && Math.abs(financialDivergence) > 0.01) {
      classifications.push('TOTALPAID_USED_AS_CONSUMED');
    }

    if (Math.abs(consumedDivergencePaid) > 0.01 && Math.abs(financialDivergence) < 0.01) {
      classifications.push('LEDGER_OK_BUT_CONSUMED_MISMATCH');
    }

    if (Math.abs(financialDivergence) <= 0.01 && Math.abs(consumedDivergencePaid) <= 0.01) {
      classifications.push('CONSISTENT');
    }

    if (classifications.length === 0) {
      classifications.push('MIXED_DIVERGENCE');
    }

    results.push({
      packageId,
      patientId: pkg.patient?.toString() || '',
      status: pkg.status,
      model: pkg.model,
      type: pkg.type,
      totalPaid,
      totalValue,
      consumedValueCurrent: Number(pkg.consumedValue) || 0,
      sumPaidPayments,
      paymentCount: payments.length,
      sessionValue,
      sessionsDone: pkg.sessionsDone || 0,
      paidSessions: pkg.paidSessions || 0,
      preConsumedCount: pkg.preConsumedCount || 0,
      consumedBySessionsDone,
      consumedByPaidSessions,
      consumedByPreConsumed,
      financialDivergence,
      consumedDivergencePaid,
      consumedDivergenceDone,
      classifications,
      paymentIds: payments.map(p => p._id.toString())
    });
  }

  await mongoose.disconnect();
  console.timeEnd('⏱️ Tempo de execução');

  // Resumo
  const summary = {
    total: results.length,
    consistent: results.filter(r => r.classifications.includes('CONSISTENT')).length,
    overpaidVsLedger: results.filter(r => r.classifications.includes('OVERPAID_VS_LEDGER')).length,
    underpaidVsLedger: results.filter(r => r.classifications.includes('UNDERPAID_VS_LEDGER')).length,
    totalPaidUsedAsConsumed: results.filter(r => r.classifications.includes('TOTALPAID_USED_AS_CONSUMED')).length,
    ledgerOkButConsumedMismatch: results.filter(r => r.classifications.includes('LEDGER_OK_BUT_CONSUMED_MISMATCH')).length,
    mixedDivergence: results.filter(r => r.classifications.includes('MIXED_DIVERGENCE')).length
  };

  if (JSON_MODE) {
    console.log(JSON.stringify({ summary, results }, null, 2));
    return;
  }

  if (CSV_MODE) {
    const headers = [
      'packageId', 'patientId', 'status', 'model', 'type',
      'totalPaid', 'totalValue', 'consumedValueCurrent',
      'sumPaidPayments', 'paymentCount',
      'sessionValue', 'sessionsDone', 'paidSessions', 'preConsumedCount',
      'consumedBySessionsDone', 'consumedByPaidSessions', 'consumedByPreConsumed',
      'financialDivergence', 'consumedDivergencePaid', 'consumedDivergenceDone',
      'classifications'
    ];
    console.log(headers.join(','));
    for (const r of results) {
      console.log([
        r.packageId,
        r.patientId,
        r.status,
        r.model || '',
        r.type || '',
        r.totalPaid,
        r.totalValue,
        r.consumedValueCurrent,
        r.sumPaidPayments,
        r.paymentCount,
        r.sessionValue,
        r.sessionsDone,
        r.paidSessions,
        r.preConsumedCount,
        r.consumedBySessionsDone,
        r.consumedByPaidSessions,
        r.consumedByPreConsumed,
        r.financialDivergence,
        r.consumedDivergencePaid,
        r.consumedDivergenceDone,
        `"${r.classifications.join('|')}"`
      ].join(','));
    }
    return;
  }

  // Modo human-readable
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 ANÁLISE Package.totalPaid vs Ledger / Consumo           ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`\nTotal de packages analisados: ${summary.total}`);
  console.log(`  ✅ Consistentes:                           ${summary.consistent}`);
  console.log(`  🔴 totalPaid MAIOR que soma payments:      ${summary.overpaidVsLedger}`);
  console.log(`  🟠 totalPaid MENOR que soma payments:      ${summary.underpaidVsLedger}`);
  console.log(`  🟡 totalPaid usado como consumedValue:     ${summary.totalPaidUsedAsConsumed}`);
  console.log(`  🟣 Ledger OK, mas consumed divergente:     ${summary.ledgerOkButConsumedMismatch}`);
  console.log(`  ⚪ Divergência mista:                      ${summary.mixedDivergence}`);

  // Amostras
  const showSample = (label, predicate, limit = 5) => {
    const sample = results.filter(predicate).slice(0, limit);
    if (sample.length === 0) return;
    console.log(`\n${label} (primeiros ${Math.min(sample.length, limit)}):`);
    for (const r of sample) {
      console.log(`  ${r.packageId}`);
      console.log(`    totalPaid=${r.totalPaid} | sumPayments=${r.sumPaidPayments} | divergence=${r.financialDivergence.toFixed(2)}`);
      console.log(`    consumedByPaidSessions=${r.consumedByPaidSessions} | consumedDivergence=${r.consumedDivergencePaid.toFixed(2)}`);
      console.log(`    classifications=[${r.classifications.join(', ')}]`);
    }
  };

  showSample('🔴 OVERPAID_VS_LEDGER', r => r.classifications.includes('OVERPAID_VS_LEDGER'));
  showSample('🟠 UNDERPAID_VS_LEDGER', r => r.classifications.includes('UNDERPAID_VS_LEDGER'));
  showSample('🟡 TOTALPAID_USED_AS_CONSUMED', r => r.classifications.includes('TOTALPAID_USED_AS_CONSUMED'));

  // Salva relatório completo em /tmp para análise posterior
  const outputPath = path.join('/tmp', `package-totalpaid-analysis-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify({ summary, results }, null, 2));
  console.log(`\n💾 Relatório completo salvo em: ${outputPath}`);
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
