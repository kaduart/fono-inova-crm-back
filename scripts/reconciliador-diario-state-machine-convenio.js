#!/usr/bin/env node
/**
 * 🔄 RECONCILIADOR DIÁRIO – STATE MACHINE CONVÊNIO (CLI)
 *
 * Usa o core compartilhado em services/stateMachineConvenioReconciliation.service.js
 *
 * Modos:
 *   --dry-run    (padrão) só analisa
 *   --ci         exit 1 se drift residual > threshold
 *   --threshold=N limite de drift tolerado (padrão 0)
 */

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import {
  StateMachineConvenioReconciler,
  measureStateMachineDrift,
  loadBaseline,
  saveBaseline
} from '../services/stateMachineConvenioReconciliation.service.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('💥 MONGO_URI não configurado');
  process.exit(1);
}

const args = process.argv.slice(2);
const CI_MODE = args.includes('--ci');
const DRY_RUN = args.includes('--dry-run') || !(args.includes('--execute') || CI_MODE);
const EXECUTE = !DRY_RUN;
const ALERT_THRESHOLD = parseInt(args.find(a => a.startsWith('--threshold='))?.split('=')[1] || '0', 10);

function logHeader(title) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  logHeader('🔄 RECONCILIADOR DIÁRIO – STATE MACHINE CONVÊNIO');
  console.log(`  Modo: ${DRY_RUN ? '🟦 DRY-RUN' : (CI_MODE ? '🔴 CI' : '🟢 AUTO')}`);
  console.log(`  Threshold: ${ALERT_THRESHOLD}`);

  const baseline = await loadBaseline();

  // Drift antes
  const driftBefore = await measureStateMachineDrift(db);

  // Correções seguras
  const reconciler = new StateMachineConvenioReconciler(db, { execute: EXECUTE });
  const report = await reconciler.runSafeCorrections();

  // Drift depois
  const driftAfter = await measureStateMachineDrift(db);

  // Enriquece relatório
  report.driftBefore = driftBefore;
  report.driftAfter = driftAfter;
  report.baseline = baseline;

  logHeader('📊 RESULTADO DA RECONCILIAÇÃO');
  for (const [key, value] of Object.entries(report.estatisticas)) {
    console.log(`  ${key}: ${value}`);
  }

  logHeader('📈 DRIFT');
  console.log(`  ANTES:  ${driftBefore.total}`);
  console.log(`  DEPOIS: ${driftAfter.total}`);
  console.log(`  REDUÇÃO: ${driftBefore.total - driftAfter.total}`);
  console.log('');
  for (const [key, value] of Object.entries(driftAfter)) {
    if (key !== 'total') console.log(`  ${key}: ${value}`);
  }

  if (baseline?.drift?.total !== undefined) {
    const delta = driftAfter.total - baseline.drift.total;
    console.log(`  ─────────────────────────────`);
    console.log(`  BASELINE: ${baseline.drift.total}`);
    console.log(`  DELTA: ${delta >= 0 ? '+' : ''}${delta}`);
    if (delta > 0) console.log(`  🚨 ALERTA: drift aumentou em ${delta}`);
    else if (delta < 0) console.log(`  ✅ drift reduziu em ${Math.abs(delta)}`);
    else console.log(`  ➡️  drift estável`);
  } else if (!DRY_RUN) {
    console.log('  📌 Baseline inicial será criado.');
  }

  // Salvar relatório
  const outDir = path.resolve(process.cwd(), 'auditoria-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const suffix = DRY_RUN ? 'dryrun' : (CI_MODE ? 'ci' : 'auto');
  const outFile = path.join(outDir, `reconciliador-diario-convenio-${suffix}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n📄 Relatório salvo em: ${outFile}`);

  if (EXECUTE) {
    const baselineFile = await saveBaseline(driftAfter);
    console.log(`📌 Baseline atualizado: ${baselineFile}`);
  }

  if (driftAfter.total > ALERT_THRESHOLD) {
    console.log(`\n🔴 DRIFT ACIMA DO LIMITE (${ALERT_THRESHOLD}): ${driftAfter.total}`);
    if (CI_MODE) {
      console.log('🛑 CI bloqueado — inconsistências não resolvidas');
      process.exit(1);
    }
  } else {
    console.log(`\n🟢 DRIFT DENTRO DO LIMITE (${ALERT_THRESHOLD}): ${driftAfter.total}`);
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
