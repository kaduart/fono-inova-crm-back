/**
 * Script para criar índices MongoDB para otimização de performance
 * Execute com: node scripts/setup-mongodb-indexes.mjs
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/crm-clinica';

async function setupIndexes() {
    try {
        console.log('🔗 Conectando ao MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Conectado!\n');

        const db = mongoose.connection.db;

        // ============================================
        // APPOINTMENTS
        // ============================================
        console.log('📅 Criando índices em appointments...');
        
        await db.collection('appointments').createIndex({ date: 1 });
        console.log('  ✓ date (para filtros por data)');
        
        await db.collection('appointments').createIndex({ doctor: 1, date: 1 });
        console.log('  ✓ doctor + date (para calendário)');
        
        await db.collection('appointments').createIndex({ patient: 1, date: -1 });
        console.log('  ✓ patient + date (para histórico)');
        
        await db.collection('appointments').createIndex({ status: 1 });
        console.log('  ✓ status (para filtros)');
        
        await db.collection('appointments').createIndex({ session: 1 });
        console.log('  ✓ session (para joins)');
        
        await db.collection('appointments').createIndex({ payment: 1 });
        console.log('  ✓ payment (para joins)');
        
        await db.collection('appointments').createIndex({ package: 1 });
        console.log('  ✓ package (para joins)');

        // ============================================
        // SESSIONS
        // ============================================
        console.log('\n📋 Criando índices em sessions...');
        
        await db.collection('sessions').createIndex({ package: 1 });
        console.log('  ✓ package (para buscar sessões do pacote)');
        
        await db.collection('sessions').createIndex({ patient: 1 });
        console.log('  ✓ patient (para histórico)');
        
        await db.collection('sessions').createIndex({ appointment: 1 });
        console.log('  ✓ appointment (para joins)');
        
        await db.collection('sessions').createIndex({ status: 1 });
        console.log('  ✓ status (para filtros)');
        
        await db.collection('sessions').createIndex({ date: 1 });
        console.log('  ✓ date (para relatórios)');

        // ============================================
        // PAYMENTS
        // ============================================
        console.log('\n💰 Criando índices em payments...');
        
        await db.collection('payments').createIndex({ patient: 1 });
        console.log('  ✓ patient (para histórico)');
        
        await db.collection('payments').createIndex({ session: 1 });
        console.log('  ✓ session (para joins)');
        
        await db.collection('payments').createIndex({ appointment: 1 });
        console.log('  ✓ appointment (para joins)');
        
        await db.collection('payments').createIndex({ package: 1 });
        console.log('  ✓ package (para joins)');
        
        await db.collection('payments').createIndex({ status: 1 });
        console.log('  ✓ status (para filtros)');
        
        await db.collection('payments').createIndex({ date: 1 });
        console.log('  ✓ date (para relatórios)');
        
        await db.collection('payments').createIndex({ createdAt: -1 });
        console.log('  ✓ createdAt (para ordenação)');

        // ============================================
        // PACKAGES
        // ============================================
        console.log('\n📦 Criando índices em packages...');
        
        await db.collection('packages').createIndex({ patient: 1 });
        console.log('  ✓ patient (para listar pacotes)');
        
        await db.collection('packages').createIndex({ status: 1 });
        console.log('  ✓ status (para filtros)');
        
        await db.collection('packages').createIndex({ type: 1 });
        console.log('  ✓ type (para filtros por tipo)');

        // ============================================
        // PATIENTS
        // ============================================
        console.log('\n👤 Criando índices em patients...');
        
        await db.collection('patients').createIndex({ name: 'text', email: 'text' });
        console.log('  ✓ text index (para busca)');
        
        await db.collection('patients').createIndex({ phone: 1 });
        console.log('  ✓ phone (para busca rápida)');

        // ============================================
        // PATIENTBALANCES
        // ============================================
        console.log('\n⚖️ Criando índices em patientbalances...');
        
        await db.collection('patientbalances').createIndex({ patient: 1 }, { unique: true });
        console.log('  ✓ patient (único, para getOrCreate)');

        console.log('\n✅ Todos os índices criados com sucesso!');
        console.log('\n📊 Índices criados:');
        
        // Listar índices criados
        const collections = ['appointments', 'sessions', 'payments', 'packages', 'patients', 'patientbalances'];
        for (const coll of collections) {
            const indexes = await db.collection(coll).indexes();
            console.log(`\n${coll}:`);
            indexes.forEach(idx => {
                console.log(`  - ${idx.name}: ${JSON.stringify(idx.key)}`);
            });
        }

    } catch (error) {
        console.error('❌ Erro:', error.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado do MongoDB');
    }
}

// Executar
setupIndexes();
