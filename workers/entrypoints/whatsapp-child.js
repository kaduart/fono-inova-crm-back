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
const AUTH_BASE = '/var/data/wwebjs_auth';
const CRASH_LOG = path.join(AUTH_BASE, '.crash-log.json');
const SESSION_DIR = path.join(AUTH_BASE, '.wwebjs_auth', 'session');
const BOOTING_FLAG = path.join(AUTH_BASE, '.booting');

if (!MONGO_URI) {
    console.error('[CHILD] ❌ MONGODB_URI não configurada');
    process.exit(1);
}

// ─── Se o bootstrap anterior foi interrompido (Render reiniciou durante init),
//     a sessão fica corrompida. Limpa imediatamente. ──────────────────────────
function checkInterruptedBoot() {
    try {
        if (fs.existsSync(BOOTING_FLAG)) {
            console.log('[CHILD] 🚨 Bootstrap anterior foi interrompido (.booting encontrado). Removendo flag e tentando reutilizar sessão existente...');
            try {
                fs.rmSync(BOOTING_FLAG, { force: true });
                console.log('[CHILD] 🧹 .booting removido. Sessão será reutilizada se válida.');
            } catch (e) {
                console.error('[CHILD] Erro ao remover .booting:', e.message);
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

    // Limpa cache stale do WhatsApp Web em todos os paths possíveis
    const cachePaths = [
        path.join(process.cwd(), '.wwebjs_cache'),
        path.join('/opt/render/project/src/back', '.wwebjs_cache'),
    ];
    for (const cp of cachePaths) {
        try {
            if (fs.existsSync(cp)) {
                fs.rmSync(cp, { recursive: true, force: true });
                console.log(`[CHILD] 🧹 Cache removido: ${cp}`);
            }
        } catch (e) {
            // ignora
        }
    }

    // ─── LIMPEZA TEMPORÁRIA DE SESSÃO CORROMPIDA ─────────────────────────────
    // TODO: remover este bloco após reconexão bem-sucedida
    try {
        const sessionDir = path.join(AUTH_BASE, '.wwebjs_auth');
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log('[CHILD] 🧨 SESSÃO LOCAL REMOVIDA — boot limpo forçado.');
        }
    } catch (e) {
        console.warn('[CHILD] Erro ao limpar sessão:', e.message);
    }

    // ─── Teste de persistência do disco (Render disk) ────────────────────────
    const pingFile = path.join(AUTH_BASE, '.render-persistence-test.txt');
    try {
        if (fs.existsSync(pingFile)) {
            const pingTime = fs.readFileSync(pingFile, 'utf-8');
            console.log(`[CHILD] ✅ Persistent disk OK — último ping: ${new Date(Number(pingTime)).toISOString()}`);
        } else {
            fs.writeFileSync(pingFile, Date.now().toString());
            console.log('[CHILD] 🆕 Persistence test file created — próximo deploy confirmará se o disco persiste');
        }
    } catch (e) {
        console.warn('[CHILD] ⚠️ Não foi possível testar persistência do disco:', e.message);
    }

    await mongoose.connect(MONGO_URI, {
        maxPoolSize: 3,
        serverSelectionTimeoutMS: 30000
    });
    console.log('[CHILD] ✅ MongoDB conectado');

    // Avisa o pai que está pronto
    if (process.send) process.send({ type: 'ready_to_init' });

    // Se bootstrap anterior foi interrompido (Render restart), limpa sessão corrompida
    checkInterruptedBoot();

    // Cria flag de boot para detectar interrupção no próximo restart
    try {
        fs.mkdirSync(path.dirname(BOOTING_FLAG), { recursive: true });
        fs.writeFileSync(BOOTING_FLAG, Date.now().toString());
    } catch (e) {
        console.warn('[CHILD] Não foi possível criar booting flag:', e.message);
    }

    // Handler para mensagens do parent (reconnect request via HTTP)
    process.on('message', async (msg) => {
        if (!msg) return;
        if (msg.type === 'reconnect_request') {
            console.log('[CHILD] 🔄 Reconnect request recebido do parent');
            try {
                const { reconnect } = await import('../../services/whatsappWebJsService.js');
                await reconnect();
            } catch (e) {
                console.error('[CHILD] Erro ao reconectar:', e.message);
            }
        }
    });

    // Inicializa WhatsApp
    await initWhatsAppClient();
    console.log('[CHILD] 🟢 WhatsApp inicializado');

    // Remove booting flag quando ficar ready
    const bootingCheck = setInterval(async () => {
        try {
            const status = await getStatus();
            if (status.ready) {
                fs.rmSync(BOOTING_FLAG, { force: true });
                clearInterval(bootingCheck);
            }
        } catch {}
    }, 5000);

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

    // Log de memória a cada 30s (processo + container)
    setInterval(() => {
        const mem = process.memoryUsage();
        let sysMem = '';
        try {
            const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
            const avail = meminfo.match(/MemAvailable:\s+(\d+)/);
            const total = meminfo.match(/MemTotal:\s+(\d+)/);
            if (avail && total) {
                const usedMB = Math.round((parseInt(total[1]) - parseInt(avail[1])) / 1024);
                const totalMB = Math.round(parseInt(total[1]) / 1024);
                sysMem = ` | Container: ${usedMB}/${totalMB}MB`;
            }
        } catch {}
        console.log(`[CHILD MEMORY] RSS: ${Math.round(mem.rss/1024/1024)}MB | Heap: ${Math.round(mem.heapUsed/1024/1024)}MB${sysMem}`);
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
    // 1. Remove booting flag IMEDIATAMENTE antes de qualquer operação longa.
    //    Se gracefulShutdownWhatsApp() travar e o parent nos matar com SIGKILL,
    //    a flag já estará removida e o próximo boot reutilizará a sessão.
    try { fs.rmSync(BOOTING_FLAG, { force: true }); } catch {}
    await gracefulShutdownWhatsApp();
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(err => {
    console.error('[CHILD] Erro fatal:', err.message);
    process.exit(1);
});
