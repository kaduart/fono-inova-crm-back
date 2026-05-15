import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('=== GERANDO SNAPSHOT PRE-MIGRACAO ===\n');

  const snapshot = {
    generatedAt: new Date().toISOString(),
    description: 'Estado completo antes da migracao em massa de packages convenio',
    packages: [],
    guides: [],
    patients: []
  };

  const packages = await db.collection('packages').find({
    type: 'convenio',
    status: { $in: ['active', 'in-progress'] }
  }).toArray();

  console.log(`Packages ativos encontrados: ${packages.length}`);

  for (const pkg of packages) {
    snapshot.packages.push({
      _id: pkg._id.toString(),
      status: pkg.status,
      type: pkg.type,
      totalSessions: pkg.totalSessions,
      sessionsDone: pkg.sessionsDone,
      totalValue: pkg.totalValue,
      totalPaid: pkg.totalPaid,
      balance: pkg.balance,
      insuranceGuideId: pkg.insuranceGuide?.toString(),
      insuranceProvider: pkg.insuranceProvider,
      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt
    });

    if (pkg.insuranceGuide) {
      const guide = await db.collection('insuranceguides').findOne({ _id: pkg.insuranceGuide });
      if (guide) {
        snapshot.guides.push({
          _id: guide._id.toString(),
          number: guide.number,
          patientId: guide.patientId?.toString(),
          totalSessions: guide.totalSessions,
          usedSessions: guide.usedSessions,
          status: guide.status,
          packageId: guide.packageId?.toString()
        });
      }
    }

    const patient = await db.collection('patients').findOne({ _id: pkg.patient });
    if (patient) {
      const existing = snapshot.patients.find(p => p._id === patient._id.toString());
      if (!existing) {
        snapshot.patients.push({
          _id: patient._id.toString(),
          fullName: patient.fullName,
          packagesCount: patient.packages?.length || 0,
          packageIds: (patient.packages || []).map(p => p.toString())
        });
      }
    }
  }

  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const snapPath = path.join(logsDir, `migration-snapshot-BEFORE-${Date.now()}.json`);
  fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2));

  console.log('\n✅ Snapshot salvo em:');
  console.log(snapPath);
  console.log(`\nResumo:`);
  console.log(`  Packages: ${snapshot.packages.length}`);
  console.log(`  Guias: ${snapshot.guides.length}`);
  console.log(`  Pacientes: ${snapshot.patients.length}`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
