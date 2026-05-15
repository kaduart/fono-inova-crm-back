import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const isDryRun = !process.argv.includes('--apply');
  console.log(`Modo: ${isDryRun ? 'DRY-RUN (use --apply para DELETAR)' : '⚠️ APLICAR DELEÇÃO'}\n`);

  // 1. Encontrar paciente
  const patient = await db.collection('patients').findOne({ fullName: /Ricardo MAIA Santos/i });
  if (!patient) {
    console.log('❌ Paciente "Ricardo MAIA Santos" não encontrado');
    await mongoose.disconnect();
    return;
  }

  console.log(`Paciente encontrado: ${patient.fullName} (${patient._id.toString()})\n`);

  const patientId = patient._id;
  const patientIdStr = patientId.toString();

  // 2. Mapear tudo relacionado
  const collectionsToCheck = [
    'packages',
    'insuranceguides',
    'liminarcontracts',
    'appointments',
    'sessions',
    'payments',
    'patients_view',
    'packages_view',
    'appointments_view',
    'patientbalances',
    'financialledger',
    'evolutions',
    'leads',
    'sessions_view',
    'payment_batches',
    'insurance_batches',
    'dailyclosings',
    'cashflows',
    'notifications',
    'auditlogs',
    'whatsappmessages'
  ];

  const toDelete = {};

  for (const collName of collectionsToCheck) {
    const coll = db.collection(collName);
    try {
      const docs = await coll.find({
        $or: [
          { patient: patientId },
          { patientId: patientId },
          { patientId: patientIdStr },
          { patient_id: patientId },
          { patient_id: patientIdStr },
          { 'patient._id': patientId },
          { 'patient.id': patientIdStr }
        ]
      }).toArray();

      if (docs.length > 0) {
        toDelete[collName] = docs;
      }
    } catch (e) {
      // coleção pode não existir
    }
  }

  // Verificar referências em arrays (ex: Patient.packages)
  const patientsWithRef = await db.collection('patients').find({
    $or: [
      { packages: { $in: [patientId] } },
      { 'packages.patient': patientId }
    ]
  }).toArray();

  // Packages que referenciam o paciente
  const packages = await db.collection('packages').find({ patient: patientId }).toArray();
  const packageIds = packages.map(p => p._id);
  const packageIdStrs = packageIds.map(id => id.toString());

  // Guias que referenciam os packages
  if (packageIds.length > 0) {
    const guides = await db.collection('insuranceguides').find({
      $or: [
        { packageId: { $in: packageIds } },
        { patientId: patientId }
      ]
    }).toArray();
    if (guides.length > 0) toDelete['insuranceguides (via package)'] = guides;
  }

  // Appointments que referenciam os packages
  if (packageIds.length > 0) {
    const appts = await db.collection('appointments').find({ package: { $in: packageIds } }).toArray();
    // mesclar com os já encontrados por patient
    const existingAppts = toDelete['appointments'] || [];
    const existingIds = new Set(existingAppts.map(a => a._id.toString()));
    const newAppts = appts.filter(a => !existingIds.has(a._id.toString()));
    if (newAppts.length > 0) {
      toDelete['appointments'] = [...existingAppts, ...newAppts];
    }
  }

  // Sessions que referenciam os packages
  if (packageIds.length > 0) {
    const sessions = await db.collection('sessions').find({ package: { $in: packageIds } }).toArray();
    const existingSessions = toDelete['sessions'] || [];
    const existingIds = new Set(existingSessions.map(s => s._id.toString()));
    const newSessions = sessions.filter(s => !existingIds.has(s._id.toString()));
    if (newSessions.length > 0) {
      toDelete['sessions'] = [...existingSessions, ...newSessions];
    }
  }

  // Payments que referenciam os packages
  if (packageIds.length > 0) {
    const payments = await db.collection('payments').find({ package: { $in: packageIds } }).toArray();
    const existingPayments = toDelete['payments'] || [];
    const existingIds = new Set(existingPayments.map(p => p._id.toString()));
    const newPayments = payments.filter(p => !existingIds.has(p._id.toString()));
    if (newPayments.length > 0) {
      toDelete['payments'] = [...existingPayments, ...newPayments];
    }
  }

  // 3. Resumo
  console.log('=== DOCUMENTOS ENCONTRADOS ===\n');
  let totalDocs = 0;
  for (const [collName, docs] of Object.entries(toDelete)) {
    console.log(`${collName}: ${docs.length} documentos`);
    totalDocs += docs.length;
  }

  // Paciente
  console.log(`\npatients: 1 documento (o próprio paciente)`);
  totalDocs += 1;

  console.log(`\nTOTAL: ${totalDocs} documentos`);

  if (isDryRun) {
    console.log('\n[DRY-RUN] Nada foi deletado. Use --apply para executar a deleção.');
    await mongoose.disconnect();
    return;
  }

  // 4. APLICAR DELEÇÃO
  console.log('\n⚠️  DELETANDO...\n');

  for (const [collName, docs] of Object.entries(toDelete)) {
    const ids = docs.map(d => d._id);
    const result = await db.collection(collName).deleteMany({ _id: { $in: ids } });
    console.log(`✅ ${collName}: ${result.deletedCount} deletados`);
  }

  // Deletar paciente
  await db.collection('patients').deleteOne({ _id: patientId });
  console.log('✅ patients: 1 deletado');

  console.log('\n🗑️  Paciente e todos os dados relacionados foram removidos.');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
