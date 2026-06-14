#!/usr/bin/env node
/**
 * 🔍 RUN RECONCILIATION — POR PROFISSIONAL
 *
 * Executa a reconciliação financeira detalhada de um profissional,
 * incluindo drill-down por paciente.
 *
 * Uso:
 *   node scripts/run-reconciliation-doctor.js --doctor=<id>
 *   node scripts/run-reconciliation-doctor.js --doctor=<id> --start=2026-06-01 --end=2026-06-30
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import '../models/index.js';
import { getDoctorReconciliation } from '../services/reconciliation.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (const arg of args) {
    if (arg.startsWith('--doctor=')) result.doctorId = arg.split('=')[1];
    if (arg.startsWith('--start=')) result.startDate = arg.split('=')[1];
    if (arg.startsWith('--end=')) result.endDate = arg.split('=')[1];
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
  const { doctorId, startDate, endDate } = parseArgs();

  if (!doctorId) {
    console.error('❌ Informe o ID do profissional: --doctor=<id>');
    process.exit(1);
  }

  await connect();

  try {
    console.log('================================================');
    console.log('RECONCILIAÇÃO FINANCEIRA POR PROFISSIONAL');
    console.log(`Profissional: ${doctorId}`);
    console.log(`Período: ${startDate || 'mês atual'} - ${endDate || 'mês atual'}`);
    console.log('================================================\n');

    const result = await getDoctorReconciliation(doctorId, startDate, endDate);
    const { doctor, reconciliation, period, metadata } = result;

    console.log(`Profissional: ${doctor.fullName}`);
    console.log(`Especialidade: ${doctor.specialty || 'N/A'}`);
    console.log(`Período: ${period.start} → ${period.end}`);
    console.log(`Gerado em: ${metadata.generatedAt}`);
    console.log(`Tempo de execução: ${metadata.executionTimeMs}ms\n`);

    console.log('────────────────────────────────────────────────');
    console.log('RESUMO DO PROFISSIONAL');
    console.log('────────────────────────────────────────────────');
    console.log(`Pacientes ativos:    ${reconciliation.activePatients}`);
    console.log(`Sessões realizadas:  ${reconciliation.completedSessions}`);
    console.log(`Produção:            ${formatCurrency(reconciliation.production)}`);
    console.log(`Recebido:            ${formatCurrency(reconciliation.received)}`);
    console.log(`Pendente:            ${formatCurrency(reconciliation.pending)}`);
    console.log(`Comissão:            ${formatCurrency(reconciliation.commission)}`);
    console.log(`Adiantamentos:       ${formatCurrency(reconciliation.advances)}`);
    console.log(`Saldo:               ${formatCurrency(reconciliation.balance)}`);
    console.log(`Diferença produção/caixa: ${formatCurrency(reconciliation.difference)}`);

    console.log('\n────────────────────────────────────────────────');
    console.log('DETALHAMENTO POR PACIENTE');
    console.log('────────────────────────────────────────────────');

    const patients = reconciliation.patients || [];
    if (patients.length === 0) {
      console.log('Nenhum paciente encontrado no período.');
    } else {
      console.log(`${'Paciente'.padEnd(30)} ${'Sessões'.padStart(8)} ${'Produção'.padStart(14)} ${'Recebido'.padStart(14)} ${'Pendente'.padStart(14)}`);
      console.log('-'.repeat(82));
      for (const patient of patients.slice(0, 30)) {
        const name = patient.patientName.padEnd(30);
        const sessions = String(patient.sessionsCompleted).padStart(8);
        const production = formatCurrency(patient.production).padStart(14);
        const received = formatCurrency(patient.received).padStart(14);
        const pending = formatCurrency(patient.pending).padStart(14);
        console.log(`${name} ${sessions} ${production} ${received} ${pending}`);
      }
      if (patients.length > 30) {
        console.log(`\n... e mais ${patients.length - 30} pacientes.`);
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
