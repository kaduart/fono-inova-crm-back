#!/usr/bin/env node
/**
 * 💬 WhatsApp Worker
 * Processa: lead-orchestrator, inbound, outbound, auto-reply, context-builder, conversation-state
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../../models/index.js';
import { startWorkersByGroup, stopAllWorkers } from '../index.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

async function main() {
    try {
        console.log('🚀 Iniciando WhatsApp Worker...\n');

        console.log('🟢 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 30000
        });
        console.log('✅ MongoDB conectado\n');

        await startWorkersByGroup('whatsapp');

        console.log('\n🎉 WhatsApp Worker pronto!');

        setInterval(() => {
            console.log(`[${new Date().toISOString()}] 💓 WhatsApp Worker rodando...`);
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
