/**
 * 🧹 Script seguro para deleção de contrato liminar
 *
 * Verifica dependências antes de deletar:
 * - TherapeuticPlan vinculados
 * - Payments vinculados
 * - Appointments vinculados
 * - Packages vinculados
 *
 * Uso: node back/scripts/delete-liminar-contract.js <contract_id> [--force]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const CONTRACT_ID = process.argv[2];
const FORCE = process.argv.includes('--force');

if (!CONTRACT_ID) {
  console.error('❌ Uso: node back/scripts/delete-liminar-contract.js <contract_id> [--force]');
  process.exit(1);
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ MONGO_URI não encontrado');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('🔌 Conectado ao MongoDB');

  const LiminarContract = (await import('../models/LiminarContract.js')).default;
  const TherapeuticPlan = (await import('../models/TherapeuticPlan.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const Package = (await import('../models/Package.js')).default;

  const contract = await LiminarContract.findById(CONTRACT_ID).lean();
  if (!contract) {
    console.error(`❌ Contrato ${CONTRACT_ID} não encontrado`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('\n📄 Contrato encontrado:');
  console.log(`   _id: ${contract._id}`);
  console.log(`   patient: ${contract.patient}`);
  console.log(`   doctor: ${contract.doctor}`);
  console.log(`   totalCredit: ${contract.totalCredit}`);
  console.log(`   usedCredit: ${contract.usedCredit}`);
  console.log(`   creditBalance: ${contract.creditBalance}`);
  console.log(`   status: ${contract.status}`);
  console.log(`   plans: ${JSON.stringify(contract.plans)}`);

  // Verifica dependências
  const [plans, payments, appointments, packages] = await Promise.all([
    TherapeuticPlan.find({ liminarContract: CONTRACT_ID }).lean(),
    Payment.find({ liminarContract: CONTRACT_ID }).lean(),
    Appointment.find({ liminarContract: CONTRACT_ID }).lean(),
    Package.find({ liminarContract: CONTRACT_ID }).lean()
  ]);

  console.log('\n🔍 Dependências encontradas:');
  console.log(`   TherapeuticPlans: ${plans.length}`);
  console.log(`   Payments: ${payments.length}`);
  console.log(`   Appointments: ${appointments.length}`);
  console.log(`   Packages: ${packages.length}`);

  if (payments.length > 0) {
    console.log('\n⚠️  ATENÇÃO: Existem pagamentos vinculados a este contrato.');
    payments.forEach(p => {
      console.log(`   - Payment ${p._id}: status=${p.status}, amount=${p.amount}, kind=${p.kind}`);
    });
  }

  if (appointments.length > 0) {
    console.log('\n⚠️  ATENÇÃO: Existem agendamentos vinculados a este contrato.');
    appointments.forEach(a => {
      console.log(`   - Appointment ${a._id}: date=${a.date}, status=${a.operationalStatus || a.status}`);
    });
  }

  if (packages.length > 0) {
    console.log('\n⚠️  ATENÇÃO: Existem pacotes vinculados a este contrato.');
    packages.forEach(pkg => {
      console.log(`   - Package ${pkg._id}: status=${pkg.status}`);
    });
  }

  // Se usado, exige --force e confirmação adicional
  if (contract.usedCredit > 0 && !FORCE) {
    console.error('\n🛑 Contrato já teve crédito utilizado. Use --force para deletar em cascata.');
    await mongoose.disconnect();
    process.exit(1);
  }

  if ((payments.length > 0 || appointments.length > 0 || packages.length > 0) && !FORCE) {
    console.error('\n🛑 Existem dependências ativas. Use --force para deletar em cascata.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // Deleção em cascata
  console.log('\n🗑️  Iniciando deleção...');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (plans.length > 0) {
        const planIds = plans.map(p => p._id);
        await TherapeuticPlan.deleteMany({ _id: { $in: planIds } }).session(session);
        console.log(`   ✅ Deletados ${plans.length} TherapeuticPlan(s)`);
      }

      if (payments.length > 0) {
        const paymentIds = payments.map(p => p._id);
        await Payment.deleteMany({ _id: { $in: paymentIds } }).session(session);
        console.log(`   ✅ Deletados ${payments.length} Payment(s)`);
      }

      if (appointments.length > 0) {
        const appointmentIds = appointments.map(a => a._id);
        await Appointment.deleteMany({ _id: { $in: appointmentIds } }).session(session);
        console.log(`   ✅ Deletados ${appointments.length} Appointment(s)`);
      }

      if (packages.length > 0) {
        const packageIds = packages.map(p => p._id);
        await Package.deleteMany({ _id: { $in: packageIds } }).session(session);
        console.log(`   ✅ Deletados ${packages.length} Package(s)`);
      }

      await LiminarContract.findByIdAndDelete(CONTRACT_ID).session(session);
      console.log('   ✅ Contrato deletado');
    });

    console.log('\n✅ Deleção concluída com sucesso');
  } catch (err) {
    console.error('\n❌ Erro durante a deleção:', err.message);
    throw err;
  } finally {
    await session.endSession();
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
