#!/usr/bin/env node
/**
 * 🚀 Worker Starter - Inicia todos os workers
 * 
 * Uso Local/PM2:
 *   node workers/startWorkers.js
 *   pm2 start workers/startWorkers.js --name crm-worker
 * 
 * Uso Render.com:
 *   node workers/startWorkers.js
 *   # O Render vai iniciar este arquivo automaticamente como Worker
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { startAllWorkers } from './index.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

async function main() {
    try {
        console.log('🚀 Iniciando Workers no Render...\n');

        // 1. Conecta ao MongoDB (o index.js também conecta, mas garantimos aqui)
        console.log('🟢 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 30000
        });
        console.log('✅ MongoDB conectado\n');

        // 2. Inicia TODOS os workers (incluindo completeOrchestrator)
        console.log('⚙️  Iniciando todos os workers...');
        await startAllWorkers();

        console.log('\n🎉 Todos os workers iniciados com sucesso!');
        console.log('📊 Health Check: GET /api/health');
        console.log('🔍 Stuck Events: GET /api/health/stuck-events\n');

        // 3. Keep alive - o processo não pode morrer
        setInterval(() => {
            console.log(`[${new Date().toISOString()}] 💓 Workers rodando...`);
        }, 60000); // Log a cada minuto

    } catch (error) {
        console.error('❌ Erro fatal ao iniciar workers:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('\n🛑 SIGTERM recebido, parando workers...');
    await mongoose.disconnect();
    console.log('✅ Workers parados');
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT recebido, parando workers...');
    await mongoose.disconnect();
    console.log('✅ Workers parados');
    process.exit(0);
});

main();
