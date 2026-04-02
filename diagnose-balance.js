#!/usr/bin/env node
/**
 * 🔍 DIAGNÓSTICO DO BALANCE
 * Verifica todo o fluxo: Appointment → Event → Worker → PatientBalance
 */

import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Conectar ao MongoDB
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica';
await mongoose.connect(mongoUri);
console.log('✅ MongoDB conectado\n');

// Importar models
const { default: PatientBalance } = await import(join(rootDir, 'back/models/PatientBalance.js'));
const { default: Appointment } = await import(join(rootDir, 'back/models/Appointment.js'));
const { default: EventStore } = await import(join(rootDir, 'back/models/EventStore.js'));

const patientId = process.argv[2];

if (!patientId) {
    console.log('Uso: node diagnose-balance.js <patientId>');
    console.log('Exemplo: node diagnose-balance.js 69cab94949eddc65b58f48f3\n');
    process.exit(1);
}

console.log(`🔍 Analisando paciente: ${patientId}\n`);

// 1. Verificar PatientBalance
console.log('1️⃣  PatientBalance:');
const balance = await PatientBalance.findOne({ patient: patientId }).lean();
if (balance) {
    console.log(`   currentBalance: ${balance.currentBalance}`);
    console.log(`   totalDebited: ${balance.totalDebited}`);
    console.log(`   totalCredited: ${balance.totalCredited}`);
    console.log(`   transactions: ${balance.transactions?.length || 0}`);
    
    if (balance.transactions?.length > 0) {
        console.log('\n   Últimas transações:');
        balance.transactions.slice(-3).forEach((t, i) => {
            console.log(`   ${i+1}. ${t.type}: R$ ${t.amount} - ${t.description?.substring(0, 40)}`);
        });
    }
} else {
    console.log('   ❌ Nenhum registro encontrado');
}

// 2. Verificar appointments com addToBalance
console.log('\n2️⃣  Appointments com addToBalance:');
const appointments = await Appointment.find({
    patient: patientId,
    addedToBalance: true
}).lean();

console.log(`   Encontrados: ${appointments.length}`);
appointments.forEach((apt, i) => {
    console.log(`   ${i+1}. ${apt._id}`);
    console.log(`      balanceAmount: ${apt.balanceAmount}`);
    console.log(`      operationalStatus: ${apt.operationalStatus}`);
    console.log(`      paymentStatus: ${apt.paymentStatus}`);
});

// 3. Verificar eventos BALANCE_UPDATE_REQUESTED
console.log('\n3️⃣  Eventos BALANCE_UPDATE_REQUESTED:');
const events = await EventStore.find({
    eventType: 'BALANCE_UPDATE_REQUESTED',
    'payload.patientId': patientId
}).sort({ createdAt: -1 }).limit(5).lean();

console.log(`   Encontrados: ${events.length}`);
events.forEach((evt, i) => {
    console.log(`   ${i+1}. ${evt.eventId}`);
    console.log(`      status: ${evt.status}`);
    console.log(`      amount: ${evt.payload?.amount}`);
    console.log(`      createdAt: ${evt.createdAt}`);
});

// 4. Verificar eventos APPOINTMENT_COMPLETE_REQUESTED com addToBalance
console.log('\n4️⃣  Eventos APPOINTMENT_COMPLETE_REQUESTED:');
const completeEvents = await EventStore.find({
    eventType: 'APPOINTMENT_COMPLETE_REQUESTED',
    'payload.patientId': patientId,
    'payload.addToBalance': true
}).sort({ createdAt: -1 }).limit(5).lean();

console.log(`   Encontrados: ${completeEvents.length}`);
completeEvents.forEach((evt, i) => {
    console.log(`   ${i+1}. ${evt.eventId}`);
    console.log(`      status: ${evt.status}`);
    console.log(`      balanceAmount: ${evt.payload?.balanceAmount}`);
});

// Resumo
console.log('\n📊 RESUMO:');
if (!balance || balance.currentBalance === 0) {
    if (appointments.length > 0 && (!balance || balance.currentBalance === 0)) {
        console.log('❌ PROBLEMA: Appointments têm addToBalance=true mas PatientBalance está zerado!');
        console.log('\n🔧 Possíveis causas:');
        console.log('   1. O evento BALANCE_UPDATE_REQUESTED não foi publicado');
        console.log('   2. O BalanceWorker não está rodando');
        console.log('   3. O evento falhou e foi para DLQ');
        console.log('   4. O evento ainda está na fila (aguardando processamento)');
    }
}

await mongoose.disconnect();
process.exit(0);
