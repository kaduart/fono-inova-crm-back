#!/usr/bin/env node
// whatsapp-connector/src/index.js — processo do CONECTOR WhatsApp (projeto separado do CRM).
//
// Mantém só a sessão do WhatsApp e o Chrome (whatsapp-web.js). Não conecta no MongoDB nem no Redis e não
// importa nada do CRM.
//   CRM → conector: HTTP assinado (envio idempotente por requestId, status, leituras, reconectar).
//   conector → CRM: eventos assinados em POST {CRM_EVENTS_URL}, com fila em disco e reentrega.
//
// Uso: npm start (variáveis no README.md). WA_CONNECTOR_ENGINE=simulator sobe com WhatsApp FALSO
// (sem Chrome, sem sessão) para ensaiar o CRM em modo externo.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { secretsFromEnv, buildEvent } from './contract.js';
import { createConnectorApp, listen } from './app.js';
import { IdempotencyStore } from './idempotencyStore.js';
import { EventOutbox } from './eventOutbox.js';
import { ensurePrivateDir, acquireSessionLock } from './sessionGuard.js';
import { processTreeMemory, cgroupMemoryMB } from './procMem.js';

process.umask(0o077); // tudo que este processo grava (sessão, fila, registros) nasce só para o dono

const env = process.env;
const fail = (msg) => { console.error(`[Connector] ❌ ${msg}`); process.exit(1); };

const SECRET = secretsFromEnv(env.WA_CONNECTOR_SECRET);
const EVENTS_URL = env.CRM_EVENTS_URL;
const DATA_DIR = env.WA_CONNECTOR_DATA_DIR || '/var/data/wa-connector';
const AUTH_PATH = env.WHATSAPP_AUTH_PATH || path.join(DATA_DIR, 'wwebjs_auth');
const CONNECTOR_ID = env.WA_CONNECTOR_ID || 'main';
const PORT = Number(env.PORT || env.WA_CONNECTOR_PORT || 8787);
const ENGINE = env.WA_CONNECTOR_ENGINE || 'whatsapp-web';

if (!SECRET.length) fail('WA_CONNECTOR_SECRET não configurado');
if (SECRET.some((s) => s.length < 32)) fail('WA_CONNECTOR_SECRET: cada segredo precisa de pelo menos 32 caracteres');
if (!EVENTS_URL) fail('CRM_EVENTS_URL não configurado');
if (!/^https:\/\//.test(EVENTS_URL) && env.WA_ALLOW_HTTP_EVENTS !== 'true') fail('CRM_EVENTS_URL precisa ser https (WA_ALLOW_HTTP_EVENTS=true só para ensaio local)');
if (env.WHATSAPP_CONNECTOR_MODE === 'external') console.warn('[Connector] ⚠️ WHATSAPP_CONNECTOR_MODE é variável do CRM; ignorada aqui');

let lock = null;
try {
  ensurePrivateDir(DATA_DIR);
  if (ENGINE !== 'simulator') {
    const { fixed } = ensurePrivateDir(AUTH_PATH);
    if (fixed) console.warn(`[Connector] 🔒 permissão de ${AUTH_PATH} estava aberta; corrigida para 0700`);
    lock = acquireSessionLock({ authPath: AUTH_PATH, connectorId: CONNECTOR_ID, takeoverHost: env.WA_SESSION_TAKEOVER || null });
    if (lock.recovered) console.warn(`[Connector] 🔓 trava anterior retomada (${lock.recovered.hostname} pid ${lock.recovered.pid}, desde ${lock.recovered.startedAt})`);
  }
} catch (err) {
  fail(`sessão: ${err.message}`);
}

const store = new IdempotencyStore({ file: path.join(DATA_DIR, 'sends.json') });
const outbox = new EventOutbox({
  file: path.join(DATA_DIR, 'outbox.json'),
  deadLetterFile: path.join(DATA_DIR, 'outbox-dead.jsonl'),
  url: EVENTS_URL,
  secret: SECRET,
});
setInterval(() => store.prune(), 6 * 3600 * 1000).unref();

let engine;
if (ENGINE === 'simulator') {
  const { createFakeEngine } = await import('./simulator.js');
  engine = createFakeEngine();
  engine.start = async () => {};
  engine.stop = async () => {};
  console.warn('[Connector] 🧪 WA_CONNECTOR_ENGINE=simulator: WhatsApp FALSO, sem Chrome e sem sessão');
} else {
  const { default: wweb } = await import('whatsapp-web.js');
  const { default: qrcode } = await import('qrcode');
  const { createWhatsAppEngine } = await import('./engine.js');
  engine = createWhatsAppEngine({
    lib: { Client: wweb.Client, LocalAuth: wweb.LocalAuth, Poll: wweb.Poll },
    toQrDataUrl: (qr) => qrcode.toDataURL(qr),
    authPath: AUTH_PATH,
    executablePath: env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_PATH || null,
    jsHeapMb: env.WHATSAPP_CHROME_JS_HEAP_MB === undefined ? 1024 : Number(env.WHATSAPP_CHROME_JS_HEAP_MB),
    takeoverOnConflict: env.WA_TAKEOVER_ON_CONFLICT === 'true',
    catchUpHours: Number(env.WA_ATTRIBUTION_CATCHUP_HOURS || 72),
  });
}
engine.setSink((type, data) => { outbox.enqueue(buildEvent(type, data, { connectorId: CONNECTOR_ID })); });

const handler = createConnectorApp({
  engine,
  store,
  outbox,
  secret: SECRET,
  sendTimeoutMs: Number(env.WA_CONNECTOR_SEND_TIMEOUT_MS || 90_000),
  sendMinIntervalMs: Number(env.WA_CONNECTOR_SEND_MIN_INTERVAL_MS || 1_000),
});
const { close } = await listen(handler, { port: PORT });
console.log(`[Connector] 🟢 porta ${PORT} | id ${CONNECTOR_ID} | host ${os.hostname()} | motor ${ENGINE} | dados ${DATA_DIR}`);
outbox.schedule(0);

// Memória a cada 60 s: Node, árvore do Chrome (RSS e PSS) e cgroup. É o número que dimensiona o host.
setInterval(() => {
  const node = Math.round(process.memoryUsage().rss / 1048576);
  const chrome = engine.browserPid ? processTreeMemory(engine.browserPid) : null;
  const cg = cgroupMemoryMB();
  console.log(`[Connector MEMORY] node RSS ${node}MB | chrome ${chrome ? `${chrome.processes} proc RSS ${chrome.rssMB}MB PSS ${chrome.pssMB ?? '?'}MB` : '-'}`
    + `${cg !== null ? ` | cgroup ${cg}MB` : ''} | outbox ${outbox.size}`);
}, 60_000).unref();

await engine.start();

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Connector] 🛑 ${sig}: fechando…`);
  outbox.stop();
  await close().catch(() => {});
  await engine.stop().catch(() => {});
  lock?.release();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
