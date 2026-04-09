// 🔧 Script para criar índices MongoDB (idempotente)
// Roda uma vez para garantir performance e unicidade
//
// USO: node scripts/setup-mongodb-indexes.mjs

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

async function setup() {
    console.log('========================================');
    console.log('🔧 SETUP: Criando índices MongoDB');
    console.log('========================================\n');

    console.log('🔗 Conectando...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado!\n');

    const db = mongoose.connection.db;

    // ============================================
    // 1. Índices de PatientBalance (transações)
    // ============================================
    console.log('📊 PatientBalance.transactions:');
    
    try {
        await db.collection('patientbalances').createIndex(
            { 'transactions.appointmentId': 1 },
            { name: 'idx_transactions_appointmentId' }
        );
        console.log('   ✅ appointmentId nas transações');
    } catch (e) {
        console.log('   ⚠️  appointmentId:', e.message);
    }

    try {
        await db.collection('patientbalances').createIndex(
            { 'transactions.correlationId': 1 },
            { name: 'idx_transactions_correlationId' }
        );
        console.log('   ✅ correlationId nas transações');
    } catch (e) {
        console.log('   ⚠️  correlationId:', e.message);
    }

    try {
        await db.collection('patientbalances').createIndex(
            { 'transactions.specialty': 1 },
            { name: 'idx_transactions_specialty' }
        );
        console.log('   ✅ specialty nas transações');
    } catch (e) {
        console.log('   ⚠️  specialty:', e.message);
    }

    try {
        await db.collection('patientbalances').createIndex(
            { 'transactions.settledByPackageId': 1 },
            { name: 'idx_transactions_settledByPackageId' }
        );
        console.log('   ✅ settledByPackageId nas transações');
    } catch (e) {
        console.log('   ⚠️  settledByPackageId:', e.message);
    }

    // ============================================
    // 2. Índices de Appointment
    // ============================================
    console.log('\n📊 appointments:');

    try {
        await db.collection('appointments').createIndex(
            { correlationId: 1 },
            { unique: true, sparse: true, name: 'idx_correlationId_unique' }
        );
        console.log('   ✅ correlationId (único)');
    } catch (e) {
        console.log('   ⚠️  correlationId:', e.message);
    }

    // ============================================
    // 3. Índices de Session
    // ============================================
    console.log('\n📊 sessions:');

    try {
        await db.collection('sessions').createIndex(
            { appointmentId: 1 },
            { unique: true, sparse: true, name: 'idx_appointmentId_unique' }
        );
        console.log('   ✅ appointmentId (único)');
    } catch (e) {
        console.log('   ⚠️  appointmentId:', e.message);
    }

    // ============================================
    // Verificação final
    // ============================================
    console.log('\n========================================');
    console.log('📋 Índices existentes:');

    const patientBalanceIndexes = await db.collection('patientbalances').indexes();
    console.log(`   PatientBalance: ${patientBalanceIndexes.length} índices`);

    const appointmentIndexes = await db.collection('appointments').indexes();
    console.log(`   Appointments: ${appointmentIndexes.length} índices`);

    const sessionIndexes = await db.collection('sessions').indexes();
    console.log(`   Sessions: ${sessionIndexes.length} índices`);

    console.log('\n✅ Setup concluído!');

    await mongoose.disconnect();
    process.exit(0);
}

setup().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
