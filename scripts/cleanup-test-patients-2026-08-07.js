/**
 * 🧹 Limpeza da 2ª leva de dado de teste em produção (2026-08-07)
 *
 * Sequência de [[project_test_patients_contamination_cleanup_2026-08-05]] e de
 * scripts/cleanup-test-insurance-guides.js (mesma sessão). Alvos:
 *   - 11 pacientes com nome de teste ainda vivos após a limpeza das guias
 *   - convênio "Unimed Teste"
 *   - 2 Session sem paciente apontando pra guia inexistente (resíduo)
 *
 * ⚠️ Respeita docs/DELETE_CASCADE_CONTRACT.md:
 *   - Patient     → deletePatientCommand (nunca findByIdAndDelete)
 *   - Appointment → deleteAppointmentCommand
 *   - Package     → deletePackageCommand
 *   - FinancialLedger é IMUTÁVEL e não é tocado
 *
 * Alvos são fixos e explícitos — heurística serve para descobrir, não para deletar.
 *
 * Uso:
 *   node scripts/cleanup-test-patients-2026-08-07.js           # dry-run (padrão)
 *   node scripts/cleanup-test-patients-2026-08-07.js --apply
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import Patient from '../models/Patient.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Convenio from '../models/Convenio.js';

const APPLY = process.argv.includes('--apply');

const PACIENTES_ALVO = [
  'Paciente Audit Test',
  'Paciente Teste Autorização',
  'Testando',
  'Teste Confirm InPlace',
  'Teste Outbox Latência 1783543132270',
  'Teste Ricardo',
  'ZZZ_TESTE_PR4_APAGAR',
  'ana testar',
  'ana teste 22',
  'teste',
  'teste 3'
];

const CONVENIOS_ALVO = ['Unimed Teste'];

// Resíduo: Session sem paciente apontando pra InsuranceGuide inexistente
const SESSOES_RESIDUAIS = ['69d3f7db6942f19c56e207e2', '69d3f7db6942f19c56e207e3'];

const fmt = v => `R$ ${Number(v || 0).toFixed(2)}`;

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\n${APPLY ? '🔴 APLICANDO' : '🔵 DRY-RUN'} — limpeza de pacientes/convênio de teste\n`);

  const pacientes = await Patient.find({ fullName: { $in: PACIENTES_ALVO } })
    .select('_id fullName phone createdAt').lean();

  const naoAchados = PACIENTES_ALVO.filter(n => !pacientes.some(p => p.fullName === n));
  if (naoAchados.length) console.log(`⚠️  Não encontrados: ${naoAchados.join(', ')}\n`);

  console.log('── Inventário por paciente ──');
  let totPagos = 0, valorPago = 0;
  const detalhe = [];

  for (const p of pacientes) {
    const [appts, sessions, payments, packages, guides] = await Promise.all([
      Appointment.find({ patient: p._id }).select('_id operationalStatus date').lean(),
      Session.find({ patient: p._id }).select('_id status').lean(),
      Payment.find({ patient: p._id }).select('_id amount status').lean(),
      Package.find({ patient: p._id }).select('_id').lean(),
      InsuranceGuide.find({ patientId: p._id }).select('_id number').lean()
    ]);
    const pagos = payments.filter(x => x.status === 'paid');
    totPagos += pagos.length;
    valorPago += pagos.reduce((s, x) => s + (x.amount || 0), 0);
    detalhe.push({ p, appts, sessions, payments, packages, guides, pagos });

    const alerta = pagos.length ? `  🚨 ${pagos.length} PAYMENT PAGO (${fmt(pagos.reduce((s, x) => s + (x.amount || 0), 0))})` : '';
    console.log(`   ${p.fullName.padEnd(38)} appt ${String(appts.length).padStart(2)} | sess ${String(sessions.length).padStart(2)} | pmt ${String(payments.length).padStart(2)} | pkg ${String(packages.length).padStart(2)} | guia ${String(guides.length).padStart(2)}${alerta}`);
  }

  console.log('\n── Convênios ──');
  const convenios = await Convenio.find({ name: { $in: CONVENIOS_ALVO } }).select('_id name').lean();
  for (const c of convenios) {
    const [g, pm] = await Promise.all([
      InsuranceGuide.countDocuments({ insurance: c.name }),
      Payment.countDocuments({ 'insurance.provider': c.name })
    ]);
    console.log(`   ${c.name} → guias ${g} | payments ${pm}`);
  }

  console.log('\n── Sessões residuais (sem paciente, guia inexistente) ──');
  const residuais = await Session.find({ _id: { $in: SESSOES_RESIDUAIS } })
    .select('_id patient date status insuranceGuide').lean();
  for (const s of residuais) {
    const guiaExiste = s.insuranceGuide ? await InsuranceGuide.exists({ _id: s.insuranceGuide }) : null;
    console.log(`   ${s._id} | paciente ${s.patient || 'NENHUM'} | ${new Date(s.date).toISOString().slice(0, 10)} | ${s.status} | guia existe: ${guiaExiste ? 'SIM ⚠️' : 'não'}`);
  }

  if (totPagos) {
    console.log(`\n🚨 ATENÇÃO: ${totPagos} payment(s) com status 'paid' (${fmt(valorPago)}) no escopo.`);
  }

  if (!APPLY) {
    console.log('\n🔵 DRY-RUN — nada foi alterado. Rode com --apply para executar.');
    await mongoose.disconnect();
    return;
  }

  console.log('\n── Executando ──');
  const { default: deleteAppointmentCommand } = await import('../services/appointment/commands/deleteAppointmentCommand.js');
  const { default: deletePackageCommand } = await import('../services/billing/commands/deletePackageCommand.js');
  const { execute: deletePatientCommand } = await import('../domains/patient/commands/deletePatientCommand.js');
  const user = { _id: null, name: 'cleanup-script-2026-08-07' };

  for (const d of detalhe) {
    for (const a of d.appts) {
      try { await deleteAppointmentCommand.execute(String(a._id), user); }
      catch (err) { console.log(`   ⚠️  appointment ${a._id}: ${err.message}`); }
    }
    for (const pk of d.packages) {
      try { await deletePackageCommand.execute(String(pk._id), user); }
      catch (err) { console.log(`   ⚠️  package ${pk._id}: ${err.message}`); }
    }
    if (d.guides.length) {
      await InsuranceGuide.deleteMany({ _id: { $in: d.guides.map(g => g._id) } });
    }
    try {
      await deletePatientCommand(String(d.p._id), { user, reason: 'limpeza_dado_teste_producao_2026_08_07' });
      console.log(`   ✅ ${d.p.fullName}`);
    } catch (err) {
      console.log(`   ⚠️  paciente ${d.p.fullName}: ${err.message}`);
    }
  }

  const resSess = await Session.deleteMany({ _id: { $in: SESSOES_RESIDUAIS } });
  console.log(`   sessões residuais removidas: ${resSess.deletedCount}`);

  const resConv = await Convenio.deleteMany({ _id: { $in: convenios.map(c => c._id) } });
  console.log(`   convênios removidos: ${resConv.deletedCount}`);

  console.log('\n✅ Concluído. FinancialLedger não foi tocado (imutável por design).');
  await mongoose.disconnect();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
