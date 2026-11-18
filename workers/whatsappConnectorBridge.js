// workers/whatsappConnectorBridge.js
//
// Ponte do crm-worker com o conector WhatsApp EXTERNO (WHATSAPP_CONNECTOR_MODE=external, 18/11/2026).
// Substitui o child process com Chrome: este módulo NÃO importa whatsapp-web.js, puppeteer nem o
// whatsappWebJsService (há teste que confere o grafo de imports). Tudo que precisa do navegador vai por HTTP.
//
// O que roda aqui (regras de negócio continuam no CRM):
//   - fila whatsapp-send          → envio idempotente pelo conector (requestId = id do job) + deliveryGuard;
//   - fila whatsapp-scan          → varredura profunda e última conversa, lendo do conector em lotes;
//   - fila whatsapp-connector-events → eventos do conector (mensagem recebida, enviada, voto);
//   - estado da conexão           → lê GET /v1/status a cada 5 s e grava em WhatsAppWebState (o front não muda);
//   - botão "Gerar novo QR"/limpar → o sinal no MongoDB vira POST /v1/session/reconnect;
//   - votos de enquete pendentes  → pergunta ao conector a cada 15 s (antes era dentro do child);
//   - reparo @lid                 → uma vez a cada conexão nova.

import { Worker } from 'bullmq';
import { bullMqConnection } from '../config/redisConnection.js';
import { getConnectorClient } from '../services/whatsappConnector/client.js';
import { CONNECTOR_EVENTS_QUEUE } from '../services/whatsappConnector/eventsReceiver.js';
import { processConnectorEvent, processPollVote } from '../services/whatsappInboundProcessor.js';
import { processWhatsappSendJob, onWhatsappSendJobFailed } from './whatsappSendJob.js';

const TAG = 'WA-BRIDGE';
const STATUS_INTERVAL_MS = 5_000;
const POLL_VOTES_INTERVAL_MS = 15_000;
const UNREACHABLE_AFTER = 3; // leituras seguidas sem resposta até mostrar "conector fora" no ERP

/**
 * Envio pelo conector com deliveryGuard: chave estável por job (retentativas do BullMQ reaproveitam a chave,
 * e o conector reaproveita o requestId) → nunca duas mensagens para o mesmo job.
 */
export function makeConnectorSender({ client, guardedSend, DeliveryOutcome }) {
  return async (job, phone, message, opts = {}) => {
    const deliveryKey = `whatsapp-send:${job.id}`;
    const kind = opts.attendanceConfirmation ? 'attendance_confirmation' : 'text';
    const delivery = await guardedSend({
      channel: 'whatsapp',
      deliveryKey,
      destination: phone,
      send: () => client.sendMessage({ requestId: deliveryKey, phone, text: message, kind, appointmentId: opts.appointmentId || null }),
      providerMessageIdOf: (r) => r?.messageId || null,
      leaseMs: 5 * 60_000, // envio (até ~100 s) + consulta do resultado incerto cabem com folga
    });
    if (delivery.outcome === DeliveryOutcome.UNCERTAIN) return { uncertain: true, reason: delivery.error?.message || 'resultado incerto no conector', deliveryKey };
    if (delivery.outcome === DeliveryOutcome.IN_PROGRESS) {
      // Outra execução do mesmo job está enviando: erro para o BullMQ tentar mais tarde (sem reenviar).
      throw new Error(`envio ${deliveryKey} em andamento em outra execução`);
    }
    return { success: true, messageId: delivery.providerMessageId || delivery.result?.messageId || null };
  };
}

/** Estado do conector → documento WhatsAppWebState (mesmos campos que o child gravava). */
export function stateFromConnector(st) {
  return {
    status: st?.status || 'unknown',
    ready: Boolean(st?.ready),
    authenticated: Boolean(st?.authenticated),
    qrCode: st?.qrCode || null,
    lastDisconnectReason: st?.lastDisconnectReason || null,
    lastAuthenticatedAt: st?.lastAuthenticatedAt ? new Date(st.lastAuthenticatedAt) : null,
    qrCount: st?.qrCount || 0,
    initAttempts: st?.initAttempts || 0,
    pid: st?.pid || null,
    uptime: st?.uptime || null,
    updatedAt: new Date(),
  };
}

export async function startConnectorBridge({ client = getConnectorClient(), onState = () => {} } = {}) {
  const { default: WhatsAppWebState } = await import('../models/WhatsAppWebState.js');
  const { guardedSend, DeliveryOutcome, ensureDeliveryIndexes } = await import('../infrastructure/delivery/deliveryGuard.js');
  await ensureDeliveryIndexes().catch((e) => console.warn(`[${TAG}] índices de entrega:`, e.message));
  console.log(`[${TAG}] 🔌 modo externo: WhatsApp pelo conector ${client.baseUrl} (sem Chrome neste processo)`);

  const workers = [];
  const timers = [];

  // ── Envio ─────────────────────────────────────────────────────────────────
  const sendWorker = new Worker('whatsapp-send', (job) => processWhatsappSendJob(job, {
    tag: TAG,
    sendMessage: makeConnectorSender({ client, guardedSend, DeliveryOutcome }),
    getChatActivity: (phone) => client.getChatActivity(phone),
  }), {
    connection: bullMqConnection,
    concurrency: 1,
    limiter: { max: 1, duration: 1000 },
  });
  sendWorker.on('failed', (job, err) => {
    console.error(`[${TAG}] ❌ envio ${job?.id} falhou:`, err.message);
    onWhatsappSendJobFailed(job, err);
  });
  workers.push(sendWorker);

  // ── Varreduras (só leitura no WhatsApp) ───────────────────────────────────
  const scanWorker = new Worker('whatsapp-scan', async (job) => {
    const { runId } = job.data || {};
    const { default: WhatsAppScanRun } = await import('../models/WhatsAppScanRun.js');
    if (!job.data?.deep && !job.data?.activity) {
      await WhatsAppScanRun.updateOne({ _id: runId }, { $set: { status: 'failed', finishedAt: new Date(), error: 'Busca rápida desativada (derrubava o WhatsApp). Use a Busca completa.' } });
      return { skipped: true };
    }
    await WhatsAppScanRun.updateOne({ _id: runId }, { $set: { status: 'running', startedAt: new Date(), error: null }, $inc: { attempts: 1 } });
    try {
      let stats;
      if (job.data.activity) {
        const { syncWaitlistChatActivity } = await import('../services/convenioWaitlistWhatsapp.js');
        stats = await syncWaitlistChatActivity({ readChatActivity: (p) => client.readChatActivity(p) });
      } else {
        const { runDeepConvenioScan } = await import('../services/whatsappDeepScan.js');
        const run = await WhatsAppScanRun.findById(runId).select('progress').lean();
        stats = await runDeepConvenioScan({
          readBatch: (p) => client.readDeepScanBatch(p),
          startIndex: run?.progress?.nextIndex || 0,
          ...(job.data.since ? { since: new Date(job.data.since) } : {}),
          onBatch: (p) => WhatsAppScanRun.updateOne({ _id: runId }, { $set: { progress: { nextIndex: p.nextIndex }, stats: p.stats } }),
        });
      }
      await WhatsAppScanRun.updateOne({ _id: runId }, { $set: { status: 'done', finishedAt: new Date(), stats } });
      return stats;
    } catch (err) {
      const last = job.attemptsMade + 1 >= (job.opts?.attempts || 1);
      await WhatsAppScanRun.updateOne({ _id: runId }, { $set: { status: last ? 'failed' : 'queued', error: err.message, ...(last ? { finishedAt: new Date() } : {}) } });
      throw err;
    }
  }, { connection: bullMqConnection, concurrency: 1, lockDuration: 10 * 60 * 1000, maxStalledCount: 30 });
  workers.push(scanWorker);

  // ── Eventos do conector ───────────────────────────────────────────────────
  const eventsWorker = new Worker(CONNECTOR_EVENTS_QUEUE, async (job) => {
    const out = await processConnectorEvent(job.data);
    // Erro de banco num passo vira retentativa do job inteiro (os passos são idempotentes).
    const failed = Object.entries(out || {}).filter(([, v]) => v && typeof v === 'object' && 'error' in v);
    if (failed.length) throw new Error(`passos com erro: ${failed.map(([k, v]) => `${k}: ${v.error}`).join('; ')}`);
    return out;
  }, { connection: bullMqConnection, concurrency: 4 });
  eventsWorker.on('failed', (job, err) => console.warn(`[${TAG}] ⚠️ evento ${job?.data?.eventId} falhou (tentativa ${job?.attemptsMade}):`, err.message));
  workers.push(eventsWorker);

  // ── Estado da conexão ─────────────────────────────────────────────────────
  let misses = 0;
  let wasReady = false;
  let lidRepairDone = false;
  const pollStatus = async () => {
    try {
      const st = await client.getStatus();
      misses = 0;
      const doc = stateFromConnector(st);
      await WhatsAppWebState.findOneAndUpdate({ instanceId: 'main' }, { $set: doc }, { upsert: true });
      onState(doc);
      if (doc.ready && !wasReady) {
        console.log(`[${TAG}] ✅ conector conectado ao WhatsApp`);
        if (!lidRepairDone) {
          lidRepairDone = true;
          const { repairLidAttributions } = await import('../services/whatsappLidRepair.js');
          repairLidAttributions({ resolveLids: (lids) => client.resolveLids(lids) }).catch((e) => console.warn(`[${TAG}] reparo @lid falhou:`, e.message));
        }
      }
      if (!doc.ready && wasReady) console.warn(`[${TAG}] 🔴 conector desconectado do WhatsApp (${doc.status})`);
      wasReady = doc.ready;
    } catch (err) {
      misses++;
      if (misses === UNREACHABLE_AFTER) {
        console.error(`[${TAG}] 🚫 conector sem resposta (${err.message}) — ERP mostra desconectado`);
        await WhatsAppWebState.findOneAndUpdate({ instanceId: 'main' }, {
          $set: { status: 'connector_unreachable', ready: false, qrCode: null, lastDisconnectReason: `conector sem resposta: ${err.message}`, updatedAt: new Date() },
        }, { upsert: true }).catch(() => {});
        onState({ status: 'connector_unreachable', ready: false });
        wasReady = false;
      }
    }
  };
  timers.push(setInterval(pollStatus, STATUS_INTERVAL_MS));
  pollStatus();

  // ── Botão "Gerar novo QR" / "Desconectar" (sinal gravado pela API no MongoDB) ─
  let lastSignal = null;
  timers.push(setInterval(async () => {
    try {
      const st = await WhatsAppWebState.findOne({ instanceId: 'main' }).select('reconnectSignal').lean();
      const sig = st?.reconnectSignal ? new Date(st.reconnectSignal).getTime() : null;
      if (sig === null) return;
      if (lastSignal === null) { lastSignal = sig; return; }
      if (sig > lastSignal) {
        lastSignal = sig;
        console.log(`[${TAG}] 🔔 pedido de reconexão do ERP → conector`);
        await client.reconnect();
      }
    } catch (e) {
      console.warn(`[${TAG}] reconexão pedida falhou:`, e.message);
    }
  }, STATUS_INTERVAL_MS));

  // ── Votos das enquetes de presença ainda sem resposta ─────────────────────
  let votesRunning = false;
  timers.push(setInterval(async () => {
    if (votesRunning || !wasReady) return;
    votesRunning = true;
    try {
      const { default: Appointment } = await import('../models/Appointment.js');
      const pending = await Appointment.find({
        'attendanceConfirmation.status': { $in: ['pending', 'no_response'] },
        'attendanceConfirmation.messageId': { $exists: true, $nin: [null, '', 'unknown'] },
        'attendanceConfirmation.sentAt': { $gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
      }).select('attendanceConfirmation.messageId').sort({ 'attendanceConfirmation.sentAt': -1 }).limit(100).lean();
      const ids = pending.map((a) => a.attendanceConfirmation?.messageId).filter(Boolean);
      if (!ids.length) return;
      for (const r of await client.readPollVotes(ids)) {
        for (const vote of r.votes || []) await processPollVote(vote);
      }
    } catch (e) {
      console.warn(`[${TAG}] votos pendentes:`, e.message);
    } finally {
      votesRunning = false;
    }
  }, POLL_VOTES_INTERVAL_MS));

  return {
    workers,
    async stop() {
      timers.forEach(clearInterval);
      await Promise.allSettled(workers.map((w) => w.close()));
    },
  };
}

export default { startConnectorBridge, makeConnectorSender, stateFromConnector };
