/**
 * 🔧 Merge de paciente duplicado — Isaac/Issac Moreira Ribeiro
 *
 * Contexto: dois cadastros para a mesma pessoa (mesmo CPF/telefone):
 *   - OLD (typo "Issac"): 6917116c5d4d8bdb65edd506 — 9 packages, 67 appointments/sessions, criado 2025-11-14
 *   - NEW (nome correto "Isaac"): 6a281fa74224ec8296160e27 — 2 packages, 24 appointments, criado 2026-06-09
 *
 * Estratégia: mover tudo do OLD para o NEW (Package/Appointment/Session/Payment.patient),
 * mesclar arrays denormalizados em Patient.appointments/packages, remover o PatientBalance
 * vazio do OLD, reconstruir as views (PackagesView + PatientsView) e por fim deletar o
 * paciente OLD via deletePatientCommand (único ponto de entrada oficial do domínio).
 *
 * Uso:
 *   node scripts/merge-duplicate-patient-isaac.mjs --dry-run   (padrão, não escreve nada)
 *   node scripts/merge-duplicate-patient-isaac.mjs --live      (executa de verdade)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Patient from '../models/Patient.js';
import Package from '../models/Package.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import PatientBalance from '../models/PatientBalance.js';
import PatientsView from '../models/PatientsView.js';
import { buildPatientView } from '../domains/clinical/services/patientProjectionService.js';
import { rebuildAllPatientPackages } from '../domains/billing/services/PackageProjectionService.js';
import deletePatientCommand from '../domains/patient/commands/deletePatientCommand.js';
import { runTransactionWithRetry } from '../utils/transactionRetry.js';

dotenv.config();

const LIVE = process.argv.includes('--live');
const OLD_ID = new mongoose.Types.ObjectId('6917116c5d4d8bdb65edd506');
const NEW_ID = new mongoose.Types.ObjectId('6a281fa74224ec8296160e27');

async function main() {
  console.log(`🚀 Merge paciente duplicado — modo: ${LIVE ? 'LIVE (vai escrever)' : 'DRY-RUN (somente leitura)'}`);
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB conectado\n');

  const oldPatient = await Patient.findById(OLD_ID).lean();
  const newPatient = await Patient.findById(NEW_ID).lean();

  if (!oldPatient || !newPatient) {
    throw new Error('Paciente antigo ou novo não encontrado — abortando.');
  }
  if (oldPatient.cpf !== newPatient.cpf || oldPatient.phone !== newPatient.phone) {
    throw new Error('SAFETY CHECK FALHOU: CPF/telefone divergem entre os dois cadastros — não são a mesma pessoa. Abortando.');
  }

  console.log(`OLD: "${oldPatient.fullName}" (${OLD_ID})`);
  console.log(`NEW: "${newPatient.fullName}" (${NEW_ID})`);
  console.log(`CPF/telefone conferem: ${oldPatient.cpf} / ${oldPatient.phone}\n`);

  const [pkgIds, apptIds, sessCount, paymentCount] = await Promise.all([
    Package.find({ patient: OLD_ID }).distinct('_id'),
    Appointment.find({ patient: OLD_ID }).distinct('_id'),
    Session.countDocuments({ patient: OLD_ID }),
    Payment.countDocuments({ patient: OLD_ID }),
  ]);
  const oldBalance = await PatientBalance.findOne({ patient: OLD_ID }).lean();

  console.log('📊 O que será movido do OLD para o NEW:');
  console.log(`   Packages:     ${pkgIds.length}`);
  console.log(`   Appointments: ${apptIds.length}`);
  console.log(`   Sessions:     ${sessCount}`);
  console.log(`   Payments:     ${paymentCount}`);
  console.log(`   PatientBalance do OLD: ${oldBalance ? `existe, ${oldBalance.transactions?.length || 0} transactions` : 'não existe'}`);

  if (oldBalance && (oldBalance.transactions?.length || 0) > 0) {
    throw new Error('SAFETY CHECK FALHOU: PatientBalance do paciente OLD tem transactions não migradas — script não sabe fazer merge de balance com transações. Abortando (revisar manualmente).');
  }

  if (!LIVE) {
    console.log('\n🟡 DRY-RUN: nada foi escrito. Rode novamente com --live para aplicar.');
    await mongoose.disconnect();
    return;
  }

  console.log('\n✍️  Aplicando merge em transação...');
  await runTransactionWithRetry(async (mongoSession) => {
    const pkgResult = await Package.updateMany(
      { patient: OLD_ID },
      { $set: { patient: NEW_ID } },
      { session: mongoSession }
    );
    const apptResult = await Appointment.updateMany(
      { patient: OLD_ID },
      { $set: { patient: NEW_ID } },
      { session: mongoSession }
    );
    const sessResult = await Session.updateMany(
      { patient: OLD_ID },
      { $set: { patient: NEW_ID } },
      { session: mongoSession }
    );
    const paymentResult = await Payment.updateMany(
      { patient: OLD_ID },
      { $set: { patient: NEW_ID, patientId: NEW_ID.toString() } },
      { session: mongoSession }
    );

    await Patient.findByIdAndUpdate(
      NEW_ID,
      { $addToSet: { appointments: { $each: apptIds }, packages: { $each: pkgIds } } },
      { session: mongoSession }
    );

    let balanceDeleted = 0;
    if (oldBalance) {
      const delResult = await PatientBalance.deleteOne({ patient: OLD_ID }).session(mongoSession);
      balanceDeleted = delResult.deletedCount;
    }

    console.log(`   Package.updateMany:     matched=${pkgResult.matchedCount} modified=${pkgResult.modifiedCount}`);
    console.log(`   Appointment.updateMany: matched=${apptResult.matchedCount} modified=${apptResult.modifiedCount}`);
    console.log(`   Session.updateMany:     matched=${sessResult.matchedCount} modified=${sessResult.modifiedCount}`);
    console.log(`   Payment.updateMany:     matched=${paymentResult.matchedCount} modified=${paymentResult.modifiedCount}`);
    console.log(`   PatientBalance antigo deletado: ${balanceDeleted}`);
  });

  console.log('\n🔄 Reconstruindo views (fora da transação, são projeções derivadas)...');
  const rebuildResult = await rebuildAllPatientPackages(NEW_ID.toString(), { correlationId: 'merge_isaac_pkgs' });
  console.log('   rebuildAllPatientPackages:', JSON.stringify(rebuildResult));

  await buildPatientView(NEW_ID.toString(), { force: true, correlationId: 'merge_isaac_patientview' });
  console.log('   buildPatientView (NEW): OK');

  console.log('\n🗑️  Removendo paciente OLD (agora vazio) via deletePatientCommand...');
  const deleteResult = await deletePatientCommand.execute(OLD_ID.toString(), {
    reason: `Merge de duplicata: mesclado em ${NEW_ID.toString()} (mesmo CPF/telefone, correção de digitação "Issac"->"Isaac")`
  });
  console.log('   deletePatientCommand:', JSON.stringify(deleteResult));

  // Sanity check: PatientsView órfã do OLD não deveria mais existir; NEW deve ter os 9+2 packages
  const oldViewLeftover = await PatientsView.findOne({ patientId: OLD_ID }).lean();
  const newPkgCountAfter = await Package.countDocuments({ patient: NEW_ID });
  const newApptCountAfter = await Appointment.countDocuments({ patient: NEW_ID });
  console.log('\n✅ Verificação final:');
  console.log(`   PatientsView órfã do OLD ainda existe? ${!!oldViewLeftover}`);
  console.log(`   Packages agora sob NEW: ${newPkgCountAfter} (esperado 11)`);
  console.log(`   Appointments agora sob NEW: ${newApptCountAfter} (esperado 91)`);

  await mongoose.disconnect();
  console.log('\n🎉 Merge concluído.');
}

main().catch((err) => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
