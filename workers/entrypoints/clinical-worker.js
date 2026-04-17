#!/usr/bin/env node
/**
 * 🏥 Clinical Worker
 * Processa: patients, projections, sessions, clinical-orchestrator
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../../models/index.js';
import { startWorkersByGroup, stopAllWorkers } from '../index.js';
import { bootstrapEventContracts } from '../../infrastructure/events/bootstrapContracts.js';

dotenv.config();
bootstrapEventContracts();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

async function main() {
    try {
        console.log('🚀 Iniciando Clinical Worker...\n');

        console.log('🟢 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 30000
        });
        console.log('✅ MongoDB conectado\n');

        await startWorkersByGroup('clinical');

        console.log('\n🎉 Clinical Worker pronto!');

        setInterval(() => {
            console.log(`[${new Date().toISOString()}] 💓 Clinical Worker rodando...`);
        }, 60000);

    } catch (error) {
        console.error('❌ Erro fatal:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

process.on('SIGTERM', async () => {
    console.log('\n🛑 SIGTERM recebido...');
    await stopAllWorkers();
    await mongoose.disconnect();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT recebido...');
    await stopAllWorkers();
    await mongoose.disconnect();
    process.exit(0);
});

main();
