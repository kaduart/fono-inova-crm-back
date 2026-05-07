#!/usr/bin/env node
/**
 * 💬 WhatsApp Worker
 * Processa: lead-orchestrator, inbound, outbound, auto-reply, context-builder, conversation-state
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../../models/index.js';
import { startWorkersByGroup, stopAllWorkers } from '../index.js';
import { bootstrapEventContracts } from '../../infrastructure/events/bootstrapContracts.js';
import { gracefulShutdownWhatsApp } from '../../services/whatsappWebJsService.js';

dotenv.config();
bootstrapEventContracts();

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

        // 🟢 WhatsApp Web é inicializado pelo startWorkers.js (WORKER_GROUP=all)
        // Este entrypoint NÃO inicializa WhatsApp para evitar duplicação
        console.log('🟢 WhatsApp Worker (entrypoint) — WhatsApp é gerenciado pelo startWorkers.js');

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
    await gracefulShutdownWhatsApp();
    await stopAllWorkers();
    await mongoose.disconnect();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT recebido...');
    await gracefulShutdownWhatsApp();
    await stopAllWorkers();
    await mongoose.disconnect();
    process.exit(0);
});

main();
