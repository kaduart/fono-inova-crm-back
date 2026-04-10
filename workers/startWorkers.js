#!/usr/bin/env node
/**
 * 🚀 Worker Starter - Inicia todos os workers
 * 
 * Uso Local/PM2:
 *   node workers/startWorkers.js
 *   pm2 start workers/startWorkers.js --name crm-worker
 * 
 * Uso Render.com:
 *   WATCHDOG_MODE=bullmq node workers/startWorkers.js
 *   # Ou rode o watchdog separado: node infrastructure/workers/watchdogBullmq.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { startCompleteOrchestratorWorker } from './completeOrchestratorWorker.js';

// Watchdog modes
import { startWatchdog } from '../infrastructure/workers/watchdog.js';
import { startWatchdogWorker } from '../infrastructure/workers/watchdogBullmq.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const WATCHDOG_MODE = process.env.WATCHDOG_MODE || 'interval'; // 'interval' | 'bullmq' | 'none'

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

async function startAllWorkers() {
    try {
        console.log('🚀 Iniciando workers...');
        console.log(`📍 Watchdog mode: ${WATCHDOG_MODE}\n`);

        // 1. Conecta ao MongoDB
        console.log('🟢 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 30000
        });
        console.log('✅ MongoDB conectado\n');

        // 2. Inicia watchdog conforme modo
        if (WATCHDOG_MODE === 'interval') {
            console.log('🔥 Iniciando watchdog (setInterval)...');
            startWatchdog();
            console.log('✅ Watchdog iniciado\n');
        } else if (WATCHDOG_MODE === 'bullmq') {
            console.log('🔥 Iniciando watchdog (BullMQ cron)...');
            await startWatchdogWorker();
            console.log('✅ Watchdog BullMQ iniciado\n');
        } else {
            console.log('⏭️  Watchdog desabilitado\n');
        }

        // 3. Inicia worker principal
        console.log('⚙️  Iniciando Complete Orchestrator Worker...');
        const completeWorker = await startCompleteOrchestratorWorker();
        console.log('✅ Complete Orchestrator Worker iniciado\n');

        // 4. Graceful shutdown
        process.on('SIGTERM', async () => {
            console.log('\n🛑 SIGTERM recebido, parando workers...');
            await completeWorker.close();
            await mongoose.disconnect();
            console.log('✅ Workers parados');
            process.exit(0);
        });

        process.on('SIGINT', async () => {
            console.log('\n🛑 SIGINT recebido, parando workers...');
            await completeWorker.close();
            await mongoose.disconnect();
            console.log('✅ Workers parados');
            process.exit(0);
        });

        console.log('🎉 Todos os workers iniciados com sucesso!');
        console.log('📊 Health Check: GET /api/health');
        console.log('🔍 Stuck Events: GET /api/health/stuck-events\n');

    } catch (error) {
        console.error('❌ Erro ao iniciar workers:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

startAllWorkers();
