#!/usr/bin/env node
/**
 * Suspende/retoma o crm-worker no Render via API.
 * Usado pelos Cron Jobs "crm-worker-suspend" (19:10 BRT seg-sex) e
 * "crm-worker-resume" (07:50 BRT seg-sex) para economizar horas de
 * computação fora do horário de atendimento da clínica.
 *
 * Uso: node render-worker-toggle.js suspend|resume
 * Env obrigatórias (configurar como secret no Cron Job, nunca commitar):
 *   RENDER_API_KEY
 *   RENDER_WORKER_SERVICE_ID
 */

const action = process.argv[2];

if (!['suspend', 'resume'].includes(action)) {
  console.error('Uso: node render-worker-toggle.js suspend|resume');
  process.exit(1);
}

const apiKey = process.env.RENDER_API_KEY;
const serviceId = process.env.RENDER_WORKER_SERVICE_ID;

if (!apiKey || !serviceId) {
  console.error('❌ RENDER_API_KEY e/ou RENDER_WORKER_SERVICE_ID não configuradas.');
  process.exit(1);
}

const res = await fetch(`https://api.render.com/v1/services/${serviceId}/${action}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  },
});

if (res.status === 202) {
  console.log(`✅ ${action} disparado com sucesso para o serviço ${serviceId}.`);
  process.exit(0);
}

const body = await res.text().catch(() => '');
console.error(`❌ Falha ao ${action} serviço (status ${res.status}): ${body}`);
process.exit(1);
