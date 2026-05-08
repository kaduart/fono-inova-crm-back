#!/usr/bin/env node
/**
 * 👶 WhatsApp Child Process
 * Roda APENAS o WhatsApp Web.js. Isolado do processo principal.
 * Se morrer (OOM, crash), o processo pai reinicia automaticamente.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../../models/index.js';
import { initWhatsAppClient, getStatus, gracefulShutdownWhatsApp, sendMessage } from '../../services/whatsappWebJsService.js';
import fs from 'fs';
import path from 'path';
import { Worker } from 'bullmq';
import { bullMqConnection } from '../../config/redisConnection.js';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const CRASH_LOG = '/var/data/wwebjs_auth/.crash-log.json';
const SESSION_DIR = '/var/data/wwebjs_auth/session';
const BOOTING_FLAG = '/var/data/wwebjs_auth/.booting';

if (!MONGO_URI) {
    console.error('[CHILD] ❌ MONGODB_URI não configurada');
    process.exit(1);
}

// ─── Se o bootstrap anterior foi interrompido (Render reiniciou durante init),
//     a sessão fica corrompida. Limpa imediatamente. ──────────────────────────
function checkInterruptedBoot() {
    try {
        if (fs.existsSync(BOOTING_FLAG)) {
            console.log('[CHILD] 🚨 Bootstrap anterior foi interrompido (.booting encontrado). Limpando sessão corrompida...');
            try {
                if (fs.existsSync(SESSION_DIR)) {
                    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                    console.log('[CHILD] 🧹 Sessão corrompida removida. Novo QR será gerado.');
                }
            } catch (e) {
                console.error('[CHILD] Erro ao limpar sessão:', e.message);
            } finally {
                fs.rmSync(BOOTING_FLAG, { force: true });
            }
            return;
        }

        // Fallback: crash log — só registra, NUNCA limpa sessão automaticamente.
        // Limpar sessão por restart do Render cria loop infinito de QR.
        try {
            const now = Date.now();
            let log = [];
            if (fs.existsSync(CRASH_LOG)) {
                log = JSON.parse(fs.readFileSync(CRASH_LOG, 'utf-8'));
            }
            log.push(now);
            log = log.filter(t => now - t < 180_000);
            fs.writeFileSync(CRASH_LOG, JSON.stringify(log));
        } catch {}
    } catch (e) {
        // ignora
    }
}

process.on('uncaughtException', (err) => {
    console.error('[CHILD FATAL]', err.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const msg = typeof reason === 'string' ? reason : (reason?.message || String(reason));
    console.error('[CHILD UNHANDLED]', msg);

    // Browser morreu — NÃO tenta recuperar. Sai limpo para o parent respawnar.
    if (msg && (
        msg.includes('Execution context was destroyed') ||
        msg.includes('Protocol error') ||
        msg.includes('Target closed') ||
        msg.includes('Session closed') ||
        msg.includes('detached') ||
        msg.includes('Runtime.callFunctionOn timed out') ||
        msg.includes('Protocol timeout')
    )) {
        console.error('[CHILD] 💥 Browser fatal — saindo para o parent respawnar limpo.');
        process.exit(1);
    }
});

async function main() {
    console.log('[CHILD] 🚀 Iniciando WhatsApp child process...');

    await mongoose.connect(MONGO_URI, {
        maxPoolSize: 3,
        serverSelectionTimeoutMS: 30000
    });
    console.log('[CHILD] ✅ MongoDB conectado');

    // Avisa o pai que está pronto
    if (process.send) process.send({ type: 'ready_to_init' });

    // Se bootstrap anterior foi interrompido (Render restart), limpa sessão corrompida
    checkInterruptedBoot();

    // Inicializa WhatsApp
    await initWhatsAppClient();
    console.log('[CHILD] 🟢 WhatsApp inicializado');

    // Heartbeat: envia status para o pai a cada 5s
    setInterval(async () => {
        try {
            const status = await getStatus();
            if (process.send) {
                process.send({
                    type: 'whatsapp_status',
                    pid: process.pid,
                    uptime: process.uptime(),
                    status: status.status,
                    ready: status.ready,
                });
            }
        } catch {}
    }, 5000);

    // Log de memória a cada 30s
    setInterval(() => {
        const mem = process.memoryUsage();
        console.log(`[CHILD MEMORY] RSS: ${Math.round(mem.rss/1024/1024)}MB | Heap: ${Math.round(mem.heapUsed/1024/1024)}MB`);
    }, 30000);

    // 💬 Consome fila de envio de mensagens (API web enfileira, worker envia)
    const whatsappWorker = new Worker('whatsapp-send', async (job) => {
        const { phone, message } = job.data;
        console.log(`[CHILD WORKER] 📤 Job ${job.id} — enviando para ${phone}`);
        console.log(`[CHILD WORKER] 📤 Conteúdo: ${message.substring(0, 80)}...`);
        const result = await sendMessage(phone, message);
        console.log(`[CHILD WORKER] ✅ Job ${job.id} — enviado com sucesso`);
        return result;
    }, {
        connection: bullMqConnection,
        limiter: { max: 5, duration: 1000 },
    });

    whatsappWorker.on('completed', (job) => {
        console.log(`[CHILD WORKER] ✅ Job ${job.id} completado`);
    });

    whatsappWorker.on('failed', (job, err) => {
        console.error(`[CHILD WORKER] ❌ Job ${job?.id} falhou:`, err.message);
    });
}

// Graceful shutdown: destrói o client antes de sair para não deixar lock no profile
async function shutdown(signal) {
    console.log(`[CHILD] ${signal} recebido — destruindo client...`);
    await gracefulShutdownWhatsApp();
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(err => {
    console.error('[CHILD] Erro fatal:', err.message);
    process.exit(1);
});
