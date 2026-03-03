import mongoose from 'mongoose';
import { config } from 'dotenv';

config();

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova';

await mongoose.connect(uri);
const db = mongoose.connection.db;

// 1. Buscar paciente Gabriel
const paciente = await db.collection('patients').findOne({
  fullName: { $regex: /Gabriel Soares/i }
});

console.log('=== PACIENTE ===');
console.log(paciente ? 'ENCONTRADO: ' + paciente.fullName + ' (ID: ' + paciente._id + ')' : 'NÃO ENCONTRADO');

// 2. Buscar appointments
const appointments = await db.collection('appointments').find({
  patientName: { $regex: /Gabriel Soares/i }
}).toArray();

console.log('\n=== APPOINTMENTS: ' + appointments.length + ' ===');
appointments.forEach(a => console.log('- ' + a.date + ' ' + a.time + ' | ' + a.operationalStatus));

// 3. Buscar pré-agendamentos
const pre = await db.collection('preagendamentos').find({
  'patientInfo.fullName': { $regex: /Gabriel Soares/i }
}).toArray();

console.log('\n=== PRÉ-AGENDAMENTOS: ' + pre.length + ' ===');
pre.forEach(p => console.log('- ' + p.preferredDate + ' ' + p.preferredTime + ' | status: ' + p.status));

// 4. Verificar logs de exclusão
const logs = await db.collection('logs').find({
  action: { $regex: /delete|remove|excluir|deletar/i }
}).sort({ timestamp: -1 }).limit(10).toArray();

console.log('\n=== ÚLTIMOS LOGS DE EXCLUSÃO ===');
logs.forEach(l => console.log('- ' + (l.timestamp || l.createdAt) + ' | ' + l.action + ' | user: ' + (l.userId || 'sistema')));

await mongoose.disconnect();
