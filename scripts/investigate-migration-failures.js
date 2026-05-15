import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('=== INVESTIGACAO DAS FALHAS ===\n');

  // 1. Package ativo restante
  const activePkg = await db.collection('packages').findOne({
    type: 'convenio',
    status: { $in: ['active', 'in-progress'] }
  });

  if (activePkg) {
    const patient = await db.collection('patients').findOne({ _id: activePkg.patient });
    console.log('1. PACKAGE ATIVO RESTANTE:');
    console.log('   ID:', activePkg._id.toString());
    console.log('   Paciente:', patient?.fullName);
    console.log('   Status:', activePkg.status);
    console.log('   Created At:', activePkg.createdAt);
    console.log('   InsuranceGuide:', activePkg.insuranceGuide?.toString() || 'null');
  }

  // 2. Guias divergentes detalhadas
  console.log('\n2. GUIAS DIVERGENTES (top 10):');
  const guides = await db.collection('insuranceguides').find({}).toArray();
  let count = 0;
  for (const guide of guides) {
    const completedCount = await db.collection('sessions').countDocuments({
      insuranceGuide: guide._id,
      status: 'completed'
    });
    if (completedCount !== guide.usedSessions) {
      count++;
      if (count <= 10) {
        console.log(`   Guia #${guide.number} (${guide.specialty}) — used: ${guide.usedSessions}, completed: ${completedCount}, delta: ${completedCount - guide.usedSessions}`);
      }
    }
  }
  console.log('   Total divergentes:', count);

  // 3. Appointments sem insuranceGuide detalhados
  console.log('\n3. APPOINTMENTS SEM INSURANCEGUIDE (por paciente):');
  const orphaned = await db.collection('appointments').find({
    billingType: 'convenio',
    $or: [
      { insuranceGuide: { $exists: false } },
      { insuranceGuide: null }
    ]
  }).toArray();

  const byPatient = {};
  for (const apt of orphaned) {
    const pid = apt.patient?.toString();
    if (!pid) continue;
    if (!byPatient[pid]) {
      byPatient[pid] = { count: 0, patientName: null };
    }
    byPatient[pid].count++;
  }

  for (const pid of Object.keys(byPatient)) {
    const patient = await db.collection('patients').findOne({ _id: new mongoose.Types.ObjectId(pid) });
    byPatient[pid].patientName = patient?.fullName || 'N/A';
  }

  const sorted = Object.entries(byPatient).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  for (const [pid, data] of sorted) {
    console.log(`   ${data.patientName}: ${data.count} appointments`);
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
