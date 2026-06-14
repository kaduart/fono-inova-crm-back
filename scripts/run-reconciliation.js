#!/usr/bin/env node
/**
 * 🔍 RUN RECONCILIATION
 *
 * Executa a reconciliação financeira global e por profissional.
 *
 * Uso:
 *   node scripts/run-reconciliation.js
 *   node scripts/run-reconciliation.js --start=2026-06-01 --end=2026-06-30
 *   node scripts/run-reconciliation.js --start=2026-06-01 --end=2026-06-30 --issues=20
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import '../models/index.js';
import { getGlobalReconciliation, getTopFinancialIssues } from '../services/reconciliation.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (const arg of args) {
    if (arg.startsWith('--start=')) result.startDate = arg.split('=')[1];
    if (arg.startsWith('--end=')) result.endDate = arg.split('=')[1];
    if (arg.startsWith('--issues=')) result.issuesLimit = parseInt(arg.split('=')[1], 10);
  }
  return result;
}

function formatCurrency(value) {
  return `R$ ${(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function connect() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI ou MONGO_URI não encontrado no .env');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('✅ MongoDB conectado\n');
}

async function disconnect() {
  await mongoose.disconnect();
  console.log('\n👋 MongoDB desconectado');
}

async function main() {
  const { startDate, endDate, issuesLimit = 20 } = parseArgs();

  await connect();

  try {
    console.log('================================================');
    console.log('RECONCILIAÇÃO FINANCEIRA');
    console.log(`Período: ${startDate || 'mês atual'} - ${endDate || 'mês atual'}`);
    console.log('================================================\n');

    const result = await getGlobalReconciliation(startDate, endDate);
    const { global, byDoctor, period, metadata } = result;

    console.log(`Período analisado: ${period.start} → ${period.end}`);
    console.log(`Gerado em: ${metadata.generatedAt}`);
    console.log(`Tempo de execução: ${metadata.executionTimeMs}ms\n`);

    console.log('────────────────────────────────────────────────');
    console.log('RESUMO GLOBAL');
    console.log('────────────────────────────────────────────────');
    console.log(`Produção:           ${formatCurrency(global.production)}`);
    console.log(`Recebido:           ${formatCurrency(global.received)}`);
    console.log(`Diferença:          ${formatCurrency(global.difference)}`);
    console.log(`Comissão:           ${formatCurrency(global.commission)}`);
    console.log(`Sessões realizadas: ${global.completedSessions}`);
    console.log(`Sessões com pagto:  ${global.sessionsWithPayment}`);
    console.log(`Sessões sem pagto:  ${global.sessionsWithoutPayment}`);
    console.log(`  ├─ Pacotes:       ${global.sessionsWithoutPaymentBreakdown?.package || 0}`);
    console.log(`  ├─ Convênios:     ${global.sessionsWithoutPaymentBreakdown?.insurance || 0}`);
    console.log(`  ├─ Part. pendente: ${global.sessionsWithoutPaymentBreakdown?.privatePending || 0}`);
    console.log(`  ├─ Liminar:       ${global.sessionsWithoutPaymentBreakdown?.liminar || 0}`);
    console.log(`  └─ Problema real: ${global.sessionsWithoutPaymentBreakdown?.realIssue || 0}`);
    console.log(`A receber:          ${formatCurrency(global.receivables?.total)}`);
    console.log(`  ├─ Pacotes:       ${formatCurrency(global.receivables?.packageConsumed)}`);
    console.log(`  ├─ Convênios:     ${formatCurrency(global.receivables?.insurance)}`);
    console.log(`  ├─ Part. pendente: ${formatCurrency(global.receivables?.particular)}`);
    console.log(`  └─ Liminar:       ${formatCurrency(global.receivables?.liminar)}`);
    console.log(`Pagamentos órfãos:  ${global.orphanPayments}`);
    console.log(`Sem profissional:   ${global.missingDoctor}`);

    console.log('\n────────────────────────────────────────────────');
    console.log('TOP 10 PROFISSIONAIS COM MAIOR DIVERGÊNCIA');
    console.log('────────────────────────────────────────────────');

    const topDoctors = byDoctor.slice(0, 10);
    if (topDoctors.length === 0) {
      console.log('Nenhum profissional encontrado no período.');
    } else {
      console.log(`${'Profissional'.padEnd(30)} ${'Produção'.padStart(14)} ${'Recebido'.padStart(14)} ${'Diferença'.padStart(14)}`);
      console.log('-'.repeat(74));
      for (const doc of topDoctors) {
        const name = doc.doctorName.padEnd(30);
        const production = formatCurrency(doc.production).padStart(14);
        const received = formatCurrency(doc.received).padStart(14);
        const difference = formatCurrency(doc.difference).padStart(14);
        console.log(`${name} ${production} ${received} ${difference}`);
      }
    }

    console.log('\n────────────────────────────────────────────────');
    console.log(`TOP ${issuesLimit} PROBLEMAS FINANCEIROS`);
    console.log('────────────────────────────────────────────────');

    const issues = await getTopFinancialIssues(startDate, endDate, issuesLimit);
    if (issues.length === 0) {
      console.log('Nenhum problema encontrado. 🎉');
    } else {
      for (const issue of issues) {
        const icon = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🟢';
        console.log(`${icon} [${issue.type}] ${issue.description}`);
        console.log(`   Profissional: ${issue.doctorName || 'N/A'} | Paciente: ${issue.patientName || 'N/A'} | Valor: ${formatCurrency(issue.amount)} | Data: ${issue.date}`);
      }
    }

    console.log('\n================================================');
    console.log('FIM DA RECONCILIAÇÃO');
    console.log('================================================');

  } catch (error) {
    console.error('\n❌ Erro ao executar reconciliação:', error.message);
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    await disconnect();
  }
}

main();
