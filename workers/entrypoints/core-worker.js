#!/usr/bin/env node
/**
 * 🏥 Core Worker — Todos os workers exceto WhatsApp
 * Responsável: scheduling, billing, clinical, reconciliation
 * Sem Puppeteer/Chromium — leve em memória
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../../models/index.js';
import { startWorkerGroup, stopAllWorkers } from '../index.js';
import { bootstrapEventContracts } from '../../infrastructure/events/bootstrapContracts.js';

dotenv.config();
bootstrapEventContracts();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

const CORE_GROUPS = ['scheduling', 'billing', 'clinical', 'reconciliation'];

async function main() {
    try {
        console.log('🚀 Iniciando Core Worker (sem WhatsApp)...\n');

        console.log('🟢 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 30000
        });
        console.log('✅ MongoDB conectado\n');

        const workers = [];
        for (const group of CORE_GROUPS) {
            await startWorkerGroup(group, workers);
        }

        console.log('\n🎉 Core Worker pronto!');
        console.log('📦 Grupos ativos:', CORE_GROUPS.join(', '));

        setInterval(() => {
            console.log(`[${new Date().toISOString()}] 💓 Core Worker rodando...`);
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
    console.log('✅ Core Worker parado');
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT recebido...');
    await stopAllWorkers();
    await mongoose.disconnect();
    console.log('✅ Core Worker parado');
    process.exit(0);
});

main();
