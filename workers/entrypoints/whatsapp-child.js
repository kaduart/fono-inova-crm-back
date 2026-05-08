#!/usr/bin/env node
/**
 * 👶 WhatsApp Child Process
 * Roda APENAS o WhatsApp Web.js. Isolado do processo principal.
 * Se morrer (OOM, crash), o processo pai reinicia automaticamente.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../../models/index.js';
import { initWhatsAppClient, getStatus, gracefulShutdownWhatsApp } from '../../services/whatsappWebJsService.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const CRASH_LOG = '/var/data/wwebjs_auth/.crash-log.json';
const SESSION_DIR = '/var/data/wwebjs_auth/session';

if (!MONGO_URI) {
    console.error('[CHILD] ❌ MONGODB_URI não configurada');
    process.exit(1);
}

// ─── Crash log: se morreu 3x em 2 minutos, sessão provavelmente está corrompida ──
function checkAndClearCorruptedSession() {
    try {
        const now = Date.now();
        let log = [];
        if (fs.existsSync(CRASH_LOG)) {
            log = JSON.parse(fs.readFileSync(CRASH_LOG, 'utf-8'));
        }
        // Registra esta inicialização como uma tentativa
        log.push(now);
        // Mantém só os últimos 3 minutos
        log = log.filter(t => now - t < 180_000);
        fs.writeFileSync(CRASH_LOG, JSON.stringify(log));

        // Se 3+ tentativas em 2 minutos, limpa a sessão
        const recent = log.filter(t => now - t < 120_000);
        if (recent.length >= 3) {
            console.log('[CHILD] ⚠️ 3+ tentativas em 2 min — sessão provavelmente corrompida. Limpando...');
            try {
                if (fs.existsSync(SESSION_DIR)) {
                    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                    console.log('[CHILD] 🧹 Sessão limpa. Novo QR será gerado.');
                }
                fs.writeFileSync(CRASH_LOG, JSON.stringify([]));
            } catch (e) {
                console.error('[CHILD] Erro ao limpar sessão:', e.message);
            }
        }
    } catch (e) {
        // ignora erro no crash log
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
        msg.includes('Target closed') ||
        msg.includes('detached')
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

    // Se houve muitas mortes recentes, limpa sessão corrompida antes de tentar de novo
    checkAndClearCorruptedSession();

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
