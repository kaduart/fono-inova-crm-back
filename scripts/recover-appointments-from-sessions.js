/**
 * 🚨 RECOVERY: Reconstrói appointments deletados a partir de sessions órfãs
 *
 * Contexto: db.appointments.deleteMany({ "patientInfo.fullName": { $in: ["", null] } })
 * deletou ~860 appointments. Sessions ainda existem com appointmentId referenciando
 * documentos que não existem mais.
 *
 * Estratégia:
 *   1. Achar todas sessions cujo appointmentId não existe em appointments
 *   2. Agrupar por appointmentId (N sessions → 1 appointment)
 *   3. Buscar patientInfo da coleção patients
 *   4. Reconstruir e reinserir o appointment com o _id original
 *
 * MODO:
 *   DRY_RUN=true  → só lista (padrão)
 *   DRY_RUN=false → insere de volta
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';

// Mapeamento de status session → appointment
function mapStatus(sessionStatus) {
  switch (sessionStatus) {
    case 'completed': return { operationalStatus: 'completed', clinicalStatus: 'completed' };
    case 'canceled':  return { operationalStatus: 'canceled',  clinicalStatus: 'pending' };
    case 'missed':    return { operationalStatus: 'no_show',   clinicalStatus: 'pending' };
    case 'scheduled': return { operationalStatus: 'scheduled', clinicalStatus: 'pending' };
    default:          return { operationalStatus: 'scheduled', clinicalStatus: 'pending' };
  }
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`\n🔍 Modo: ${DRY_RUN ? 'DRY RUN (só leitura)' : '⚠️  REAL (vai inserir)'}\n`);

  // 1. Buscar sessions órfãs
  const orphanedSessions = await db.collection('sessions').aggregate([
    {
      $lookup: {
        from: 'appointments',
        localField: 'appointmentId',
        foreignField: '_id',
        as: 'appt'
      }
    },
    {
      $match: {
        appt: { $size: 0 },
        appointmentId: { $exists: true, $ne: null }
      }
    },
    {
      $project: { appt: 0 }
    }
  ]).toArray();

  console.log(`📊 Sessions órfãs encontradas: ${orphanedSessions.length}`);

  // 2. Agrupar por appointmentId (pegar 1 session por appointment)
  const byAppointment = new Map();
  for (const s of orphanedSessions) {
    const key = s.appointmentId.toString();
    if (!byAppointment.has(key)) {
      byAppointment.set(key, s);
    }
  }

  console.log(`📊 Appointments únicos a reconstruir: ${byAppointment.size}\n`);

  // 3. Reconstruir cada appointment
  const toInsert = [];
  let skipped = 0;

  for (const [apptIdStr, session] of byAppointment) {
    // Buscar patientInfo da coleção patients
    let patientInfo = { fullName: 'Recuperado', phone: '', dateOfBirth: null };
    if (session.patient) {
      const patient = await db.collection('patients').findOne(
        { _id: session.patient },
        { projection: { fullName: 1, name: 1, phone: 1, dateOfBirth: 1, cpf: 1 } }
      );
      if (patient) {
        patientInfo = {
          fullName: patient.fullName || patient.name || 'Paciente Recuperado',
          phone: patient.phone || '',
          dateOfBirth: patient.dateOfBirth || null,
          cpf: patient.cpf || ''
        };
      }
    }

    const { operationalStatus, clinicalStatus } = mapStatus(session.status);

    const appointment = {
      _id: session.appointmentId,  // Mantém o _id original
      patient: session.patient || null,
      doctor: session.doctor || null,
      date: session.date,
      time: session.time,
      specialty: session.sessionType || 'fonoaudiologia',
      sessionType: session.sessionType || 'fonoaudiologia',
      serviceType: session.package ? 'package_session' : 'individual_session',
      operationalStatus,
      clinicalStatus,
      paymentStatus: session.paymentStatus || 'unpaid',
      session: session._id,
      package: session.package || null,
      billingType: 'particular',  // Não temos como recuperar, default particular
      patientInfo,
      notes: '',
      _recovered: true,  // Flag para identificar docs recuperados
      _recoveredAt: new Date(),
      createdAt: session.createdAt || new Date(),
      updatedAt: new Date()
    };

    // Verificar se já existe (segurança dupla)
    const exists = await db.collection('appointments').findOne({ _id: session.appointmentId });
    if (exists) {
      skipped++;
      continue;
    }

    toInsert.push(appointment);

    if (DRY_RUN && toInsert.length <= 5) {
      console.log(`  ✅ Exemplo → ${appointment._id}`);
      console.log(`     patient: ${patientInfo.fullName} | doctor: ${appointment.doctor}`);
      console.log(`     date: ${appointment.date?.toISOString()} ${appointment.time}`);
      console.log(`     status: ${operationalStatus} | package: ${appointment.package || 'null'}\n`);
    }
  }

  console.log(`📊 Para inserir: ${toInsert.length} | Já existem: ${skipped}`);

  if (DRY_RUN) {
    console.log('\n──────────────────────────────────────────');
    console.log('ℹ️  DRY RUN — nada foi inserido.');
    console.log('   Para executar: DRY_RUN=false node scripts/recover-appointments-from-sessions.js');
    await mongoose.disconnect();
    return;
  }

  // 4. Inserir em lotes de 100
  let inserted = 0;
  const BATCH = 100;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    try {
      await db.collection('appointments').insertMany(batch, { ordered: false });
      inserted += batch.length;
      console.log(`  ✅ Lote ${Math.floor(i / BATCH) + 1}: ${batch.length} inseridos (total: ${inserted})`);
    } catch (err) {
      // ordered: false — continua mesmo com erros de duplicata
      const okCount = err.result?.insertedCount || 0;
      inserted += okCount;
      console.log(`  ⚠️  Lote com ${err.writeErrors?.length || '?'} erros (${okCount} ok)`);
    }
  }

  console.log(`\n✅ Recovery concluído. ${inserted} appointments reinseridos.`);
  console.log(`   ⚠️  billingType foi defaultado para 'particular' — revisar se necessário`);
  console.log(`   ⚠️  Appointments recuperados têm flag _recovered: true para auditoria`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
