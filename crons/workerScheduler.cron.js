// crons/workerScheduler.cron.js
/**
 * Suspende/retoma o crm-worker (WhatsApp) fora do horário comercial da clínica
 * (08h-19h seg-sex) via API do Render — economia de custo (Render cobra por
 * hora ativa). Roda dentro do crm-backend (já 24h), sem serviço adicional.
 *
 * Decisão 2026-07-30: worker de WhatsApp não precisa ficar de pé fora do
 * expediente; secretárias usam mensagem pré-estabelecida a partir das 08:00.
 */
import cron from 'node-cron';

const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_WORKER_SERVICE_ID = process.env.RENDER_WORKER_SERVICE_ID;

async function toggleWorker(action) {
    if (!RENDER_API_KEY || !RENDER_WORKER_SERVICE_ID) {
        console.warn(`[WorkerScheduler] RENDER_API_KEY/RENDER_WORKER_SERVICE_ID não configuradas — pulando '${action}'`);
        return;
    }
    try {
        const res = await fetch(`https://api.render.com/v1/services/${RENDER_WORKER_SERVICE_ID}/${action}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${RENDER_API_KEY}`, Accept: 'application/json' },
        });
        if (res.status === 202) {
            console.log(`[WorkerScheduler] ✅ '${action}' disparado com sucesso para ${RENDER_WORKER_SERVICE_ID}`);
        } else {
            const body = await res.text().catch(() => '');
            console.error(`[WorkerScheduler] ❌ Falha ao '${action}' (status ${res.status}): ${body}`);
        }
    } catch (err) {
        console.error(`[WorkerScheduler] ❌ Erro ao '${action}':`, err.message);
    }
}

export function scheduleWorkerHours() {
    // Resume 07:30 BRT seg-sex — 30min de margem antes do expediente (08h),
    // reconexão do WhatsApp pode levar até 10min no pior caso.
    const resumeTask = cron.schedule('30 7 * * 1-5', () => toggleWorker('resume'), {
        timezone: 'America/Sao_Paulo',
    });

    // Suspend 19:10 BRT seg-sex — fim do expediente.
    const suspendTask = cron.schedule('10 19 * * 1-5', () => toggleWorker('suspend'), {
        timezone: 'America/Sao_Paulo',
    });

    console.log('[WorkerScheduler] Agendado: resume 07:30 / suspend 19:10, seg-sex (America/Sao_Paulo)');

    return {
        stop: () => {
            resumeTask.stop();
            suspendTask.stop();
        },
    };
}
