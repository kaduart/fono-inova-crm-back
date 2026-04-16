#!/usr/bin/env node
/**
 * 🚀 Worker Starter - Inicia workers de forma modular
 * 
 * Uso Local/PM2:
 *   node workers/startWorkers.js
 *   node workers/startWorkers.js scheduling
 *   pm2 start workers/startWorkers.js --name crm-worker
 * 
 * Uso Render.com:
 *   node workers/startWorkers.js
 *   # Ou use os entrypoints específicos:
 *   # node workers/entrypoints/billing-worker.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../models/index.js';
import { startAllWorkers, startWorkersByGroup, VALID_GROUPS } from './index.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const WORKER_GROUP = process.env.WORKER_GROUP || process.argv[2] || 'all';

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

async function main() {
    try {
        // 🛡️ Workers desabilitados → modo idle (evita crash loop no Render)
        if (process.env.ENABLE_WORKERS !== 'true') {
            console.log('⏸️  ENABLE_WORKERS !== true. Workers desabilitados. Modo idle ativo.');
            setInterval(() => {
                console.log(`[${new Date().toISOString()}] ⏸️ Workers desabilitados (ENABLE_WORKERS=${process.env.ENABLE_WORKERS}). Aguardando...`);
            }, 60000);
            return;
        }

        console.log(`🚀 Iniciando Worker Service (grupo: ${WORKER_GROUP})...\n`);

        // 1. Conecta ao MongoDB
        console.log('🟢 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 30000
        });
        console.log('✅ MongoDB conectado\n');

        // 2. Inicia workers conforme grupo (com tolerância a falhas parciais)
        if (WORKER_GROUP === 'all') {
            console.log('⚙️  Iniciando TODOS os workers...');
            await startAllWorkers();
        } else if (VALID_GROUPS.includes(WORKER_GROUP)) {
            console.log(`⚙️  Iniciando grupo: ${WORKER_GROUP}`);
            await startWorkersByGroup(WORKER_GROUP);
        } else {
            console.error(`❌ Grupo inválido: ${WORKER_GROUP}`);
            console.error(`✅ Grupos válidos: all, ${VALID_GROUPS.join(', ')}`);
            process.exit(1);
        }

        console.log('\n🎉 Workers iniciados com sucesso!');
        console.log('📊 Health Check: GET /api/health');
        console.log('🔍 Stuck Events: GET /api/health/stuck-events\n');

        // 3. Keep alive
        setInterval(() => {
            console.log(`[${new Date().toISOString()}] 💓 Workers rodando... (grupo: ${WORKER_GROUP})`);
        }, 60000);

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
