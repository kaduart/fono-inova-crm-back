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
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../models/index.js';
import { startWorkersByGroup, stopAllWorkers } from './index.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || process.env.WORKER_PORT || 10000;

console.log('🆘 WhatsApp ONLY + Workers Core — Processo principal\n');
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

// Estado exposto via HTTP para o frontend
let stateSnapshot = {
    status: 'initializing',
    ready: false,
    authenticated: false,
    qrCode: null,
    lastDisconnectReason: null,
    lastAuthenticatedAt: null,
    qrCount: 0,
    initAttempts: 0,
    pid: null,
    uptime: null,
    updatedAt: null,
};

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ─── HTTP server com rotas do WhatsApp Web ─────────────────────────────────
const server = http.createServer((req, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204); res.end(); return;
    }

    if (req.url === '/api/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            mode: 'whatsapp-core',
            childReady,
            childStatus,
            coreWorkers: activeWorkers.length,
        }));
        return;
    }

    if (req.url === '/api/whatsapp-web/status') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
        });
        res.end(JSON.stringify({ ...stateSnapshot, error: null }));
        return;
    }

    if (req.url === '/api/whatsapp-web/reconnect' && req.method === 'POST') {
        if (childProcess && childProcess.send) {
            childProcess.send({ type: 'reconnect_request' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Reconexão solicitada ao child.' }));
        } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Child não está rodando.' }));
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`📊 Health Check: http://localhost:${PORT}/api/health`);
    console.log('🟢 Processo principal estável — WhatsApp vai subir em child process\n');

    // Conecta MongoDB e sobe workers core em paralelo com o WhatsApp.
    // O grupo whatsapp fica no child process (whatsapp-child.js) para não duplicar
    // o consumo da fila whatsapp-send.
    try {
        const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
        if (MONGO_URI) {
            await mongoose.connect(MONGO_URI, {
                maxPoolSize: 10,
                minPoolSize: 2,
                serverSelectionTimeoutMS: 30000,
            });
            console.log('✅ MongoDB conectado (workers core)');
        }

        await startCoreWorkers();
    } catch (err) {
        console.error('❌ Erro ao iniciar workers core:', err.message);
    }
});

// ─── Workers core (tudo exceto whatsapp, que fica no child) ──────────────────
const activeWorkers = [];

async function startCoreWorkers() {
    const coreGroups = ['scheduling', 'billing', 'clinical', 'reconciliation'];
    console.log(`[Workers Core] Iniciando grupos: ${coreGroups.join(', ')}`);
    await Promise.all(
        coreGroups.map(async (group, idx) => {
            await new Promise((r) => setTimeout(r, idx * 1000)); // pequeno stagger
            const workers = await startWorkersByGroup(group);
            activeWorkers.push(...workers);
        })
    );
    console.log(`[Workers Core] ${activeWorkers.length} workers ativos`);
}

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
            stateSnapshot.status = 'initializing';
        }
        if (msg.type === 'whatsapp_status') {
            childStatus = msg.status || childStatus;
            childReady = msg.ready ?? childReady;
            childPid = msg.pid ?? childPid;
            lastChildHeartbeat = Date.now();
            stateSnapshot.status = msg.status || stateSnapshot.status;
            stateSnapshot.ready = msg.ready ?? stateSnapshot.ready;
            stateSnapshot.pid = msg.pid ?? stateSnapshot.pid;
            stateSnapshot.uptime = msg.uptime ?? stateSnapshot.uptime;
            stateSnapshot.updatedAt = new Date().toISOString();
        }
        if (msg.type === 'whatsapp_qr') {
            console.log('[PARENT] 📡 QR code recebido do child — disponível em /api/whatsapp-web/status');
            stateSnapshot.qrCode = msg.qrCode || stateSnapshot.qrCode;
            stateSnapshot.status = 'qr';
            stateSnapshot.qrCount = (stateSnapshot.qrCount || 0) + 1;
            stateSnapshot.updatedAt = new Date().toISOString();
        }
        if (msg.type === 'whatsapp_ready') {
            console.log('[PARENT] ✅ WhatsApp READY recebido do child!');
            childReady = true;
            childStatus = 'ready';
            stateSnapshot.ready = true;
            stateSnapshot.status = 'ready';
            stateSnapshot.qrCode = null;
            stateSnapshot.authenticated = true;
            stateSnapshot.updatedAt = new Date().toISOString();
        }
        if (msg.type === 'whatsapp_authenticated') {
            console.log('[PARENT] 🔐 WhatsApp AUTHENTICATED — aguardando ready...');
            childStatus = 'authenticated';
            stateSnapshot.status = 'authenticated';
            stateSnapshot.authenticated = true;
            stateSnapshot.lastAuthenticatedAt = new Date().toISOString();
            stateSnapshot.updatedAt = new Date().toISOString();
        }
        if (msg.type === 'whatsapp_disconnected') {
            console.log(`[PARENT] 🔴 WhatsApp DISCONNECTED — ${msg.reason}`);
            childReady = false;
            childStatus = 'disconnected';
            stateSnapshot.ready = false;
            stateSnapshot.authenticated = false;
            stateSnapshot.status = 'disconnected';
            stateSnapshot.lastDisconnectReason = msg.reason || null;
            stateSnapshot.updatedAt = new Date().toISOString();
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
async function shutdown(signal) {
    console.log(`\n🛑 ${signal} no processo principal. Aguardando child e workers core...`);
    isShuttingDown = true;
    server.close();

    try {
        stopAllWorkers();
    } catch (e) {
        console.warn('[PARENT] Erro ao parar workers core:', e.message);
    }

    try {
        await mongoose.disconnect();
    } catch (e) {
        // ignore
    }

    if (childProcess) {
        childProcess.kill('SIGTERM');
        const timeout = setTimeout(() => {
            console.log('[PARENT] Child não respondeu — forçando kill.');
            childProcess.kill('SIGKILL');
            process.exit(0);
        }, 20_000);
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
