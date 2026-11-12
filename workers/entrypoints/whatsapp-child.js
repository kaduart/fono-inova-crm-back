#!/usr/bin/env node
/**
 * 👶 WhatsApp Child Process
 * Roda APENAS o WhatsApp Web.js. Isolado do processo principal.
 * Se morrer (OOM, crash), o processo pai reinicia automaticamente.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import '../../models/index.js';
import { initWhatsAppClient, getStatus, gracefulShutdownWhatsApp, sendMessage, checkExternalReconnectSignal, scanConvenioInterest, scanConvenioInterestDeep, readChatActivity, getChatActivity } from '../../services/whatsappWebJsService.js';
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
        console.log(`[CHILD MEMORY] RSS: ${Math.round(mem.rss/1024/1024)}MB | Heap: ${Math.round(mem.heapUsed/1024/1024)}MB${sysMem}${containerBreakdown()}`);
    }, 30000);

    // 💬 Consome fila de envio de mensagens (API web enfileira, worker envia)
    const whatsappWorker = new Worker('whatsapp-send', async (job) => {
        const { phone, message, appointmentId, purpose } = job.data;
        // Envio em massa da lista de convênio: confere a conversa AGORA. Se a clínica falou com a pessoa
        // nos últimos `recentDays` dias (inclusive na mão, depois da prévia), não manda nada.
        const reengageIds = job.data.reengageEvaluationIds || [];
        if (job.data.recentDays && (job.data.waitlistIds?.length || reengageIds.length)) {
            let activity = null;
            try {
                activity = await getChatActivity(phone);
            } catch (err) {
                console.warn(`[CHILD WORKER] ⚠️ Job ${job.id} — não consegui conferir a conversa (segue o envio):`, err.message);
            }
            const { isRecentClinicChat, markOfferSkipped } = await import('../../services/convenioWaitlistOffer.js');
            if (activity && isRecentClinicChat(activity, job.data.recentDays)) {
                const skip = {
                    purpose,
                    reason: `Conversa com a clínica em ${activity.clinicAt.toISOString().slice(0, 10)} — não enviado`,
                    lastClinicAt: activity.clinicAt,
                };
                if (reengageIds.length) {
                    const { markReengageSkipped } = await import('../../services/commercial/evaluationReengagement.js');
                    await markReengageSkipped(reengageIds, skip);
                } else {
                    await markOfferSkipped(job.data.waitlistIds, skip);
                }
                console.log(`[CHILD WORKER] ⏭️ Job ${job.id} — pulado: clínica conversou com ...${String(phone).slice(-4)} há menos de ${job.data.recentDays} dias`);
                return { skipped: true };
            }
        }
        console.log(`[CHILD WORKER] 📤 Job ${job.id} — enviando para ${phone}`);
        console.log(`[CHILD WORKER] 📤 Conteúdo: ${message.substring(0, 80)}...`);
        const result = await sendMessage(phone, message, {
            attendanceConfirmation: purpose === 'attendance_confirmation',
            appointmentId,
        });
        if ((purpose === 'convenio_offer' || purpose === 'convenio_announce') && job.data.waitlistIds?.length) {
            const { markOfferSent } = await import('../../services/convenioWaitlistOffer.js');
            await markOfferSent(job.data.waitlistIds, { purpose, messageId: result?.messageId || null });
        }
        if (purpose === 'evaluation_reengage' && reengageIds.length) {
            const { markReengageSent } = await import('../../services/commercial/evaluationReengagement.js');
            await markReengageSent(reengageIds, { messageId: result?.messageId || null });
        }
        if (purpose === 'attendance_confirmation' && appointmentId) {
            const { markAttendanceConfirmationSent } = await import('../../services/appointment/attendanceConfirmation.service.js');
            await markAttendanceConfirmationSent(appointmentId, { messageId: result?.messageId || null });
        }
        console.log(`[CHILD WORKER] ✅ Job ${job.id} — enviado com sucesso`);
        return result;
    }, {
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
        if (!job.data?.deep && !job.data?.activity) {
            await WhatsAppScanRun.updateOne({ _id: runId }, { $set: { status: 'failed', finishedAt: new Date(), error: 'Busca rápida desativada (derrubava o WhatsApp). Use a Busca completa.' } });
            console.warn(`[CHILD SCAN] ⏭️ Job ${job.id} — busca rápida desativada, encerrado sem rodar`);
            return { skipped: true };
        }
        console.log(`[CHILD SCAN] 🔎 Job ${job.id} — varrendo "${convenio}" (tentativa ${job.attemptsMade + 1})`);
        await WhatsAppScanRun.updateOne({ _id: runId }, { $set: { status: 'running', startedAt: new Date(), error: null }, $inc: { attempts: 1 } });
        try {
            let stats;
            if (job.data?.activity) {
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
    scanWorker.on('failed', (job, err) => {
        console.error(`[CHILD SCAN] ❌ Job ${job?.id} falhou:`, err.message);
    });

    whatsappWorker.on('completed', (job) => {
        console.log(`[CHILD WORKER] ✅ Job ${job.id} completado`);
    });

    whatsappWorker.on('failed', (job, err) => {
        console.error(`[CHILD WORKER] ❌ Job ${job?.id} falhou:`, err.message);
        const lastTry = job && job.attemptsMade >= (job.opts?.attempts || 1);
        if (lastTry && ['convenio_offer', 'convenio_announce'].includes(job.data?.purpose) && job.data.waitlistIds?.length) {
            import('../../services/convenioWaitlistOffer.js')
                .then(({ markOfferFailed }) => markOfferFailed(job.data.waitlistIds, err.message, job.data.purpose))
                .catch(() => {});
        }
        if (lastTry && job.data?.purpose === 'evaluation_reengage' && job.data.reengageEvaluationIds?.length) {
            import('../../services/commercial/evaluationReengagement.js')
                .then(({ markReengageFailed }) => markReengageFailed(job.data.reengageEvaluationIds, err.message))
                .catch(() => {});
        }
    });
}

// 12/11/2026: o crm-worker morre por OOM (limite 2 GB do Render) com o child em ~150 MB.
// /proc/meminfo mostra a máquina inteira (126 GB), não o container. Aqui lemos o cgroup
// (uso real x limite) e somamos o RSS por processo: parent (workers core), child e Chrome.
function containerBreakdown() {
    try {
        let cg = '';
        try {
            const cur = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf-8'), 10);
            const max = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf-8').trim();
            cg = ` | cgroup ${Math.round(cur / 1048576)}/${max === 'max' ? 'max' : Math.round(parseInt(max, 10) / 1048576)}MB`;
        } catch {
            try { // cgroup v1
                const cur = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf-8'), 10);
                cg = ` | cgroup ${Math.round(cur / 1048576)}MB`;
            } catch {}
        }
        const groups = { parent: 0, child: 0, chrome: 0, outros: 0 };
        let chromeProcs = 0;
        for (const pid of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(pid)) continue;
            try {
                const rss = fs.readFileSync(`/proc/${pid}/status`, 'utf-8').match(/VmRSS:\s+(\d+)/);
                if (!rss) continue;
                const kb = parseInt(rss[1], 10);
                const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
                if (/chrome/i.test(cmd)) { groups.chrome += kb; chromeProcs += 1; }
                else if (Number(pid) === process.pid) groups.child += kb;
                else if (Number(pid) === process.ppid) groups.parent += kb;
                else groups.outros += kb;
            } catch {}
        }
        const mb = (kb) => Math.round(kb / 1024);
        return `${cg} | parent ${mb(groups.parent)}MB · child ${mb(groups.child)}MB · chrome ${mb(groups.chrome)}MB (${chromeProcs} proc) · outros ${mb(groups.outros)}MB`;
    } catch {
        return '';
    }
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
