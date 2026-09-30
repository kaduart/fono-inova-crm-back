// crons/workerScheduler.cron.js
/**
 * Suspende/retoma o crm-worker (WhatsApp) fora do horário comercial da clínica
 * (08h-19h seg-sex) via API do Render — economia de custo (Render cobra por
 * hora ativa). Roda dentro do crm-backend (já 24h), sem serviço adicional.
 *
 * Decisão 2026-07-30: worker de WhatsApp não precisa ficar de pé fora do
 * expediente; secretárias usam mensagem pré-estabelecida a partir das 08:00.
 *
 * Incidente 2026-09-30: o Render Billing suspendeu o worker às 03:33 BRT (além
 * da suspensão do cron). O `resume` único das 07:30 não surtiu efeito (suspensão
 * por Billing não sai via API) e, quando o Billing liberou às 09:30, ninguém
 * tentou de novo — a fila whatsapp-send ficou parada até um resume manual.
 * Por isso, durante o expediente, o resume é uma checagem IDEMPOTENTE repetida
 * (a cada 10 min): consulta o status e só retoma se estiver suspenso.
 */
import cron from 'node-cron';
import { sendAlert } from '../infrastructure/alerts/alertService.js';

const RENDER_API = 'https://api.render.com/v1/services';

function getCredentials() {
    const key = process.env.RENDER_API_KEY;
    const serviceId = process.env.RENDER_WORKER_SERVICE_ID;
    if (!key || !serviceId) return null;
    return { key, serviceId };
}

async function renderFetch(creds, path, method = 'GET') {
    return fetch(`${RENDER_API}/${creds.serviceId}${path}`, {
        method,
        headers: { Authorization: `Bearer ${creds.key}`, Accept: 'application/json' },
    });
}

async function safeAlert(payload) {
    try {
        await sendAlert(payload);
    } catch (err) {
        console.error('[WorkerScheduler] ❌ Falha ao enviar alerta:', err.message);
    }
}

async function suspendWorker() {
    const creds = getCredentials();
    if (!creds) {
        console.warn("[WorkerScheduler] RENDER_API_KEY/RENDER_WORKER_SERVICE_ID não configuradas — pulando 'suspend'");
        return;
    }
    try {
        const res = await renderFetch(creds, '/suspend', 'POST');
        if (res.status === 202) {
            console.log(`[WorkerScheduler] ✅ 'suspend' disparado com sucesso para ${creds.serviceId}`);
        } else {
            const body = await res.text().catch(() => '');
            console.error(`[WorkerScheduler] ❌ Falha ao 'suspend' (status ${res.status}): ${body}`);
        }
    } catch (err) {
        console.error("[WorkerScheduler] ❌ Erro ao 'suspend':", err.message);
    }
}

/**
 * Garante que o worker está de pé. Idempotente: se já estiver rodando, não faz nada.
 * Exportada para teste manual e para reuso.
 */
export async function ensureWorkerRunning() {
    const creds = getCredentials();
    if (!creds) {
        console.warn('[WorkerScheduler] RENDER_API_KEY/RENDER_WORKER_SERVICE_ID não configuradas — pulando ensureWorkerRunning');
        await safeAlert({
            level: 'critical',
            type: 'worker_scheduler_misconfigured',
            message: '🚨 RENDER_API_KEY/RENDER_WORKER_SERVICE_ID ausentes no crm-backend — worker WhatsApp não será religado automaticamente',
            details: {},
        });
        return { action: 'skipped', reason: 'missing_credentials' };
    }

    try {
        const statusRes = await renderFetch(creds, '');
        if (!statusRes.ok) {
            const body = await statusRes.text().catch(() => '');
            console.error(`[WorkerScheduler] ❌ Falha ao consultar status (status ${statusRes.status}): ${body}`);
            await safeAlert({
                level: 'critical',
                type: 'worker_scheduler_status_failed',
                message: `🚨 Não foi possível consultar o status do worker no Render (HTTP ${statusRes.status})`,
                details: { status: statusRes.status },
            });
            return { action: 'error', reason: `status_http_${statusRes.status}` };
        }

        const svc = await statusRes.json();
        if (svc.suspended !== 'suspended') {
            return { action: 'none', reason: 'already_running' };
        }

        const suspenders = (svc.suspenders || []).map((s) => String(s?.type ?? s?.actor ?? s).toLowerCase());
        console.warn(`[WorkerScheduler] ⚠️ Worker suspenso em horário comercial (suspenders: ${suspenders.join(',') || 'n/d'}) — tentando resume`);

        // Suspensão por cobrança não sai via API: avisa em vez de insistir em silêncio.
        if (suspenders.some((s) => s.includes('billing'))) {
            await safeAlert({
                level: 'critical',
                type: 'worker_suspended_by_billing',
                message: '🚨 crm-worker SUSPENSO pelo Render Billing — regularizar pagamento no dashboard (resume via API não funciona)',
                details: { serviceId: creds.serviceId, suspenders },
            });
            return { action: 'blocked', reason: 'billing' };
        }

        const resumeRes = await renderFetch(creds, '/resume', 'POST');
        if (resumeRes.status === 202) {
            console.log(`[WorkerScheduler] ✅ 'resume' disparado com sucesso para ${creds.serviceId}`);
            await safeAlert({
                level: 'warning',
                type: 'worker_auto_resumed',
                message: '♻️ crm-worker estava suspenso em horário comercial e foi religado automaticamente',
                details: { serviceId: creds.serviceId, suspenders },
            });
            return { action: 'resumed' };
        }

        const body = await resumeRes.text().catch(() => '');
        console.error(`[WorkerScheduler] ❌ Falha ao 'resume' (status ${resumeRes.status}): ${body}`);
        await safeAlert({
            level: 'critical',
            type: 'worker_resume_failed',
            message: `🚨 Falha ao religar o crm-worker (HTTP ${resumeRes.status})`,
            details: { status: resumeRes.status, body: body.slice(0, 300) },
        });
        return { action: 'error', reason: `resume_http_${resumeRes.status}` };
    } catch (err) {
        console.error('[WorkerScheduler] ❌ Erro em ensureWorkerRunning:', err.message);
        return { action: 'error', reason: err.message };
    }
}

export function scheduleWorkerHours() {
    const tz = { timezone: 'America/Sao_Paulo' };

    // 07:30, 07:40, 07:50 — margem antes do expediente (08h); reconexão do
    // WhatsApp pode levar até 10min no pior caso.
    const morningTask = cron.schedule('30,40,50 7 * * 1-5', () => ensureWorkerRunning(), tz);

    // 08:00–18:50 a cada 10 min — se o worker cair (Billing, suspensão manual,
    // resume perdido por restart do backend), religa em até 10 min. Idempotente.
    const businessTask = cron.schedule('*/10 8-18 * * 1-5', () => ensureWorkerRunning(), tz);

    // Suspend 19:10 BRT seg-sex — fim do expediente.
    const suspendTask = cron.schedule('10 19 * * 1-5', () => suspendWorker(), tz);

    console.log('[WorkerScheduler] Agendado: garantir worker ligado 07:30–18:50 (a cada 10min) / suspend 19:10, seg-sex (America/Sao_Paulo)');

    return {
        stop: () => {
            morningTask.stop();
            businessTask.stop();
            suspendTask.stop();
        },
    };
}
