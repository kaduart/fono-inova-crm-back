/**
 * 🚀 Script: Adiciona índices de performance para campos de data
 * 
 * Executar: node scripts/add-date-index.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function addIndexes() {
  try {
    console.log('🔗 Conectando ao MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado!');

    const db = mongoose.connection.db;

    // Índices para Appointments
    console.log('📊 Criando índices para appointments...');
    await db.collection('appointments').createIndex({ date: 1 });
    await db.collection('appointments').createIndex({ date: 1, time: 1 });
    await db.collection('appointments').createIndex({ date: -1, time: 1 });
    await db.collection('appointments').createIndex({ operationalStatus: 1, date: 1 });
    await db.collection('appointments').createIndex({ patient: 1, date: -1 });
    await db.collection('appointments').createIndex({ doctor: 1, date: 1 });
    console.log('✅ Índices de appointments criados!');

    // Índices para Sessions
    console.log('📊 Criando índices para sessions...');
    await db.collection('sessions').createIndex({ date: 1 });
    await db.collection('sessions').createIndex({ date: 1, status: 1 });
    await db.collection('sessions').createIndex({ doctor: 1, date: 1 });
    await db.collection('sessions').createIndex({ patient: 1, date: -1 });
    console.log('✅ Índices de sessions criados!');

    // Índices para Payments
    console.log('📊 Criando índices para payments...');
    await db.collection('payments').createIndex({ paymentDate: 1 });
    await db.collection('payments').createIndex({ status: 1, paymentDate: 1 });
    await db.collection('payments').createIndex({ doctor: 1, paymentDate: 1 });
    console.log('✅ Índices de payments criados!');

    console.log('\n🎉 Todos os índices criados com sucesso!');
    console.log('⚡ As queries de calendário devem estar muito mais rápidas agora.');

  } catch (error) {
    console.error('❌ Erro:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

addIndexes();
