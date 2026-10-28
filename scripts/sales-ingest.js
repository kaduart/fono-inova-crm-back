#!/usr/bin/env node
/**
 * 🛒 Ingestão das conversas do número de VENDAS (WhatsApp Web) → Leads
 *
 * SOMENTE LEITURA do WhatsApp: nunca envia mensagem. Cada conversa vira (ou
 * atualiza) um Lead por telefone, de forma idempotente.
 *
 * Isolamento (ver DOMAIN_INVARIANTS #27/#29 e a queda de 19/10):
 *  - processo próprio, NÃO importa whatsappWebJsService (não toca em
 *    WhatsAppWebState 'main' nem na fila whatsapp-send);
 *  - LocalAuth com clientId 'vendas' em diretório só dele (.wa-sales-auth);
 *  - lockfile impede dois clientes na mesma sessão.
 *
 * Uso:
 *   node scripts/sales-ingest.js                 # modo seco: só loga o que gravaria
 *   node scripts/sales-ingest.js --write         # grava nos Leads
 *   node scripts/sales-ingest.js --catchup-hours=168
 *   node scripts/sales-ingest.js --write --db=fono_inova_prod   # grava no banco que o CRM de produção lê
 *
 * Primeira vez: aparece um QR no terminal (e em .wa-sales-auth/qr.png).
 * No celular de VENDAS: WhatsApp → Aparelhos conectados → Conectar aparelho.
 */

import '../services/setPuppeteerCache.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import qrcode from 'qrcode';
import pkg from 'whatsapp-web.js';
import Lead from '../models/Leads.js';
import { normalizeE164BR } from '../utils/phone.js';
import { PINNED_CHROME_VERSION } from '../config/chromeVersion.js';
import { captureInboundAttribution, getAttributionByPhone } from '../services/leadAttributionService.js';
import { parseAttribution, toLeadTrackingSource } from '../utils/attributionParser.js';

const { Client, LocalAuth } = pkg;
dotenv.config();

const TAG = '[SalesIngest]';
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const CATCHUP_HOURS = Number(args.find((a) => a.startsWith('--catchup-hours='))?.split('=')[1] || 72);
const AUTH_DIR = path.resolve(process.cwd(), '.wa-sales-auth');
const LOCK_FILE = path.join(AUTH_DIR, 'sales-ingest.lock');
const LEAD_ORIGIN = 'WhatsApp Vendas';
const MAX_BACKOFF_MS = 5 * 60_000;

const log = (...a) => console.log(`${TAG}[${new Date().toISOString()}]`, ...a);
const warn = (...a) => console.warn(`${TAG}[${new Date().toISOString()}] ⚠️`, ...a);
const isRealBRPhone = (p) => /^55\d{10,11}$/.test(String(p || ''));
const tail = (p) => `…${String(p).slice(-4)}`;

// ─── Lock: um único cliente por sessão ─────────────────────────────────────
function acquireLock() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* processo morto */ }
    if (alive && pid !== process.pid) {
      console.error(`${TAG} ❌ Já existe uma ingestão de vendas rodando (pid ${pid}). Abortando.`);
      process.exit(1);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && fs.readFileSync(LOCK_FILE, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK_FILE);
  } catch { /* ignora */ }
}

function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const sub = process.platform === 'win32'
    ? `win64-${PINNED_CHROME_VERSION}/chrome-win64/chrome.exe`
    : `linux-${PINNED_CHROME_VERSION}/chrome-linux64/chrome`;
  for (const base of ['chrome', path.join('.cache', 'puppeteer', 'chrome')]) {
    const p = path.join(process.cwd(), base, sub);
    if (fs.existsSync(p)) return p;
  }
  return undefined; // default do puppeteer
}

// ─── Telefone real (contatos @lid não expõem o número em msg.from) ──────────
async function resolvePhone(client, chatId) {
  if (!chatId) return null;
  if (chatId.endsWith('@c.us')) {
    const p = normalizeE164BR(chatId.replace('@c.us', ''));
    return isRealBRPhone(p) ? p : null;
  }
  if (!chatId.endsWith('@lid')) return null;
  const candidates = [];
  try {
    const [r] = await client.getContactLidAndPhone([chatId]);
    if (r?.pn) candidates.push(String(r.pn).replace(/@.*$/, ''));
  } catch { /* lib sem o método */ }
  try {
    const p = await client.pupPage.evaluate((id) => window.Store?.Contact?.get?.(id)?.phoneNumber?.user || null, chatId);
    if (p) candidates.push(p);
  } catch { /* segue */ }
  return candidates.map(normalizeE164BR).find(isRealBRPhone) || null;
}

async function resolveName(client, chatId) {
  try {
    const c = await client.getContactById(chatId);
    return (c?.name || c?.pushname || c?.verifiedName || '').trim() || null;
  } catch {
    return null;
  }
}

// ─── Upsert idempotente do Lead ────────────────────────────────────────────
// Lead novo: nasce com origin 'WhatsApp Vendas' e operational.pipeline no default
// (novo_contato). Lead existente: só avança datas ($max) e preenche nome vazio —
// nunca mexe em pipeline, origem, status ou recovery.
const stats = { created: 0, updated: 0, skipped: 0, errors: 0 };

// Origem de campanha: o clique no anúncio (ctwaContext) / texto pré-preenchido já diz
// de onde o lead veio — não precisa perguntar "como conheceu a clínica".
// First-touch em LeadAttribution (mesma regra do [WhatsAppWeb]) e copiado para
// Lead.metaTracking só quando o lead ainda não tem origem.
async function applyAttribution({ phone, text, ctwa }) {
  if (text || ctwa) await captureInboundAttribution({ phone, text, ctwa, capturedBy: 'sales_ingest' });
  const attr = await getAttributionByPhone(phone);
  if (!attr?.source || attr.from !== 'attribution') return;
  const set = { 'metaTracking.source': toLeadTrackingSource(attr.source) };
  for (const k of ['campaign', 'gclid', 'fbclid', 'adId']) if (attr[k]) set[`metaTracking.${k}`] = attr[k];
  await Lead.updateOne(
    { 'contact.phone': phone, 'metaTracking.source': { $in: [null, ''] } },
    { $set: set }
  );
}

async function upsertLead({ phone, name, at, fromMe, text, ctwa }) {
  const dateSet = fromMe
    ? { 'operational.lastHumanContactAt': at }
    : { lastInteractionAt: at, lastContactAt: at };

  if (!WRITE) {
    const exists = await Lead.exists({ 'contact.phone': phone });
    const origin = fromMe ? null : parseAttribution(text || '', ctwa);
    log(`[seco] ${exists ? 'atualizaria' : 'CRIARIA'} lead ${tail(phone)}${name ? ` (${name})` : ''} — ${fromMe ? 'msg da recepção' : 'msg do contato'} ${at.toISOString()}${origin ? ` — origem: ${origin.source}${origin.campaign ? `/${origin.campaign}` : ''}` : ''}`);
    stats[exists ? 'updated' : 'created']++;
    return;
  }

  const res = await Lead.updateOne(
    { 'contact.phone': phone },
    {
      $setOnInsert: { name: name || null, origin: LEAD_ORIGIN },
      $max: dateSet,
    },
    { upsert: true }
  );
  if (res.upsertedCount > 0) {
    stats.created++;
    log(`✅ lead criado ${tail(phone)}${name ? ` (${name})` : ''}`);
  } else {
    stats.updated++;
    if (name) await Lead.updateOne({ 'contact.phone': phone, name: { $in: [null, ''] } }, { $set: { name } });
  }
  if (!fromMe) await applyAttribution({ phone, text, ctwa });
}

// Fila serial: evita duas gravações simultâneas do mesmo telefone (upsert duplicado)
let queue = Promise.resolve();
function enqueue(job) {
  queue = queue.then(job).catch((err) => {
    stats.errors++;
    warn('falha ao gravar lead:', err?.message);
  });
  return queue;
}

async function ingestMessage(client, msg) {
  if (!msg || msg.isStatus || msg.broadcast) return;
  const chatId = msg.fromMe ? msg.to : msg.from;
  if (!chatId || chatId.endsWith('@g.us') || chatId.endsWith('@newsletter') || chatId === 'status@broadcast') return;

  const phone = await resolvePhone(client, chatId);
  if (!phone) { stats.skipped++; return; }
  const name = msg.fromMe ? null : (msg._data?.notifyName || await resolveName(client, chatId));
  const at = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();
  const c = msg._data?.ctwaContext;
  const ctwa = c ? { sourceId: c.sourceId || null, sourceUrl: c.sourceUrl || null, ctwaClid: c.ctwaClid || null, title: c.title || null } : null;
  return enqueue(() => upsertLead({ phone, name, at, fromMe: !!msg.fromMe, text: msg.body || '', ctwa }));
}

// Varre conversas com atividade recente (cobre o período em que o processo ficou parado)
async function catchUp(client) {
  const sinceSec = Math.floor(Date.now() / 1000) - CATCHUP_HOURS * 3600;
  try {
    const chats = (await client.getChats()).filter((c) => !c.isGroup && (c.timestamp || 0) >= sinceSec);
    log(`🔁 catch-up: ${chats.length} conversas com atividade nas últimas ${CATCHUP_HOURS}h`);
    for (const chat of chats) {
      try {
        const msgs = await chat.fetchMessages({ limit: 10 });
        const lastIn = [...msgs].reverse().find((m) => !m.fromMe && (m.timestamp || 0) >= sinceSec);
        const lastOut = [...msgs].reverse().find((m) => m.fromMe && (m.timestamp || 0) >= sinceSec);
        // a origem (anúncio/texto pré-preenchido) costuma estar na PRIMEIRA mensagem
        const firstIn = msgs.find((m) => !m.fromMe && (m.timestamp || 0) >= sinceSec);
        if (firstIn && firstIn !== lastIn) await ingestMessage(client, firstIn);
        if (lastIn) await ingestMessage(client, lastIn);
        if (lastOut) await ingestMessage(client, lastOut);
      } catch (e) {
        warn(`conversa ${chat.id?._serialized} falhou no catch-up:`, e?.message);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    await queue;
    log('🔁 catch-up concluído', stats);
  } catch (err) {
    warn('catch-up falhou (segue só com mensagens novas):', err?.message);
  }
}

// ─── Ciclo de vida do cliente com reconexão e backoff ──────────────────────
let client = null;
let attempt = 0;
let restarting = false;
let healthTimer = null;
let shuttingDown = false;

function scheduleRestart(reason) {
  if (restarting || shuttingDown) return;
  restarting = true;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  const delay = Math.min(5_000 * 2 ** attempt, MAX_BACKOFF_MS);
  attempt++;
  warn(`reiniciando cliente em ${Math.round(delay / 1000)}s (tentativa ${attempt}) — motivo: ${reason}`);
  const old = client;
  client = null;
  (old ? old.destroy().catch(() => {}) : Promise.resolve()).finally(() => {
    setTimeout(() => { restarting = false; start(); }, delay);
  });
}

function start() {
  if (shuttingDown) return;
  log(`🚀 iniciando cliente de VENDAS (auth: ${AUTH_DIR}, modo: ${WRITE ? 'GRAVAÇÃO' : 'SECO'})`);
  const c = new Client({
    authStrategy: new LocalAuth({ clientId: 'vendas', dataPath: AUTH_DIR }),
    authTimeoutMs: 120_000,
    qrMaxRetries: 0,
    takeoverOnConflict: false, // não brigar com outra sessão: se houver conflito, reconecta com backoff
    puppeteer: {
      headless: 'new',
      executablePath: resolveChromePath(),
      protocolTimeout: 120_000,
      handleSIGINT: false,
      handleSIGTERM: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--mute-audio', '--disable-extensions'],
    },
  });
  client = c;

  c.on('qr', async (qr) => {
    log('📡 QR GERADO — escaneie com o celular de VENDAS (WhatsApp → Aparelhos conectados → Conectar aparelho)');
    try {
      console.log(await qrcode.toString(qr, { type: 'terminal', small: true }));
      await qrcode.toFile(path.join(AUTH_DIR, 'qr.png'), qr);
      log(`QR também salvo em ${path.join(AUTH_DIR, 'qr.png')}`);
    } catch (e) {
      warn('não consegui renderizar o QR:', e.message);
    }
  });
  c.on('authenticated', () => log('🔐 autenticado'));
  c.on('loading_screen', (pct, m) => log(`⏳ carregando ${pct}% ${m || ''}`));
  c.on('ready', async () => {
    attempt = 0;
    try { fs.rmSync(path.join(AUTH_DIR, 'qr.png'), { force: true }); } catch { /* ignora */ }
    log(`✅ conectado como ${c.info?.wid?.user ? tail(c.info.wid.user) : '?'} — ouvindo conversas (somente leitura)`);
    healthTimer = setInterval(async () => {
      try {
        const st = await c.getState();
        if (st !== 'CONNECTED') scheduleRestart(`estado ${st}`);
      } catch (e) {
        scheduleRestart(`getState falhou: ${e.message}`);
      }
    }, 60_000);
    catchUp(c);
  });
  // message_create cobre recebidas E enviadas pelo celular (resposta manual da recepção)
  c.on('message_create', (msg) => {
    ingestMessage(c, msg).catch((e) => warn('mensagem ignorada:', e?.message));
  });
  c.on('auth_failure', (m) => scheduleRestart(`auth_failure: ${m} — se persistir, apague ${AUTH_DIR} e escaneie de novo`));
  c.on('change_state', (st) => log(`🔄 estado: ${st}`));
  c.on('disconnected', (reason) => {
    if (reason === 'LOGOUT') warn('aparelho desconectado no celular — próximo início vai pedir QR novo');
    scheduleRestart(`disconnected: ${reason}`);
  });

  c.initialize().catch((err) => scheduleRestart(`initialize: ${err?.message}`));
}

async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`🛑 ${sig} — encerrando`, stats);
  if (healthTimer) clearInterval(healthTimer);
  try { await queue; } catch { /* ignora */ }
  try { await client?.destroy(); } catch { /* ignora */ }
  try { await mongoose.disconnect(); } catch { /* ignora */ }
  releaseLock();
  process.exit(0);
}

// ─── Boot ──────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error(`${TAG} ❌ MONGO_URI não configurada`);
  process.exit(1);
}
acquireLock();
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => warn('unhandledRejection:', e?.message || e));

// O .env local aponta para crm_development; o CRM de produção lê fono_inova_prod.
const DB_NAME = args.find((a) => a.startsWith('--db='))?.split('=')[1];
await mongoose.connect(MONGO_URI, { maxPoolSize: 3, serverSelectionTimeoutMS: 30_000, ...(DB_NAME && { dbName: DB_NAME }) });
log(`✅ MongoDB conectado — banco: ${mongoose.connection.name}`);
if (!WRITE) log('🧪 MODO SECO — nada será gravado. Rode com --write para gravar nos Leads.');
setInterval(() => log('📊', stats), 10 * 60_000).unref();
start();
