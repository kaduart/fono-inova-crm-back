import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('=== POS-AUDITORIA: VALIDACOES POS-MIGRACAO ===\n');

  // 1. Packages convenio ativos
  const activeConvenio = await db.collection('packages').countDocuments({
    type: 'convenio',
    status: { $in: ['active', 'in-progress'] }
  });
  console.log('1. Packages convenio ativos:', activeConvenio, '(esperado: 0)');
  console.log('   PASSOU:', activeConvenio === 0 ? 'SIM' : 'NAO');

  // 2. Patients com packages convenio ativos
  const patientIdsWithActive = await db.collection('packages').distinct('patient', {
    type: 'convenio',
    status: { $in: ['active', 'in-progress'] }
  });
  console.log('\n2. Pacientes com packages convenio ativos:', patientIdsWithActive.length, '(esperado: 0)');
  console.log('   PASSOU:', patientIdsWithActive.length === 0 ? 'SIM' : 'NAO');

  // 3. Sessions com paymentMethod package_prepaid em convenio
  const badSessions = await db.collection('sessions').countDocuments({
    insuranceGuide: { $ne: null },
    $or: [
      { paymentOrigin: 'package_prepaid' },
      { paymentMethod: 'package_prepaid' },
      { paymentStatus: 'package_paid' }
    ]
  });
  console.log('\n3. Sessions anomalas (package_prepaid em convenio):', badSessions, '(esperado: 0)');
  console.log('   PASSOU:', badSessions === 0 ? 'SIM' : 'NAO');

  // 4. Guides divergentes
  const guides = await db.collection('insuranceguides').find({}).toArray();
  let divergentGuides = 0;
  for (const guide of guides) {
    const completedCount = await db.collection('sessions').countDocuments({
      insuranceGuide: guide._id,
      status: 'completed'
    });
    if (completedCount !== guide.usedSessions) {
      divergentGuides++;
      if (divergentGuides <= 3) {
        console.log(`   Divergencia: Guia ${guide.number} — usedSessions: ${guide.usedSessions}, completed: ${completedCount}`);
      }
    }
  }
  console.log('\n4. Guias divergentes:', divergentGuides, '(esperado: 0)');
  console.log('   PASSOU:', divergentGuides === 0 ? 'SIM' : 'NAO');

  // 5. Packages superseded com migration marker
  const supersededWithMarker = await db.collection('packages').countDocuments({
    type: 'convenio',
    status: 'superseded',
    migratedToInsuranceGuide: true
  });
  const totalSuperseded = await db.collection('packages').countDocuments({
    type: 'convenio',
    status: 'superseded'
  });
  console.log('\n5. Packages superseded com migration marker:', supersededWithMarker, 'de', totalSuperseded);
  console.log('   PASSOU:', supersededWithMarker === totalSuperseded ? 'SIM' : 'NAO');

  // 6. Appointments com billingType=convenio mas sem insuranceGuide
  const orphanedAppointments = await db.collection('appointments').countDocuments({
    billingType: 'convenio',
    $or: [
      { insuranceGuide: { $exists: false } },
      { insuranceGuide: null }
    ]
  });
  console.log('\n6. Appointments convenio sem insuranceGuide:', orphanedAppointments, '(esperado: 0)');
  console.log('   PASSOU:', orphanedAppointments === 0 ? 'SIM' : 'NAO');

  // 7. Resumo
  const allPass = activeConvenio === 0 &&
                  patientIdsWithActive.length === 0 &&
                  badSessions === 0 &&
                  divergentGuides === 0 &&
                  supersededWithMarker === totalSuperseded &&
                  orphanedAppointments === 0;

  console.log('\n' + '='.repeat(60));
  console.log(allPass ? 'TODAS AS VALIDACOES PASSARAM!' : 'ALGUMAS VALIDACOES FALHARAM');
  console.log('='.repeat(60));

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
