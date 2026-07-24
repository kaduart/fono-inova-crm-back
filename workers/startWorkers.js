#!/usr/bin/env node
/**
 * 🚀 Worker Starter - Inicia workers de forma modular
 *
 * Opção C: Prioriza WhatsApp no boot. Workers pesados só iniciam após ready.
 *
 * Uso:
 *   node workers/startWorkers.js          → modo all (WhatsApp primeiro, depois core)
 *   node workers/startWorkers.js whatsapp → só WhatsApp
 *   node workers/startWorkers.js billing  → só billing
 */

import http from 'http';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../models/index.js';
import { startWorkersByGroup, VALID_GROUPS } from './index.js';
import { initWhatsAppClient, gracefulShutdownWhatsApp, getStatus } from '../services/whatsappWebJsService.js';
import { startWhatsAppPipelineGuard } from '../infrastructure/observability/whatsappPipelineGuard.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const WORKER_GROUP = process.env.WORKER_GROUP || process.argv[2] || 'all';

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
}

// 🛡️ Captura erros fatais do Puppeteer/WhatsApp Web.js sem matar o processo
process.on('uncaughtException', async (err) => {
  console.error('[FATAL] uncaughtException:', err.message);
  if (err.message && err.message.includes('ProtocolError')) {
    console.error('[FATAL] ProtocolError detectado — Puppeteer congelou. Forçando graceful shutdown do WhatsApp...');
    try {
      await gracefulShutdownWhatsApp();
    } catch (e) { /* ignora */ }
    console.log('[FATAL] WhatsApp destruído. Processo continuará rodando (Render reiniciará se necessário).');
    return;
  }
  console.error('[FATAL] Erro não-recuperável. Saindo.');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] unhandledRejection em:', promise, 'razão:', reason);
});

// ─── Helpers ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForWhatsAppReady(timeoutMs = 600_000) {
    const start = Date.now();
    console.log('[BOOT] ⏳ Aguardando WhatsApp ficar ready (timeout: 10min)...');
    while (Date.now() - start < timeoutMs) {
        const s = await getStatus().catch(() => ({ status: 'unknown' }));
        if (s.status === 'ready') {
            console.log('[BOOT] ✅ WhatsApp READY detectado!');
            return true;
        }
        if (s.status === 'error' || s.status === 'disconnected') {
            console.log('[BOOT] ⚠️ WhatsApp em erro/disconnected — não vou esperar mais.');
            return false;
        }
        process.stdout.write('.');
        await sleep(5000);
    }
    console.log('\n[BOOT] ⏰ Timeout de 10min — iniciando workers core mesmo assim.');
    return false;
}

async function startHealthServer() {
    const PORT = process.env.PORT || process.env.WORKER_PORT || 10000;
    const server = http.createServer(async (req, res) => {
        if (req.url === '/api/health') {
            const waStatus = await getStatus().catch(() => ({ status: 'unknown' }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                workers: WORKER_GROUP,
                whatsapp: waStatus.status,
                timestamp: new Date().toISOString()
            }));
            return;
        }
        res.writeHead(404);
        res.end('Not found');
    });
    return new Promise((resolve) => {
        server.listen(PORT, () => {
            console.log(`📊 Health Check: GET http://localhost:${PORT}/api/health`);
            resolve(server);
        });
    });
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
    try {
        // 🛡️ Workers desabilitados → modo idle
        if (process.env.ENABLE_WORKERS !== 'true') {
            console.log('⏸️  ENABLE_WORKERS !== true. Modo idle.');
            setInterval(() => {
                console.log(`[${new Date().toISOString()}] ⏸️ idle`);
            }, 60000);
            await startHealthServer();
            return;
        }

        console.log(`🚀 Iniciando Worker Service (grupo: ${WORKER_GROUP})...\n`);

        // 1. MongoDB
        console.log('🟢 Conectando ao MongoDB...');
        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 30000
        });
        console.log('✅ MongoDB conectado\n');

        // 2. Health check IMEDIATO (Render precisa disso pra não dar SIGTERM)
        await startHealthServer();

        // 3. Modo ALL: WhatsApp primeiro, workers pesados depois
        if (WORKER_GROUP === 'all') {
            console.log('[BOOT] 🎯 Modo ALL — Prioridade: WhatsApp primeiro, core depois\n');

            // 3a. WhatsApp Web sobe AGORA (sem concorrência de CPU)
            console.log('[BOOT] 🟢 Iniciando WhatsApp Web...');
            await initWhatsAppClient();

            // 3b. Aguarda ready (ou timeout)
            const isReady = await waitForWhatsAppReady();

            // 3c. Workers de prioridade ALTA (scheduling + whatsapp workers)
            console.log('\n[BOOT] ⚡ Iniciando grupos de ALTA prioridade...');
            await startWorkersByGroup('scheduling');
            await startWorkersByGroup('whatsapp');
            startWhatsAppPipelineGuard();

            // 3d. Se WhatsApp ainda não está ready, dá mais uma chance antes de subir o pesado
            if (!isReady) {
                console.log('[BOOT] ⏳ WhatsApp ainda não ready — esperando mais 2min antes de subir billing/clinical...');
                await waitForWhatsAppReady(120_000);
            }

            // 3e. Workers de prioridade MÉDIA (billing + clinical)
            console.log('\n[BOOT] ⚡ Iniciando grupos de MÉDIA prioridade...');
            await startWorkersByGroup('billing');
            await startWorkersByGroup('clinical');

            // 3f. Workers de prioridade BAIXA (reconciliation — mais pesado)
            // Espera mais 30s para estabilizar memória
            console.log('\n[BOOT] 😴 Pausa de 30s antes de subir reconciliation (worker mais pesado)...');
            await sleep(30000);
            await startWorkersByGroup('reconciliation');

            console.log('\n🎉 Todos os workers iniciados com sucesso!');

        // 4. Modo grupo específico: comportamento antigo
        } else if (VALID_GROUPS.includes(WORKER_GROUP)) {
            console.log(`⚙️  Iniciando grupo: ${WORKER_GROUP}`);
            await startWorkersByGroup(WORKER_GROUP);

            if (WORKER_GROUP === 'whatsapp') {
                console.log('🟢 [LIFECYCLE] Inicializando WhatsApp Web...');
                await initWhatsAppClient();
                startWhatsAppPipelineGuard();
            }
            console.log('\n🎉 Workers iniciados com sucesso!');
        } else {
            console.error(`❌ Grupo inválido: ${WORKER_GROUP}`);
            console.error(`✅ Grupos válidos: all, ${VALID_GROUPS.join(', ')}`);
            process.exit(1);
        }

        // 5. Keep alive
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
    await gracefulShutdownWhatsApp();
    await mongoose.disconnect();
    console.log('✅ Workers parados');
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT recebido, parando workers...');
    await gracefulShutdownWhatsApp();
    await mongoose.disconnect();
    console.log('✅ Workers parados');
    process.exit(0);
});

main();
