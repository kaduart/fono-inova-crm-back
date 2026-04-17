/**
 * PATCH: Corrige specialty nos appointments onde foi gravado 'fonoaudiologia'
 * mas o doctor tem specialty diferente.
 *
 * Uso:
 *   DRY_RUN=true  node scripts/patch-fix-specialty-from-doctor.js   (padrão, só lista)
 *   DRY_RUN=false node scripts/patch-fix-specialty-from-doctor.js   (aplica correção)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`\n🔍 Modo: ${DRY_RUN ? 'DRY RUN (só leitura)' : '⚠️  REAL (vai atualizar)'}\n`);

  // Busca appointments com specialty = fonoaudiologia a partir de 17/04/2026
  const fromDate = new Date('2026-04-17T00:00:00.000Z');
  const appointments = await db.collection('appointments').find({
    specialty: 'fonoaudiologia',
    doctor: { $exists: true, $ne: null },
    date: { $gte: fromDate }
  }).toArray();

  console.log(`📊 Appointments com specialty=fonoaudiologia: ${appointments.length}`);

  // Agrupa por doctorId para minimizar queries
  const doctorIds = [...new Set(appointments.map(a => a.doctor?.toString()).filter(Boolean))];
  console.log(`👨‍⚕️ Doctors únicos: ${doctorIds.length}`);

  // Busca specialty real de cada doctor
  const doctorMap = new Map();
  for (const idStr of doctorIds) {
    const doc = await db.collection('doctors').findOne(
      { _id: new mongoose.Types.ObjectId(idStr) },
      { projection: { fullName: 1, specialty: 1 } }
    );
    if (doc) {
      doctorMap.set(idStr, { fullName: doc.fullName, specialty: doc.specialty });
    }
  }

  // Filtra apenas os que têm specialty diferente da gravada
  const toFix = appointments.filter(a => {
    const doctorInfo = doctorMap.get(a.doctor?.toString());
    return doctorInfo && doctorInfo.specialty && doctorInfo.specialty !== 'fonoaudiologia';
  });

  console.log(`\n🔧 Appointments com specialty errada (doctor NÃO é fonoaudiólogo): ${toFix.length}`);

  if (toFix.length === 0) {
    console.log('✅ Nada a corrigir.');
    await mongoose.disconnect();
    return;
  }

  for (const appt of toFix) {
    const doctorInfo = doctorMap.get(appt.doctor?.toString());
    const correctSpecialty = doctorInfo.specialty;
    console.log(`  ${DRY_RUN ? '[DRY]' : '[FIX]'} ${appt._id} | ${doctorInfo.fullName} | fonoaudiologia → ${correctSpecialty}`);

    if (!DRY_RUN) {
      await db.collection('appointments').updateOne(
        { _id: appt._id },
        { $set: { specialty: correctSpecialty, sessionType: correctSpecialty, updatedAt: new Date() } }
      );
    }
  }

  if (DRY_RUN) {
    console.log('\nℹ️  DRY RUN — nada foi alterado.');
    console.log('   Para aplicar: DRY_RUN=false node scripts/patch-fix-specialty-from-doctor.js');
  } else {
    console.log(`\n✅ ${toFix.length} appointments corrigidos.`);
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
