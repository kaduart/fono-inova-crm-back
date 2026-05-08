#!/usr/bin/env node
/**
 * 🆘 WhatsApp ONLY — Processo principal
 * Sobe APENAS health check. WhatsApp roda em child process isolado.
 * Se o WhatsApp morrer (OOM, crash), reinicia automaticamente.
 */

import http from 'http';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || process.env.WORKER_PORT || 10000;

console.log('🆘 MODO EMERGÊNCIA: WhatsApp ONLY (com child process isolado)\n');
console.log(`📂 CWD: ${process.cwd()}`);
console.log(`📂 Sessão path: ${path.resolve(process.cwd(), '.wwebjs_auth')}\n`);

// ─── Estado do WhatsApp (atualizado via IPC do child) ──────────────────────
let childStatus = 'initializing';
let childReady = false;
let childPid = null;
let childRestartCount = 0;
const MAX_RESTARTS = 20;

// ─── Health check SOBE IMEDIATAMENTE ───────────────────────────────────────
const server = http.createServer((req, res) => {
    if (req.url === '/api/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            mode: 'whatsapp-only',
            whatsapp: childStatus,
            whatsappReady: childReady,
            childPid: childPid,
            childRestarts: childRestartCount,
            timestamp: new Date().toISOString()
        }));
        return;
    }
    res.writeHead(404); res.end();
});

server.listen(PORT, () => {
    console.log(`📊 Health Check: http://localhost:${PORT}/api/health`);
    console.log('🟢 Processo principal estável — WhatsApp vai subir em child process\n');
});

// ─── Gerenciador do child process ──────────────────────────────────────────
function spawnWhatsAppChild() {
    if (childRestartCount >= MAX_RESTARTS) {
        console.log('[PARENT] 🚫 Limite de reinicializações do child atingido.');
        childStatus = 'max_restarts';
        return;
    }

    childRestartCount++;
    console.log(`[PARENT] 👶 Spawnando WhatsApp child (tentativa ${childRestartCount}/${MAX_RESTARTS})...`);

    const childPath = path.join(__dirname, 'whatsapp-child.js');
    const child = fork(childPath, [], {
        silent: false,
        env: process.env,
        execArgv: ['--max-old-space-size=192']
    });

    childPid = child.pid;

    child.on('message', (msg) => {
        if (msg && msg.type === 'ready_to_init') {
            childStatus = 'initializing';
        }
    });

    child.on('exit', (code, signal) => {
        childPid = null;
        childReady = false;
        const reason = signal ? `sinal ${signal}` : `código ${code}`;
        console.log(`[PARENT] 💀 Child morreu (${reason}). Reiniciando em 10s...`);
        childStatus = 'restarting';
        setTimeout(spawnWhatsAppChild, 10_000);
    });

    child.on('error', (err) => {
        console.error('[PARENT] ❌ Erro no child:', err.message);
    });

    // Monitora status pelo MongoDB (fallback)
    monitorStatusFromMongo();
}

async function monitorStatusFromMongo() {
    try {
        const { default: mongoose } = await import('mongoose');
        const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
        if (!MONGO_URI) return;

        await mongoose.connect(MONGO_URI, { maxPoolSize: 2 });
        const WhatsAppWebState = mongoose.model('WhatsAppWebState');

        setInterval(async () => {
            try {
                const state = await WhatsAppWebState.findOne({ instanceId: 'main' }).lean();
                if (state) {
                    childStatus = state.status;
                    childReady = state.ready;
                }
            } catch {}
        }, 5000);
    } catch (e) {
        console.error('[PARENT] Mongo monitor erro:', e.message);
    }
}

// ─── Sinais ────────────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM no processo principal. Saindo.');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT no processo principal. Saindo.');
    process.exit(0);
});

// ─── Inicia ────────────────────────────────────────────────────────────────
spawnWhatsAppChild();
