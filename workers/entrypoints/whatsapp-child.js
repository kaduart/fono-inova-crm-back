#!/usr/bin/env node
/**
 * 👶 WhatsApp Child Process
 * Roda APENAS o WhatsApp Web.js. Isolado do processo principal.
 * Se morrer (OOM, crash), o processo pai reinicia automaticamente.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../../models/index.js';
import { initWhatsAppClient, getStatus, gracefulShutdownWhatsApp, sendMessage, checkExternalReconnectSignal, scanConvenioInterest, scanConvenioInterestDeep, readChatActivity, getChatActivity, getPageMemory } from '../../services/whatsappWebJsService.js';
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
// Memória do container (ver containerBreakdown / checkMemoryRestart no fim do arquivo)
let lastCgroupMB = null;
const MEMORY_RESTART_MB = Number(process.env.CHILD_MEMORY_RESTART_MB || 1750);
let memoryHighReads = 0;
let memoryRestarting = false;
const bullWorkers = [];

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

    // Heartbeat ANTES do init: se client.initialize() travar, o botão "Gerar novo QR"
    // (sinal no MongoDB) ainda é ouvido. Antes ficava depois do await e nunca rodava.
    // Heartbeat: envia status para o pai a cada 5s + detecta sinal externo de reconexão
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
            // Detecta se o backend solicitou reconexão via MongoDB (clearSession)
            await checkExternalReconnectSignal();
        } catch {}
    }, 5000);

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

    // Log de memória a cada 30s (processo + container)
    setInterval(async () => {
        const mem = process.memoryUsage();
        const pageMem = await getPageMemory();
        const pageInfo = pageMem ? ` | aba JS ${pageMem.jsHeapUsedMB}/${pageMem.jsHeapTotalMB}MB` : '';
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
        console.log(`[CHILD MEMORY] RSS: ${Math.round(mem.rss/1024/1024)}MB | Heap: ${Math.round(mem.heapUsed/1024/1024)}MB${sysMem}${containerBreakdown()}${pageInfo}`);
        checkMemoryRestart().catch(() => {});
    }, 30000);

    // 💬 Consome fila de envio de mensagens (API web enfileira, worker envia)
    // Envio pelo guarda de entregas (deliverWhatsAppWebJob, chave wweb:send:<job.id>): a retentativa não reenvia
    // o que já saiu e o resultado incerto não reenvia sozinho. A mesma chave vale no modo externo (ponte).
    const { processWhatsappSendJob, onWhatsappSendJobFailed } = await import('../whatsappSendJob.js');
    const { deliverWhatsAppWebJob } = await import('./whatsappWebDelivery.js');
    const whatsappWorker = new Worker('whatsapp-send', (job) => processWhatsappSendJob(job, {
        tag: 'CHILD WORKER',
        sendMessage: async (_job, phone, message, opts) => {
            const { result, outcome } = await deliverWhatsAppWebJob({ jobId: _job.id, phone, send: () => sendMessage(phone, message, opts) });
            return result || { skipped: true, delivery: outcome };
        },
        getChatActivity,
    }), {
        connection: bullMqConnection,
        concurrency: 1,         // WhatsApp Web + Puppeteer não toleram paralelismo
        limiter: { max: 1, duration: 1000 }, // 1 msg/s no máximo para não sobrecarregar o Chromium
    });

    // 🔎 Varredura SÓ LEITURA do histórico (lista de interesse em convênio). Uma por vez.
    const scanWorker = new Worker('whatsapp-scan', async (job) => {
        const { runId, convenio } = job.data || {};
        const WhatsAppScanRun = (await import('../../models/WhatsAppScanRun.js')).default;
        // 12/11/2026: a busca rápida (searchMessages) derrubou o worker por memória várias vezes seguidas
        // (Unimed). Desativada: a Busca completa incremental faz o mesmo sem esse pico. Job antigo na fila
        // é encerrado aqui sem rodar, para não entrar em loop de reinício.
        if (!job.data?.deep && !job.data?.activity && !job.data?.adsActivity) {
            await WhatsAppScanRun.updateOne({ _id: runId }, { $set: { status: 'failed', finishedAt: new Date(), error: 'Busca rápida desativada (derrubava o WhatsApp). Use a Busca completa.' } });
            console.warn(`[CHILD SCAN] ⏭️ Job ${job.id} — busca rápida desativada, encerrado sem rodar`);
            return { skipped: true };
        }
        console.log(`[CHILD SCAN] 🔎 Job ${job.id} — varrendo "${convenio}" (tentativa ${job.attemptsMade + 1})`);
        await WhatsAppScanRun.updateOne({ _id: runId }, { $set: { status: 'running', startedAt: new Date(), error: null }, $inc: { attempts: 1 } });
        try {
            let stats;
            if (job.data?.adsActivity) {
                const { runAdsChatActivity } = await import('../../services/adsChatActivity.js');
                stats = await runAdsChatActivity({ runId, readChatActivity });
            } else if (job.data?.activity) {
                const { syncWaitlistChatActivity } = await import('../../services/convenioWaitlistWhatsapp.js');
                stats = await syncWaitlistChatActivity({ readChatActivity });
            } else if (job.data?.deep) {
                // Profunda: retoma de onde parou (restart do worker às 19h10 ou deploy no meio).
                const run = await WhatsAppScanRun.findById(runId).select('progress').lean();
                stats = await scanConvenioInterestDeep({
                    startIndex: run?.progress?.nextIndex || 0,
                    ...(job.data.since ? { since: new Date(job.data.since) } : {}),
                    onBatch: (p) => WhatsAppScanRun.updateOne({ _id: runId }, { $set: { progress: { nextIndex: p.nextIndex }, stats: p.stats } }),
                });
            } else {
                stats = await scanConvenioInterest({ convenio });
            }
            await WhatsAppScanRun.updateOne({ _id: runId }, { $set: { status: 'done', finishedAt: new Date(), stats } });
            return stats;
        } catch (err) {
            const last = job.attemptsMade + 1 >= (job.opts?.attempts || 1);
            await WhatsAppScanRun.updateOne({ _id: runId }, { $set: { status: last ? 'failed' : 'queued', error: err.message, ...(last ? { finishedAt: new Date() } : {}) } });
            throw err;
        }
    }, {
        connection: bullMqConnection,
        concurrency: 1,
        lockDuration: 10 * 60 * 1000, // varredura longa não pode ser dada como travada
        maxStalledCount: 30, // worker desliga 19h10/deploy: a profunda volta para a fila e retoma do progresso salvo
    });
    bullWorkers.push(scanWorker);
    scanWorker.on('failed', (job, err) => {
        console.error(`[CHILD SCAN] ❌ Job ${job?.id} falhou:`, err.message);
    });

    bullWorkers.push(whatsappWorker);
    whatsappWorker.on('completed', (job) => {
        console.log(`[CHILD WORKER] ✅ Job ${job.id} completado`);
    });

    whatsappWorker.on('failed', (job, err) => {
        console.error(`[CHILD WORKER] ❌ Job ${job?.id} falhou:`, err.message);
        onWhatsappSendJobFailed(job, err);
    });
}

// 12/11/2026: o crm-worker morre por OOM (limite 2 GB do Render) com o child em ~150 MB.
// /proc/meminfo mostra a máquina inteira (126 GB), não o container. Aqui lemos o cgroup
// (uso real x limite) e somamos o RSS por processo: parent (workers core), child e Chrome.
function containerBreakdown() {
    try {
        let cg = '';
        lastCgroupMB = null;
        try {
            const cur = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf-8'), 10);
            const max = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf-8').trim();
            lastCgroupMB = Math.round(cur / 1048576);
            cg = ` | cgroup ${lastCgroupMB}/${max === 'max' ? 'max' : Math.round(parseInt(max, 10) / 1048576)}MB`;
        } catch {
            try { // cgroup v1
                const cur = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf-8'), 10);
                lastCgroupMB = Math.round(cur / 1048576);
                cg = ` | cgroup ${lastCgroupMB}MB`;
            } catch {}
        }
        const groups = { parent: 0, child: 0, chrome: 0, outros: 0 };
        const chromeByType = {};
        let chromeProcs = 0;
        for (const pid of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(pid)) continue;
            try {
                const rss = fs.readFileSync(`/proc/${pid}/status`, 'utf-8').match(/VmRSS:\s+(\d+)/);
                if (!rss) continue;
                const kb = parseInt(rss[1], 10);
                const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
                if (/chrome/i.test(cmd)) {
                    groups.chrome += kb; chromeProcs += 1;
                    const type = (cmd.match(/--type=([a-z-]+)/) || [, 'browser'])[1];
                    chromeByType[type] = (chromeByType[type] || 0) + kb;
                }
                else if (Number(pid) === process.pid) groups.child += kb;
                else if (Number(pid) === process.ppid) groups.parent += kb;
                else groups.outros += kb;
            } catch {}
        }
        const mb = (kb) => Math.round(kb / 1024);
        const types = Object.entries(chromeByType).sort((a, b) => b[1] - a[1]).map(([t, kb]) => `${t} ${mb(kb)}`).join(', ');
        return `${cg} | parent ${mb(groups.parent)}MB · child ${mb(groups.child)}MB · chrome ${mb(groups.chrome)}MB (${chromeProcs} proc: ${types}) · outros ${mb(groups.outros)}MB`;
    } catch {
        return '';
    }
}

// 12/11/2026: medido no Render, o Chrome (WhatsApp Web) ocupa 1,1–1,3 GB e o container vive em
// 1,3–1,6 GB de 2 GB. Um pico mata tudo por OOM (SIGKILL), no meio de um envio, sem shutdown limpo.
// Reinício controlado: acima do limite em 2 leituras seguidas (1 min), espera o job atual da
// fila terminar, fecha o Chrome direito e sai. O parent sobe outro child em 10 s, com a sessão salva.
async function checkMemoryRestart() {
    if (memoryRestarting || !MEMORY_RESTART_MB || lastCgroupMB == null) return;
    memoryHighReads = lastCgroupMB >= MEMORY_RESTART_MB ? memoryHighReads + 1 : 0;
    if (memoryHighReads < 2) return;
    memoryRestarting = true;
    console.warn(`[CHILD MEMORY] ♻️ Container em ${lastCgroupMB}MB (limite de reinício ${MEMORY_RESTART_MB}MB) — reinício controlado do WhatsApp`);
    try {
        await Promise.race([
            Promise.allSettled(bullWorkers.map((w) => w.close())),
            new Promise((r) => setTimeout(r, 90_000)),
        ]);
    } catch {}
    await shutdown('MEMORY');
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
