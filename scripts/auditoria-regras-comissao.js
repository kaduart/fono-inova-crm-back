#!/usr/bin/env node
/**
 * 🔍 Auditoria das Regras de Comissão dos Profissionais
 *
 * Levanta quais profissionais ainda dependem de campos legados de comissão
 * (standardSession, evaluationSession, neuropsychEvaluation, byInsurance, customRules)
 * e quantas regras novas (commissionRules.rules) já foram cadastradas.
 *
 * Ajuda a decidir se é seguro remover os legados e migrar tudo para o motor novo.
 *
 * Uso:
 *   node back/scripts/auditoria-regras-comissao.js
 */

import mongoose from 'mongoose';
import Doctor from '../models/Doctor.js';
import Session from '../models/Session.js';
import { calculateSessionCommission, calculateCommissionBatch } from '../services/commissionRule.service.js';

const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

const TIMEZONE = 'America/Sao_Paulo';

function formatCurrency(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
}

function hasLegacyRules(comm) {
  if (!comm) return false;
  if (comm.standardSession !== undefined && comm.standardSession !== null && comm.standardSession !== 60) return true;
  if (comm.evaluationSession !== undefined && comm.evaluationSession !== null && comm.evaluationSession !== 0) return true;
  if (comm.neuropsychEvaluation !== undefined && comm.neuropsychEvaluation !== null && comm.neuropsychEvaluation !== 1200) return true;
  if (comm.byInsurance && Object.keys(comm.byInsurance).length > 0) return true;
  if (comm.customRules && comm.customRules.length > 0) return true;
  return false;
}

function getLegacySummary(comm) {
  if (!comm) return '-';
  const parts = [];
  if (comm.standardSession !== undefined && comm.standardSession !== null) parts.push(`standard=${comm.standardSession}`);
  if (comm.evaluationSession !== undefined && comm.evaluationSession !== null) parts.push(`eval=${comm.evaluationSession}`);
  if (comm.neuropsychEvaluation !== undefined && comm.neuropsychEvaluation !== null) parts.push(`neuro=${comm.neuropsychEvaluation}`);
  if (comm.byInsurance && Object.keys(comm.byInsurance).length > 0) {
    parts.push(`byInsurance={${Object.entries(comm.byInsurance).map(([k, v]) => `${k}:${v}`).join(', ')}}`);
  }
  if (comm.customRules && comm.customRules.length > 0) {
    parts.push(`custom=${comm.customRules.length}`);
  }
  return parts.length ? parts.join(' | ') : '-';
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Conectado ao MongoDB:', mongoose.connection.db.databaseName);

  const doctors = await Doctor.find({}).sort('fullName').lean();
  console.log(`\nTotal de profissionais cadastrados: ${doctors.length}\n`);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  let totalComAtual = 0;
  let totalComSemLegado = 0;

  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════');
  console.log(' ID | Nome | Especialidade | Regras Novas | Legado Ativo? | Resumo Legado | Sessões Mês | Comissão Atual | Sem Legado | Delta');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════');

  for (const doctor of doctors) {
    const comm = doctor.commissionRules || {};
    const newRules = comm.rules || [];
    const legacyActive = hasLegacyRules(comm);
    const legacySummary = getLegacySummary(comm);

    // Sessões do mês atual para simular impacto
    const sessions = await Session.find({
      doctor: doctor._id,
      status: 'completed',
      date: { $gte: startOfMonth, $lte: endOfMonth }
    }).populate('package', 'sessionType insuranceProvider').lean();

    const { totalCommission } = calculateCommissionBatch(doctor, sessions);

    // Simular sem legado: clonar doctor e zerar legados
    const doctorWithoutLegacy = JSON.parse(JSON.stringify(doctor));
    doctorWithoutLegacy.commissionRules = doctorWithoutLegacy.commissionRules || {};
    doctorWithoutLegacy.commissionRules.standardSession = undefined;
    doctorWithoutLegacy.commissionRules.evaluationSession = undefined;
    doctorWithoutLegacy.commissionRules.neuropsychEvaluation = undefined;
    doctorWithoutLegacy.commissionRules.byInsurance = {};
    doctorWithoutLegacy.commissionRules.customRules = [];

    const { totalCommission: totalCommissionNoLegacy } = calculateCommissionBatch(doctorWithoutLegacy, sessions);

    totalComAtual += totalCommission;
    totalComSemLegado += totalCommissionNoLegacy;

    const delta = totalCommissionNoLegacy - totalCommission;
    const deltaStr = delta === 0 ? '-' : (delta > 0 ? `+${formatCurrency(delta)}` : formatCurrency(delta));

    console.log(
      `${doctor._id.toString().slice(-6)} | ` +
      `${doctor.fullName.padEnd(28)} | ` +
      `${(doctor.specialty || '-').padEnd(15)} | ` +
      `${String(newRules.length).padStart(2)} regras | ` +
      `${legacyActive ? 'SIM' : 'não'} | ` +
      `${legacySummary.padEnd(40)} | ` +
      `${String(sessions.length).padStart(3)} | ` +
      `${formatCurrency(totalCommission).padStart(12)} | ` +
      `${formatCurrency(totalCommissionNoLegacy).padStart(12)} | ` +
      `${deltaStr}`
    );
  }

  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════');
  console.log(`TOTAIS: Comissão atual mês = ${formatCurrency(totalComAtual)} | Sem legado = ${formatCurrency(totalComSemLegado)} | Delta = ${formatCurrency(totalComSemLegado - totalComAtual)}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════\n');

  // Resumo por especialidade
  console.log('\n📊 Resumo por especialidade:');
  const bySpecialty = {};
  for (const doctor of doctors) {
    const sp = doctor.specialty || 'não informada';
    if (!bySpecialty[sp]) bySpecialty[sp] = { count: 0, withLegacy: 0, withNewRules: 0 };
    bySpecialty[sp].count++;
    if (hasLegacyRules(doctor.commissionRules)) bySpecialty[sp].withLegacy++;
    if ((doctor.commissionRules?.rules || []).length > 0) bySpecialty[sp].withNewRules++;
  }
  for (const [sp, data] of Object.entries(bySpecialty).sort()) {
    console.log(`  • ${sp}: ${data.count} profissionais, ${data.withLegacy} com legado, ${data.withNewRules} com regras novas`);
  }

  console.log('\n✅ Auditoria concluída.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
