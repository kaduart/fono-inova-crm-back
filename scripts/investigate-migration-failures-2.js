import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  // 1. Package ativo restante — verificar se paciente existe, e se o package tem dados
  console.log('=== 1. PACKAGE ATIVO ORFAO ===');
  const activePkg = await db.collection('packages').findOne({
    type: 'convenio',
    status: { $in: ['active', 'in-progress'] }
  });
  console.log('Package completo:', JSON.stringify(activePkg, null, 2));
  
  if (activePkg?.patient) {
    const patient = await db.collection('patients').findOne({ _id: activePkg.patient });
    console.log('Paciente encontrado?', !!patient);
    if (patient) console.log('Nome:', patient.fullName);
  }

  // 2. Guias divergentes — são de packages inativos ou ativos?
  console.log('\n=== 2. GUIAS DIVERGENTES — CONTEXTUALIZACAO ===');
  const guides = await db.collection('insuranceguides').find({}).toArray();
  for (const guide of guides) {
    const completedCount = await db.collection('sessions').countDocuments({
      insuranceGuide: guide._id,
      status: 'completed'
    });
    if (completedCount !== guide.usedSessions) {
      // Encontrar appointments/payments com essa guia
      const relatedPkg = await db.collection('packages').findOne({ insuranceGuide: guide._id });
      const patient = relatedPkg ? await db.collection('patients').findOne({ _id: relatedPkg.patient }) : null;
      
      console.log(`\nGuia #${guide.number} (${guide.specialty})`);
      console.log(`  usedSessions: ${guide.usedSessions}, completed: ${completedCount}, delta: ${completedCount - guide.usedSessions}`);
      console.log(`  Package relacionado: ${relatedPkg ? relatedPkg._id.toString() : 'NENHUM'}`);
      if (relatedPkg) {
        console.log(`  Package status: ${relatedPkg.status}, type: ${relatedPkg.type}`);
        console.log(`  Package migratedToInsuranceGuide: ${relatedPkg.migratedToInsuranceGuide || false}`);
      }
      console.log(`  Paciente: ${patient?.fullName || 'N/A'}`);
      
      // Verificar se há sessions com status diferente de completed que usam essa guia
      const otherSessions = await db.collection('sessions').countDocuments({
        insuranceGuide: guide._id,
        status: { $ne: 'completed' }
      });
      console.log(`  Outras sessions (nao completed): ${otherSessions}`);
    }
  }

  // 3. Appointments sem insuranceGuide — verificar se são de packages ativos ou inativos
  console.log('\n=== 3. APPOINTMENTS SEM INSURANCEGUIDE — ORIGEM ===');
  const orphaned = await db.collection('appointments').find({
    billingType: 'convenio',
    $or: [
      { insuranceGuide: { $exists: false } },
      { insuranceGuide: null }
    ]
  }).toArray();

  const byPatientPkg = {};
  for (const apt of orphaned) {
    const pid = apt.patient?.toString();
    const pkgId = apt.package?.toString();
    if (!pid) continue;
    
    if (!byPatientPkg[pid]) {
      byPatientPkg[pid] = { 
        count: 0, 
        patientName: null,
        packages: new Set()
      };
    }
    byPatientPkg[pid].count++;
    if (pkgId) byPatientPkg[pid].packages.add(pkgId);
  }

  for (const pid of Object.keys(byPatientPkg)) {
    const patient = await db.collection('patients').findOne({ _id: new mongoose.Types.ObjectId(pid) });
    byPatientPkg[pid].patientName = patient?.fullName || 'N/A';
    
    // Verificar status dos packages
    const pkgStatuses = [];
    for (const pkgId of byPatientPkg[pid].packages) {
      const pkg = await db.collection('packages').findOne({ _id: new mongoose.Types.ObjectId(pkgId) });
      pkgStatuses.push(pkg ? { id: pkgId, status: pkg.status, type: pkg.type, migrated: pkg.migratedToInsuranceGuide } : { id: pkgId, status: 'DELETED' });
    }
    byPatientPkg[pid].pkgStatuses = pkgStatuses;
  }

  for (const [pid, data] of Object.entries(byPatientPkg)) {
    console.log(`\n${data.patientName}: ${data.count} appointments`);
    console.log(`  Packages referenciados: ${data.pkgStatuses.length}`);
    for (const pkg of data.pkgStatuses) {
      console.log(`    - ${pkg.id?.substring(0,8)}... status: ${pkg.status}, type: ${pkg.type}, migrated: ${pkg.migrated || false}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
