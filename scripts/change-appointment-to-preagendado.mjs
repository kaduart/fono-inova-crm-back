/**
 * Script para alterar um appointment de 'missed' para 'pre_agendado'.
 * Uso: node scripts/change-appointment-to-preagendado.mjs <appointment-id> [--confirm]
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

const APPOINTMENT_ID = process.argv[2];
const CONFIRM = process.argv.includes('--confirm');

if (!APPOINTMENT_ID || !/^[0-9a-fA-F]{24}$/.test(APPOINTMENT_ID)) {
  console.error('❌ Informe um appointment ID válido (24 hex chars).');
  console.error('Exemplo: node scripts/change-appointment-to-preagendado.mjs 6a2c76f0eaef447c17cd34dd --confirm');
  process.exit(1);
}

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não configurado no .env');
  process.exit(1);
}

console.log(`🔌 Conectando ao MongoDB...`);
console.log(`🎯 Database: ${MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);

await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 20000 });
console.log('✅ Conectado');

const db = mongoose.connection.db;
const appointmentsCol = db.collection('appointments');
const sessionsCol = db.collection('sessions');
const paymentsCol = db.collection('payments');

try {
  // 1. Buscar appointment atual
  const appointment = await appointmentsCol.findOne({ _id: new mongoose.Types.ObjectId(APPOINTMENT_ID) });
  
  if (!appointment) {
    console.error(`❌ Appointment ${APPOINTMENT_ID} não encontrado`);
    process.exit(1);
  }

  console.log('\n📋 ESTADO ATUAL:');
  console.log(`   _id: ${appointment._id}`);
  console.log(`   operationalStatus: ${appointment.operationalStatus}`);
  console.log(`   clinicalStatus: ${appointment.clinicalStatus}`);
  console.log(`   patient: ${appointment.patient?.toString?.() || appointment.patientInfo?.fullName || 'N/A'}`);
  console.log(`   doctor: ${appointment.doctor?.toString?.() || appointment.professionalName || 'N/A'}`);
  console.log(`   date: ${appointment.date}`);
  console.log(`   time: ${appointment.time}`);
  console.log(`   payment: ${appointment.payment?.toString?.() || 'null'}`);
  console.log(`   session: ${appointment.session?.toString?.() || 'null'}`);

  // 2. Validar transição permitida
  const ALLOWED_FROM = ['missed', 'scheduled', 'confirmed', 'pending', 'canceled'];
  if (!ALLOWED_FROM.includes(appointment.operationalStatus)) {
    console.error(`❌ Transição de '${appointment.operationalStatus}' para 'pre_agendado' não permitida.`);
    process.exit(1);
  }

  if (appointment.operationalStatus === 'pre_agendado') {
    console.log('ℹ️ Appointment já está com operationalStatus=pre_agendado');
    process.exit(0);
  }

  // 3. Fazer backup
  const backupDir = path.resolve(process.cwd(), 'scripts', 'backups-migration');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `appointment-${APPOINTMENT_ID}-${Date.now()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(appointment, null, 2));
  console.log(`\n💾 Backup salvo em: ${backupFile}`);

  // 4. Verificar documentos relacionados
  const relatedSession = appointment.session 
    ? await sessionsCol.findOne({ _id: appointment.session }) 
    : null;
  const relatedPayment = appointment.payment 
    ? await paymentsCol.findOne({ _id: appointment.payment }) 
    : null;

  if (relatedSession) {
    console.log(`\n⚠️  Session vinculada encontrada: ${relatedSession._id} (status: ${relatedSession.status})`);
  }
  if (relatedPayment) {
    console.log(`\n⚠️  Payment vinculado encontrado: ${relatedPayment._id} (status: ${relatedPayment.status}, amount: ${relatedPayment.amount})`);
  }

  if (!CONFIRM) {
    console.log('\n⛔ MODO SIMULAÇÃO — nenhuma alteração foi feita.');
    console.log('   Adicione --confirm para executar a alteração.');
    process.exit(0);
  }

  // 5. Executar alteração
  const now = new Date();
  const historyEntry = {
    action: 'status_change',
    newStatus: 'pre_agendado',
    previousStatus: appointment.operationalStatus,
    changedBy: null,
    timestamp: now,
    context: 'Migration script: revertido de missed para pre_agendado'
  };

  const updateResult = await appointmentsCol.updateOne(
    { _id: appointment._id },
    {
      $set: {
        operationalStatus: 'pre_agendado',
        clinicalStatus: 'pending',
        updatedAt: now
      },
      $push: { history: historyEntry }
    }
  );

  if (updateResult.modifiedCount !== 1) {
    throw new Error(`Falha ao atualizar appointment: ${JSON.stringify(updateResult)}`);
  }

  // 6. Atualizar session vinculada, se existir
  //    Session não aceita 'pre_agendado' no enum; 'pending' é o equivalente.
  if (relatedSession) {
    await sessionsCol.updateOne(
      { _id: relatedSession._id },
      {
        $set: {
          status: 'pending',
          completedAt: null,
          confirmedAbsence: null,
          updatedAt: now
        }
      }
    );
    console.log(`   ✅ Session ${relatedSession._id} atualizada para status=pending`);
  }

  // 7. Verificar estado final
  const updated = await appointmentsCol.findOne({ _id: appointment._id });
  console.log('\n✅ ALTERAÇÃO CONCLUÍDA:');
  console.log(`   operationalStatus: ${updated.operationalStatus}`);
  console.log(`   clinicalStatus: ${updated.clinicalStatus}`);
  console.log(`   updatedAt: ${updated.updatedAt}`);

  if (relatedPayment) {
    console.log('\n⚠️  ATENÇÃO: Existe um Payment vinculado que NÃO foi alterado.');
    console.log(`   Se necessário, analise/cancele manualmente: ${relatedPayment._id}`);
  }

} catch (error) {
  console.error('\n💥 ERRO:', error.message);
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await mongoose.connection.close();
  console.log('\n🔌 Conexão fechada');
}
