// 🛡️ Adiciona unique indexes para prevenir duplicidades
// USO: DRY_RUN=false node add-unique-indexes.js

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import PatientBalance from '../models/PatientBalance.js';
import Package from '../models/Package.js';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

const INDEXES_TO_ADD = [
    // ============================================
    // PatientBalance - Prevenir duplicidades
    // ============================================
    {
        collection: 'patientbalances',
        name: 'unique_debit_per_appointment',
        keys: { 'transactions.appointmentId': 1 },
        options: {
            partialFilterExpression: { 'transactions.appointmentId': { $exists: true } },
            sparse: true,
            background: true
        },
        description: 'Previne criar 2 débitos para o mesmo appointment'
    },
    {
        collection: 'patientbalances', 
        name: 'unique_correlation_id',
        keys: { 'transactions.correlationId': 1 },
        options: {
            unique: true,
            partialFilterExpression: { 'transactions.correlationId': { $exists: true } },
            sparse: true,
            background: true
        },
        description: 'Garante idempotência por correlationId'
    },
    
    // ============================================
    // Session - Garantir unicidade de pacote
    // ============================================
    {
        collection: 'sessions',
        name: 'unique_package_session_per_datetime',
        keys: { package: 1, date: 1, time: 1 },
        options: {
            partialFilterExpression: { package: { $exists: true } },
            background: true
        },
        description: 'Prevenir dupla sessão no mesmo pacote/datetime'
    },
    
    // ============================================
    // Appointment - Garantir unicidade de appointment
    // ============================================
    {
        collection: 'appointments',
        name: 'unique_correlation_id',
        keys: { correlationId: 1 },
        options: {
            unique: true,
            partialFilterExpression: { correlationId: { $exists: true } },
            sparse: true,
            background: true
        },
        description: 'Garante idempotência de criação de appointments'
    }
];

async function addIndexes() {
    console.log('========================================');
    console.log('🛡️  ADICIONANDO UNIQUE INDEXES');
    console.log(`📋 MODO: ${DRY_RUN ? 'DRY RUN (visualização)' : 'EXECUÇÃO REAL'}`);
    console.log('========================================\n');

    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;
    console.log('✅ Conectado ao MongoDB\n');

    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const idx of INDEXES_TO_ADD) {
        try {
            const collection = db.collection(idx.collection);
            
            // Verificar se já existe
            const existing = await collection.indexExists(idx.name);
            
            if (existing) {
                console.log(`⏭️  ${idx.name} - já existe`);
                skipped++;
                continue;
            }

            console.log(`📋 ${idx.name}`);
            console.log(`   ${idx.description}`);
            console.log(`   Collection: ${idx.collection}`);
            console.log(`   Keys: ${JSON.stringify(idx.keys)}`);
            console.log(`   Options: ${JSON.stringify(idx.options)}`);

            if (!DRY_RUN) {
                await collection.createIndex(idx.keys, { ...idx.options, name: idx.name });
                console.log('   ✅ Criado com sucesso');
            } else {
                console.log('   ⏸️  (DRY RUN - não criado)');
            }
            created++;
            console.log('');
        } catch (err) {
            console.log(`   ❌ Erro: ${err.message}`);
            errors++;
        }
    }

    // ============================================
    // Verificar indexes existentes
    // ============================================
    console.log('\n========================================');
    console.log('📊 INDEXES ATUAIS (relevantes)');
    console.log('========================================');

    const collections = ['patientbalances', 'sessions', 'appointments', 'packages'];
    
    for (const colName of collections) {
        const collection = db.collection(colName);
        const indexes = await collection.indexes();
        
        console.log(`\n📁 ${colName}:`);
        indexes.filter(i => !i.name.startsWith('_id')).forEach(i => {
            console.log(`   ${i.name}: ${JSON.stringify(i.key)} ${i.unique ? '[UNIQUE]' : ''}`);
        });
    }

    // ============================================
    // RELATÓRIO FINAL
    // ============================================
    console.log('\n========================================');
    console.log('📊 RESUMO');
    console.log('========================================');
    console.log(`✅ Criados: ${created}`);
    console.log(`⏭️  Pulados: ${skipped}`);
    console.log(`❌ Erros: ${errors}`);

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN - Nenhum index foi criado!');
        console.log('   Para executar de verdade:');
        console.log('   DRY_RUN=false node add-unique-indexes.js');
    }

    await mongoose.disconnect();
    console.log('\n👋 Done!');
    process.exit(0);
}

addIndexes().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
