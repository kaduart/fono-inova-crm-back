/**
 * 🧹 Limpeza de guias de convênio de teste em produção (+ cascata)
 *
 * Origem: scripts/audit-test-insurance-guides.js (2026-08-07). Mesma família dos
 * 42 pacientes de teste e dos 88 Payments fantasma já removidos.
 *
 * ⚠️ Respeita docs/DELETE_CASCADE_CONTRACT.md:
 *   - Appointment nunca é deletado direto → deleteAppointmentCommand
 *   - Patient nunca é deletado direto     → deletePatientCommand
 *   - Package nunca é deletado direto     → deletePackageCommand
 *   - FinancialLedger é IMUTÁVEL e não é tocado
 *
 * Alvos são fixos e explícitos (número + convênio), nunca heurística em tempo de
 * exclusão — heurística serve para descobrir, não para deletar.
 *
 * Uso:
 *   node scripts/cleanup-test-insurance-guides.js            # dry-run (padrão)
 *   node scripts/cleanup-test-insurance-guides.js --apply    # executa
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import InsuranceGuide from '../models/InsuranceGuide.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';

const APPLY = process.argv.includes('--apply');

// ── Alvos: guia (número + convênio) ───────────────────────────────────
const GUIAS_ALVO = [
  // Grupo A — número inválido, zero vínculo
  { number: '123456', insurance: 'unimed-anapolis' },
  { number: 'LIMINAR', insurance: 'unimed-anapolis' },
  { number: 'RTRE', insurance: 'unimed-anapolis' },
  { number: 'CVBVB', insurance: 'unimed-anapolis' },
  { number: '111111', insurance: 'unimed-goiania' },
  { number: 'TEST-99999', insurance: 'unimed-anapolis' },
  { number: '3333', insurance: 'unimed-goiania' },
  // Grupo B — teste que puxou dado junto
  { number: 'QWEQWEQWE', insurance: 'unimed-anapolis' },
  { number: '12345666666', insurance: 'unimed-anapolis' },
  { number: '4444', insurance: 'unimed-anapolis' },
  { number: '5555', insurance: 'unimed-campinas' },
  { number: 'VAL-1783549631806', insurance: 'unimed-anapolis' },
  { number: 'TESTE-ENCERRAR-001', insurance: 'unimed-campinas' },
  { number: 'TESTE-UI-ENCERRAR-001', insurance: 'unimed-campinas' },
  { number: '12345611', insurance: 'unimed-test' }
];

// ── Pacientes de teste ────────────────────────────────────────────────
const PACIENTES_ALVO = ['Paciente Liminar Demo', 'ana teste 2', 'Paciente Teste Encerrar Guia'];

const fmt = v => `R$ ${Number(v || 0).toFixed(2)}`;
const tag = APPLY ? '🔴 APLICANDO' : '🔵 DRY-RUN';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\n${tag} — limpeza de guias de teste\n`);

  // ── 1. Resolver guias ───────────────────────────────────────────────
  const guides = await InsuranceGuide.find({
    $or: GUIAS_ALVO.map(t => ({ number: t.number, insurance: t.insurance }))
  }).populate('patientId', 'fullName').lean();

  const naoEncontradas = GUIAS_ALVO.filter(t =>
    !guides.some(g => String(g.number) === t.number && g.insurance === t.insurance));
  if (naoEncontradas.length) {
    console.log(`⚠️  Não encontradas (${naoEncontradas.length}): ${naoEncontradas.map(t => t.number).join(', ')}\n`);
  }

  const guideIds = guides.map(g => g._id);

  // ── 2. Cascata a partir das guias ───────────────────────────────────
  const sessions = await Session.find({ insuranceGuide: { $in: guideIds } })
    .select('_id appointmentId patient date status').lean();
  const sessionIds = sessions.map(s => s._id);
  const apptIdsDeSessao = [...new Set(sessions.map(s => s.appointmentId).filter(Boolean).map(String))];

  const payments = await Payment.find({
    $or: [
      { session: { $in: sessionIds } },
      { insuranceGuide: { $in: guideIds } },
      ...(apptIdsDeSessao.length ? [{ appointment: { $in: apptIdsDeSessao } }] : [])
    ]
  }).select('_id amount status session appointment').lean();

  const packages = await Package.find({ insuranceGuide: { $in: guideIds } }).select('_id name').lean();

  console.log('── Vínculos das guias ──');
  console.log(`   guias:        ${guides.length}`);
  console.log(`   sessões:      ${sessions.length}`);
  console.log(`   appointments: ${apptIdsDeSessao.length}`);
  console.log(`   payments:     ${payments.length} | ${fmt(payments.reduce((s, p) => s + (p.amount || 0), 0))}`);
  console.log(`   packages:     ${packages.length}`);
  guides.forEach(g => console.log(`     · ${String(g.number).padEnd(22)} ${g.insurance.padEnd(16)} ${g.patientId?.fullName || '(sem paciente)'}`));

  // ── 3. Pacientes de teste ───────────────────────────────────────────
  const pacientes = await Patient.find({ fullName: { $in: PACIENTES_ALVO } }).select('_id fullName').lean();
  console.log(`\n── Pacientes de teste: ${pacientes.length} ──`);
  for (const p of pacientes) {
    const [nA, nS, nP, nPk] = await Promise.all([
      Appointment.countDocuments({ patient: p._id }),
      Session.countDocuments({ patient: p._id }),
      Payment.countDocuments({ patient: p._id }),
      Package.countDocuments({ patient: p._id })
    ]);
    console.log(`     · ${p.fullName.padEnd(32)} appts ${nA} | sess ${nS} | pmts ${nP} | pkgs ${nPk}`);
  }

  if (!APPLY) {
    console.log('\n🔵 DRY-RUN — nada foi alterado. Rode com --apply para executar.');
    await mongoose.disconnect();
    return;
  }

  // ── 4. EXECUÇÃO — ordem do contrato: Payment → Appointment → Session → Package → Guia ──
  console.log('\n── Executando ──');

  const { default: deleteAppointmentCommand } = await import('../services/appointment/commands/deleteAppointmentCommand.js');
  const { execute: deletePatientCommand } = await import('../domains/patient/commands/deletePatientCommand.js');

  let apptsOk = 0, apptsFail = 0;
  for (const id of apptIdsDeSessao) {
    try {
      await deleteAppointmentCommand.execute(id, { _id: null, name: 'cleanup-script' });
      apptsOk++;
    } catch (err) {
      apptsFail++;
      console.log(`   ⚠️  appointment ${id}: ${err.message}`);
    }
  }
  console.log(`   appointments (via command): ${apptsOk} ok, ${apptsFail} falha`);

  const resPmt = await Payment.deleteMany({ _id: { $in: payments.map(p => p._id) } });
  console.log(`   payments residuais:  ${resPmt.deletedCount}`);

  const resSess = await Session.deleteMany({ _id: { $in: sessionIds } });
  console.log(`   sessões residuais:   ${resSess.deletedCount}`);

  if (packages.length) {
    const { default: deletePackageCommand } = await import('../services/billing/commands/deletePackageCommand.js');
    for (const pk of packages) {
      try { await deletePackageCommand.execute(String(pk._id), { _id: null, name: 'cleanup-script' }); }
      catch (err) { console.log(`   ⚠️  package ${pk._id}: ${err.message}`); }
    }
    console.log(`   packages: ${packages.length}`);
  }

  const resGuide = await InsuranceGuide.deleteMany({ _id: { $in: guideIds } });
  console.log(`   guias:               ${resGuide.deletedCount}`);

  for (const p of pacientes) {
    try {
      await deletePatientCommand(String(p._id), { user: { _id: null, name: 'cleanup-script' }, reason: 'limpeza_dado_teste_producao' });
      console.log(`   paciente removido:   ${p.fullName}`);
    } catch (err) {
      console.log(`   ⚠️  paciente ${p.fullName}: ${err.message}`);
    }
  }

  console.log('\n✅ Concluído. FinancialLedger não foi tocado (imutável por design).');
  await mongoose.disconnect();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
