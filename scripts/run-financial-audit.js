#!/usr/bin/env node
/**
 * 🔍 Roda o Financial Audit Engine
 *
 * Uso:
 *   node scripts/run-financial-audit.js
 *   node scripts/run-financial-audit.js --json > audit-report.json
 *   node scripts/run-financial-audit.js --csv > audit-report.csv
 */

import mongoose from 'mongoose';
import { FinancialAuditEngine } from '../services/financialGuard/auditEngine.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const JSON_MODE = process.argv.includes('--json');
const CSV_MODE = process.argv.includes('--csv');

async function run() {
  console.log('🔍 Iniciando Financial Audit Engine...\n');
  console.time('⏱️ Tempo de execução');

  const result = await FinancialAuditEngine.run({ mongoUri: MONGO_URI });

  console.timeEnd('⏱️ Tempo de execução');

  if (JSON_MODE) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (CSV_MODE) {
    console.log('id,severity,category,packageId,patientId,expected,actual,diff,details');
    for (const issue of result.issues) {
      console.log([
        issue.id,
        issue.severity,
        issue.category,
        issue.packageId || '',
        issue.patientId || '',
        issue.expected ?? '',
        issue.actual ?? '',
        issue.diff ?? '',
        `"${issue.details.replace(/"/g, '""')}"`
      ].join(','));
    }
    return;
  }

  // Modo human-readable
  const { summary } = result;

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 RELATÓRIO DE AUDITORIA FINANCEIRA                        ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`\nTotal de issues encontradas: ${summary.total}`);
  console.log(`  🔴 CRITICAL: ${summary.critical}`);
  console.log(`  🟠 HIGH:     ${summary.high}`);
  console.log(`  🟡 MEDIUM:   ${summary.medium}`);
  console.log(`  🟢 LOW:      ${summary.low}`);
  console.log(`\nPor categoria:`);
  for (const [cat, count] of Object.entries(summary.byCategory)) {
    console.log(`  • ${cat}: ${count}`);
  }

  if (result.issues.length > 0) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('DETALHES (CRITICAL + HIGH primeiro):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const sorted = result.issues.sort((a, b) => {
      const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      return order[a.severity] - order[b.severity];
    });

    for (const issue of sorted.slice(0, 50)) {
      const icon = issue.severity === 'CRITICAL' ? '🔴' : issue.severity === 'HIGH' ? '🟠' : issue.severity === 'MEDIUM' ? '🟡' : '🟢';
      console.log(`${icon} [${issue.severity}] ${issue.category}`);
      if (issue.packageId) console.log(`   Package: ${issue.packageId}`);
      if (issue.patientId) console.log(`   Patient: ${issue.patientId}`);
      if (issue.paymentId) console.log(`   Payment: ${issue.paymentId}`);
      if (issue.sessionId) console.log(`   Session: ${issue.sessionId}`);
      if (issue.appointmentId) console.log(`   Appointment: ${issue.appointmentId}`);
      if (issue.expected !== undefined) console.log(`   Esperado: R$ ${issue.expected} | Atual: R$ ${issue.actual} | Dif: R$ ${issue.diff}`);
      if (issue.amount) console.log(`   Valor: R$ ${issue.amount}`);
      console.log(`   ${issue.details}\n`);
    }

    if (result.issues.length > 50) {
      console.log(`... e mais ${result.issues.length - 50} issues (use --json ou --csv para ver todas)`);
    }
  }

  console.log('\n✅ Auditoria completa.');
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
