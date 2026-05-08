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
console.log(`📂 Sessão path: /var/data/wwebjs_auth\n`);

// ─── Estado do WhatsApp (atualizado via IPC do child) ──────────────────────
let childStatus = 'initializing';
let childReady = false;
let childPid = null;
let childRestartCount = 0;
const MAX_RESTARTS = 20;
let lastRestartTime = 0;
let lastChildHeartbeat = 0;
let childProcess = null;
let isShuttingDown = false;

// ─── Health check MINIMALISTA (nunca falha, nunca consulta Mongo) ──────────
const server = http.createServer((req, res) => {
    if (req.url === '/api/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'whatsapp-only' }));
        return;
    }
    res.writeHead(404); res.end();
});

server.listen(PORT, '0.0.0.0', () => {
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

    // Backoff exponencial: se houve muitos restarts recentes, espera mais
    const now = Date.now();
    const timeSinceLastRestart = now - lastRestartTime;
    if (childRestartCount > 0 && timeSinceLastRestart < 60000 && childRestartCount % 5 === 0) {
        const waitSeconds = 60;
        console.log(`[PARENT] ⚠️ Muitas reinicializações recentes — aguardando ${waitSeconds}s antes de tentar novamente...`);
        setTimeout(spawnWhatsAppChild, waitSeconds * 1000);
        return;
    }

    lastRestartTime = now;
    childRestartCount++;
    console.log(`[PARENT] 👶 Spawnando WhatsApp child (tentativa ${childRestartCount}/${MAX_RESTARTS})...`);

    const childPath = path.join(__dirname, 'whatsapp-child.js');
    const child = fork(childPath, [], {
        silent: false,
        env: process.env,
        execArgv: ['--max-old-space-size=768']
    });

    childPid = child.pid;

    child.on('message', (msg) => {
        if (!msg) return;
        if (msg.type === 'ready_to_init') {
            childStatus = 'initializing';
        }
        if (msg.type === 'whatsapp_status') {
            childStatus = msg.status || childStatus;
            childReady = msg.ready ?? childReady;
            childPid = msg.pid ?? childPid;
            lastChildHeartbeat = Date.now();
        }
    });

    childProcess = child;

    child.on('exit', (code, signal) => {
        childProcess = null;
        const oldPid = childPid;
        childPid = null;
        childReady = false;
        const reason = signal ? `sinal ${signal}` : `código ${code}`;
        console.log(`[PARENT] 💀 Child ${oldPid} morreu (${reason}).`);
        if (!isShuttingDown) {
            console.log('[PARENT] Reiniciando em 10s...');
            childStatus = 'restarting';
            setTimeout(spawnWhatsAppChild, 10_000);
        }
    });

    child.on('error', (err) => {
        console.error('[PARENT] ❌ Erro no child:', err.message);
    });
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────
function shutdown(signal) {
    console.log(`\n🛑 ${signal} no processo principal. Aguardando child...`);
    isShuttingDown = true;
    server.close();
    if (childProcess) {
        childProcess.kill('SIGTERM');
        const timeout = setTimeout(() => {
            console.log('[PARENT] Child não respondeu — forçando kill.');
            childProcess.kill('SIGKILL');
            process.exit(0);
        }, 8000);
        childProcess.on('exit', () => {
            clearTimeout(timeout);
            console.log('[PARENT] Child encerrado. Saindo.');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Heartbeat: evita que o Render mate o container por "inatividade" ──────
setInterval(() => {
    console.log(`[PARENT] 💓 heartbeat | childReady=${childReady} | childPid=${childPid} | uptime=${Math.round(process.uptime())}s`);
}, 15_000);

// ─── Inicia ────────────────────────────────────────────────────────────────
spawnWhatsAppChild();
