#!/usr/bin/env node
// whatsapp-connector/index.js — processo do CONECTOR WhatsApp (host separado do CRM).
//
// Mantém só a sessão do WhatsApp e o Chrome (whatsapp-web.js). Não conecta no MongoDB nem no Redis.
//   CRM → conector: HTTP assinado (envio idempotente por requestId, status, leituras, reconectar).
//   conector → CRM: eventos assinados em POST {CRM_EVENTS_URL}, com fila em disco e reentrega.
// Uso:  node whatsapp-connector/index.js     (envs em docs/WHATSAPP_CONECTOR_EXTERNO.md §6)

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();
// Antes de importar o engine: este processo é o conector (sem MongoDB, eventos pelo sink).
process.env.WA_ENGINE_ROLE = 'connector';
if (process.env.WHATSAPP_CONNECTOR_MODE === 'external') {
  // Variável do CRM copiada por engano: aqui ela impediria o Chrome. O conector é o dono do Chrome.
  console.warn('[Connector] ⚠️ WHATSAPP_CONNECTOR_MODE=external ignorada no conector');
}

const { secretsFromEnv, buildEvent } = await import('../services/whatsappConnector/contract.js');
const { createConnectorApp, listen } = await import('./app.js');
const { IdempotencyStore } = await import('./idempotencyStore.js');
const { EventOutbox } = await import('./eventOutbox.js');

const SECRET = secretsFromEnv(process.env.WA_CONNECTOR_SECRET);
const EVENTS_URL = process.env.CRM_EVENTS_URL;
const DATA_DIR = process.env.WA_CONNECTOR_DATA_DIR || '/var/data/wa-connector';
const CONNECTOR_ID = process.env.WA_CONNECTOR_ID || 'main';
const PORT = Number(process.env.PORT || process.env.WA_CONNECTOR_PORT || 8787);

if (!SECRET.length) { console.error('[Connector] ❌ WA_CONNECTOR_SECRET não configurado'); process.exit(1); }
if (!EVENTS_URL) { console.error('[Connector] ❌ CRM_EVENTS_URL não configurado'); process.exit(1); }
fs.mkdirSync(DATA_DIR, { recursive: true });

const store = new IdempotencyStore({ file: path.join(DATA_DIR, 'sends.json') });
const outbox = new EventOutbox({
  file: path.join(DATA_DIR, 'outbox.json'),
  deadLetterFile: path.join(DATA_DIR, 'outbox-dead.jsonl'),
  url: EVENTS_URL,
  secret: SECRET,
});
setInterval(() => store.prune(), 6 * 3600 * 1000).unref();

const engine = await import('../services/whatsappWebJsService.js');
engine.setEventSink((type, data) => { outbox.enqueue(buildEvent(type, data, { connectorId: CONNECTOR_ID })); });

const handler = createConnectorApp({
  engine: {
    getStatus: engine.getStatus,
    sendMessage: engine.sendMessage,
    getChatActivity: engine.getChatActivity,
    readChatActivity: engine.readChatActivity,
    readDeepScanBatch: engine.readDeepScanBatch,
    resolveLidsToPhones: engine.resolveLidsToPhones,
    readPollVotes: engine.readPollVotes,
    reconnect: engine.reconnect,
    clearSession: async () => { const r = await engine.clearSession(); await engine.reconnect(); return r; },
  },
  store,
  outbox,
  secret: SECRET,
  sendTimeoutMs: Number(process.env.WA_CONNECTOR_SEND_TIMEOUT_MS || 90_000),
  sendMinIntervalMs: Number(process.env.WA_CONNECTOR_SEND_MIN_INTERVAL_MS || 1_000),
});
const { close } = await listen(handler, { port: PORT });
console.log(`[Connector] 🟢 ouvindo na porta ${PORT} (id ${CONNECTOR_ID}, dados em ${DATA_DIR})`);
outbox.schedule(0);

// Memória do host (o Chrome mora aqui agora): log a cada 60 s.
setInterval(() => {
  const m = process.memoryUsage();
  let cg = '';
  try { cg = ` | cgroup ${Math.round(Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8')) / 1048576)}MB`; } catch { /* fora de container */ }
  console.log(`[Connector MEMORY] node RSS ${Math.round(m.rss / 1048576)}MB${cg} | outbox ${outbox.size}`);
}, 60_000).unref();

await engine.initWhatsAppClient();

async function shutdown(sig) {
  console.log(`[Connector] 🛑 ${sig}: fechando…`);
  outbox.stop();
  await close().catch(() => {});
  await engine.gracefulShutdownWhatsApp().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
