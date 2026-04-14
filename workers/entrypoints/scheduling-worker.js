#!/usr/bin/env node
/**
 * 🗓️ Scheduling Worker
 * Processa: appointments, complete, cancel, pre-agendamento, updates, integration
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { startWorkersByGroup, stopAllWorkers } from '../index.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

async function main() {
    try {
        console.log('🚀 Iniciando Scheduling Worker...\n');

        console.log('🟢 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 30000
        });
        console.log('✅ MongoDB conectado\n');

        await startWorkersByGroup('scheduling');

        console.log('\n🎉 Scheduling Worker pronto!');

        setInterval(() => {
            console.log(`[${new Date().toISOString()}] 💓 Scheduling Worker rodando...`);
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
