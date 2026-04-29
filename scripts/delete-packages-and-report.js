/**
 * 🗑️ Deleta packages específicos + relatório detalhado dos demais
 * MODO: sempre dry-run primeiro, depois --execute
 */
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const EXECUTE = process.argv.includes('--execute');

const DELETE_IDS = [
  '69c6996e06a4b96f32c0068a',
  '69e1253ea53e9315df7e23a1',
  '69e142bd4810453d1c974fbc',
  '69d668807f968ceaa5744cce'
];

const REPORT_IDS = [
  '69e10d35c4148f753a6d1ade',
  '69e229164e856f552b1a9e84',
  '69e2680f11988055724858ce',
  '69efd3176d3b7ccdae9d574a'
];

async function run() {
  console.log(EXECUTE ? '🔴 MODO EXECUÇÃO' : '🟡 MODO DRY-RUN (só loga, não salva)');
  console.log('Para executar de verdade: node scripts/delete-packages-and-report.js --execute\n');

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const packages = db.collection('packages');
  const patients = db.collection('patients');
  const sessions = db.collection('sessions');
  const payments = db.collection('payments');
  const appointments = db.collection('appointments');

  // ============ RELATÓRIO DOS 4 COM VALORES ============
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📋 DETALHES DOS PACOTES COM VALORES (precisam de análise)    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  for (const pkgId of REPORT_IDS) {
    const pkg = await packages.findOne({ _id: new mongoose.Types.ObjectId(pkgId) });
    if (!pkg) {
      console.log(`❌ Package ${pkgId} NÃO ENCONTRADO\n`);
      continue;
    }

    const patient = await patients.findOne({ _id: pkg.patient });
    const pkgSessions = await sessions.find({ package: pkg._id }).toArray();
    const pkgPayments = await payments.find({ package: pkg._id }).toArray();
    const pkgAppointments = await appointments.find({ package: pkg._id }).toArray();

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔥 Package ID: ${pkgId}`);
    console.log(`   Paciente: ${patient?.name || 'N/A'} (ID: ${pkg.patient})`);
    console.log(`   Especialidade: ${pkg.sessionType || 'N/A'}`);
    console.log(`   Session Value: R$ ${pkg.sessionValue || 0}`);
    console.log(`   Total Sessions: ${pkg.totalSessions || 0}`);
    console.log(`   Sessions Done: ${pkg.sessionsDone || 0}`);
    console.log(`   Total Paid: R$ ${pkg.totalPaid || 0}`);
    console.log(`   Balance: R$ ${pkg.balance || 0}`);
    console.log(`   Status: ${pkg.status || 'N/A'}`);
    console.log(`   Criado em: ${pkg.createdAt ? new Date(pkg.createdAt).toLocaleString('pt-BR') : 'N/A'}`);
    console.log(`   Atualizado em: ${pkg.updatedAt ? new Date(pkg.updatedAt).toLocaleString('pt-BR') : 'N/A'}`);
    console.log(`   Tipo: ${pkg.type || 'N/A'}`);
    console.log(`   Modelo: ${pkg.model || 'N/A'}`);
    console.log(`   Payment Type: ${pkg.paymentType || 'N/A'}`);
    console.log(`   Preço Total: R$ ${pkg.totalPrice || 0}`);
    console.log(`   Finance Status: ${pkg.financialStatus || 'N/A'}`);
    console.log(`   `);
    console.log(`   📦 Sessions (${pkgSessions.length}):`);
    for (const s of pkgSessions) {
      console.log(`      - Sessão ${s._id}: isPaid=${s.isPaid}, paymentStatus=${s.paymentStatus}, status=${s.status}`);
    }
    console.log(`   💵 Payments (${pkgPayments.length}):`);
    for (const p of pkgPayments) {
      console.log(`      - Payment ${p._id}: R$ ${p.amount}, status=${p.status}, billingType=${p.billingType}, method=${p.paymentMethod}`);
    }
    console.log(`   📅 Appointments (${pkgAppointments.length}):`);
    for (const a of pkgAppointments) {
      console.log(`      - Appointment ${a._id}: date=${a.date}, status=${a.status}, paymentStatus=${a.paymentStatus}, isPaid=${a.isPaid}`);
    }
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  }

  // ============ DELEÇÃO DOS 4 ============
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  🗑️ DELEÇÃO DOS PACOTES SOLICITADOS                            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  for (const pkgId of DELETE_IDS) {
    const pkg = await packages.findOne({ _id: new mongoose.Types.ObjectId(pkgId) });
    if (!pkg) {
      console.log(`❌ Package ${pkgId} já não existe no banco`);
      continue;
    }

    const patient = await patients.findOne({ _id: pkg.patient });
    console.log(`🗑️  ${pkgId}`);
    console.log(`   Paciente: ${patient?.name || 'N/A'}`);
    console.log(`   Especialidade: ${pkg.sessionType || 'N/A'}`);
    console.log(`   Total Paid: R$ ${pkg.totalPaid || 0}`);

    if (EXECUTE) {
      // Deleta sessions
      const delSessions = await sessions.deleteMany({ package: pkg._id });
      console.log(`   → Sessions deletadas: ${delSessions.deletedCount}`);

      // Deleta payments
      const delPayments = await payments.deleteMany({ package: pkg._id });
      console.log(`   → Payments deletados: ${delPayments.deletedCount}`);

      // Deleta appointments vinculados
      const delAppointments = await appointments.deleteMany({ package: pkg._id });
      console.log(`   → Appointments deletados: ${delAppointments.deletedCount}`);

      // Deleta o package
      await packages.deleteOne({ _id: pkg._id });
      console.log(`   → ✅ Package DELETADO\n`);
    } else {
      const countSessions = await sessions.countDocuments({ package: pkg._id });
      const countPayments = await payments.countDocuments({ package: pkg._id });
      const countAppointments = await appointments.countDocuments({ package: pkg._id });
      console.log(`   → (dry-run) Sessions: ${countSessions}, Payments: ${countPayments}, Appointments: ${countAppointments}`);
      console.log(`   → 🟡 NÃO deletado\n`);
    }
  }

  console.log(EXECUTE ? '\n✅ EXECUÇÃO COMPLETA' : '\n🟡 DRY-RUN (use --execute para deletar de verdade)');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
