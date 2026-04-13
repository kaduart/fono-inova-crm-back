#!/usr/bin/env node
// Verifica o evento de balance no EventStore

import mongoose from 'mongoose';

const patientId = process.argv[2] || '69cab94949eddc65b58f48f3';

console.log('🔍 Verificando paciente:', patientId);
console.log('');

// Conectar
await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica');
console.log('✅ MongoDB conectado');
console.log('');

// Importar models
const EventStore = (await import('./models/EventStore.js')).default;
const PatientBalance = (await import('./models/PatientBalance.js')).default;

// 1. Buscar eventos BALANCE_UPDATE_REQUESTED
console.log('1️⃣ Eventos BALANCE_UPDATE_REQUESTED:');
const events = await EventStore.find({
  eventType: 'BALANCE_UPDATE_REQUESTED',
  'payload.patientId': patientId
}).sort({ createdAt: -1 }).limit(5);

if (events.length === 0) {
  console.log('   ❌ Nenhum evento encontrado');
} else {
  events.forEach(e => {
    console.log(`   📅 ${e.createdAt.toISOString()}`);
    console.log(`      Status: ${e.status}`);
    console.log(`      Amount: ${e.payload?.amount}`);
    console.log(`      Error: ${e.error || 'Nenhum'}`);
  });
}

console.log('');

// 2. Buscar PatientBalance
console.log('2️⃣ PatientBalance:');
const balance = await PatientBalance.findOne({ patient: patientId });

if (!balance) {
  console.log('   ❌ Nenhum registro encontrado');
} else {
  console.log(`   💰 currentBalance: ${balance.currentBalance}`);
  console.log(`   📊 totalDebited: ${balance.totalDebited}`);
  console.log(`   📊 totalCredited: ${balance.totalCredited}`);
  console.log(`   📝 Transações: ${balance.transactions?.length || 0}`);
  
  if (balance.transactions?.length > 0) {
    console.log('   Últimas transações:');
    balance.transactions.slice(-3).forEach((t, i) => {
      console.log(`     ${i+1}. ${t.type}: R$ ${t.amount} - ${t.description?.substring(0, 30)}`);
    });
  }
}

await mongoose.disconnect();
console.log('');
console.log('✅ Verificação completa');
