/**
 * 💬 Serviço WhatsApp Web.js — LocalAuth com persistência em disco (/var/data)
 *
 * Regra de ouro: NÃO tente "salvar" o sistema. Deixe o WhatsApp Web.js
 * trabalhar sozinho. Só inicializa, ouve eventos, e reinicia suave se cair.
 *
 * ZERO purge automático
 * ZERO stuck detection
 * ZERO reconnect storm
 * TIMEOUTS altos
 *
 * Sessão persistida em disco via LocalAuth — mais confiável que RemoteAuth.
 * Fallback: polling de getState() força ready se o evento nativo não disparar.
 */

import './setPuppeteerCache.js';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, Poll } = pkg;
import { MongoStore } from 'wwebjs-mongo';
import mongoose from 'mongoose';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { normalizeE164BR } from '../utils/phone.js';
import { resolveAttendancePollVoterPhone } from '../utils/attendancePollVoter.js';
import { PINNED_CHROME_VERSION, chromeBinarySubpath } from '../config/chromeVersion.js';
import WhatsAppWebState from '../models/WhatsAppWebState.js';

// ─── Caminho de persistência da sessão (module-level para uso em clearSession/reconnect) ─
const authPath = process.env.WHATSAPP_AUTH_PATH || '/var/data/wwebjs_auth';

// ─── Estado singleton em memória (fonte de verdade para rotas, parent, frontend) ─
export const whatsappState = {
  status: 'starting',
  ready: false,
  authenticated: false,
  qrCode: null,
  lastDisconnectReason: null,
  lastAuthenticatedAt: null,
  qrCount: 0,
  initAttempts: 0,
  updatedAt: null,
  pid: null,
  uptime: null,
};

// ─── Estado interno do serviço ───────────────────────────────────────────────
let client = null;
let isReady = false;
let qrCodeDataUrl = null;
let connectionStatus = 'starting';
let isInitializing = false;
let retryTimeout = null;
let initAttempts = 0;
const MAX_INIT_ATTEMPTS = 10;
let loadingWatchdog = null;
// Watchdog da fase "initializing": client.initialize() pode ficar pendurado para
// sempre (Chrome/WhatsApp Web não carrega) sem disparar qr/loading_screen/erro.
// Em 09/11/2026 ficou 1h48 em "Inicializando..." em produção até reiniciar na mão.
let initWatchdog = null;
const INIT_TIMEOUT_MS = Number(process.env.WHATSAPP_INIT_TIMEOUT_MS) || 4 * 60 * 1000;

function clearInitWatchdog() {
  if (initWatchdog) { clearTimeout(initWatchdog); initWatchdog = null; }
}

// Reinício de recuperação PRESERVANDO a sessão no disco (LocalAuth): o próximo
// boot reconecta sozinho, sem QR, se a sessão ainda for válida.
// No child (process.send): sai e o parent respawna com Chrome novo em 10s.
async function restartForRecovery(reason) {
  console.error(`[WhatsAppWeb] ♻️ Reinício de recuperação — ${reason}`);
  clearInitWatchdog();
  isReady = false;
  connectionStatus = 'restarting';
  whatsappState.lastDisconnectReason = reason;
  try { await saveState(); } catch {}
  if (process.send) {
    process.exit(2);
    return;
  }
  // Fora do child (dev): destrói e tenta de novo no mesmo processo
  isInitializing = false;
  await safeDestroyClient();
  if (retryTimeout) clearTimeout(retryTimeout);
  retryTimeout = setTimeout(() => initWhatsAppClient(), 10_000);
}
let readyPollInterval = null;
let stateSaveInterval = null;
let attendancePollSyncInterval = null;
let attendancePollSyncRunning = false;

function updateState(updates) {
  Object.assign(whatsappState, updates, { updatedAt: new Date().toISOString() });
}

// ─── Persistência MongoDB + singleton em memória ─────────────────────────────
async function saveState() {
  updateState({
    status: connectionStatus,
    ready: isReady,
    qrCode: qrCodeDataUrl,
    pid: process.pid,
    uptime: process.uptime(),
    initAttempts,
  });
  try {
    await WhatsAppWebState.findOneAndUpdate(
      { instanceId: 'main' },
      {
        status: connectionStatus,
        ready: isReady,
        authenticated: whatsappState.authenticated,
        qrCode: qrCodeDataUrl,
        pid: process.pid,
        uptime: process.uptime(),
        lastDisconnectReason: whatsappState.lastDisconnectReason,
        lastAuthenticatedAt: whatsappState.lastAuthenticatedAt ? new Date(whatsappState.lastAuthenticatedAt) : null,
        qrCount: whatsappState.qrCount,
        initAttempts,
        updatedAt: new Date(),
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('[WhatsAppWeb] Erro ao salvar estado:', err.message);
  }
}

// Catch-up e reparo de atribuição: agendados a partir do 'ready' OU do ready forçado pelo polling.
// Um agendamento por client (o evento real pode chegar depois do forçado).
const attributionJobsScheduled = new WeakSet();
function scheduleAttributionJobs(client) {
  if (!client || attributionJobsScheduled.has(client)) return;
  attributionJobsScheduled.add(client);
  // Worker fica desligado à noite/fim de semana: recupera a origem das mensagens recebidas nesse período
  setTimeout(() => catchUpAttribution(client), 60_000);
  setTimeout(() => repairLidAttributions(client).catch((e) => console.warn('[WhatsAppWeb] reparo @lid falhou:', e.message)), 90_000);
}

async function syncPendingAttendancePollVotes(activeClient) {
  if (attendancePollSyncRunning || !isReady || !activeClient?.getPollVotes) return;
  attendancePollSyncRunning = true;
  try {
    const { default: Appointment } = await import('../models/Appointment.js');
    const sentSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const pending = await Appointment.find({
      'attendanceConfirmation.status': { $in: ['pending', 'no_response'] },
      'attendanceConfirmation.messageId': { $exists: true, $nin: [null, '', 'unknown'] },
      'attendanceConfirmation.sentAt': { $gte: sentSince },
    })
      .select('_id attendanceConfirmation.messageId')
      .sort({ 'attendanceConfirmation.sentAt': -1 })
      .limit(100)
      .lean();

    for (const appointment of pending) {
      const messageId = appointment.attendanceConfirmation?.messageId;
      if (!messageId) continue;
      try {
        const votes = await activeClient.getPollVotes(String(messageId));
        for (const vote of votes || []) {
          console.log(`[WhatsAppWeb] 🗳️ voto recuperado por sincronização para agendamento ${appointment._id}`);
          await handleInboundAttendancePollVote(vote);
        }
      } catch (err) {
        console.warn(`[WhatsAppWeb] ⚠️ não foi possível consultar voto da enquete ${String(messageId).slice(-24)}:`, err?.message || err);
      }
    }
  } catch (err) {
    console.warn('[WhatsAppWeb] ⚠️ sincronização de votos pendentes falhou:', err?.message || err);
  } finally {
    attendancePollSyncRunning = false;
  }
}

function startAttendancePollSync(activeClient) {
  if (attendancePollSyncInterval) clearInterval(attendancePollSyncInterval);
  attendancePollSyncInterval = setInterval(
    () => syncPendingAttendancePollVotes(activeClient),
    15_000
  );
  setTimeout(() => syncPendingAttendancePollVotes(activeClient), 5_000);
}

// ─── Fallback: polling getState() para detectar ready quando o evento não dispara ─
function startReadyPoll(newClient) {
  if (readyPollInterval) { clearInterval(readyPollInterval); readyPollInterval = null; }
  readyPollInterval = setInterval(async () => {
    if (isReady || !newClient) {
      clearInterval(readyPollInterval);
      readyPollInterval = null;
      return;
    }
    try {
      const state = await newClient.getState();
      if (state === 'CONNECTED') {
        const ts = new Date().toISOString();
        console.log(`[WhatsAppWeb][${ts}] ✅ getState() retornou CONNECTED — forçando ready.`);
        clearInterval(readyPollInterval);
        readyPollInterval = null;
        if (loadingWatchdog) { clearTimeout(loadingWatchdog); loadingWatchdog = null; }
        isReady = true;
        qrCodeDataUrl = null;
        connectionStatus = 'ready';
        initAttempts = 0;
        if (retryTimeout) {
          clearTimeout(retryTimeout);
          retryTimeout = null;
        }
        await saveState();
        scheduleAttributionJobs(newClient); // o evento 'ready' não disparou: sem isto catch-up/reparo nunca rodam
        startAttendancePollSync(newClient);
      }
    } catch (e) {
      // ainda não está pronto — ignora
    }
  }, 10_000);
}

// ─── Sessão já sincronizada sem 'ready' (09/11/2026) ─────────────────────────
// O whatsapp-web.js só emite authenticated/ready no evento 'change:hasSynced'
// do Socket. Reaproveitando a sessão do disco, o sync pode terminar ANTES do
// listener existir: initialize() resolve, nenhum evento vem e o painel fica em
// "Inicializando..." para sempre (sem QR, porque a sessão é válida).
// Aqui olhamos o Socket e, se já sincronizou, chamamos o próprio handler da lib
// (window.onAppStateHasSyncedEvent), que injeta os utilitários e emite ready.
let syncedKickInterval = null;
function startSyncedSessionKick(activeClient) {
  if (syncedKickInterval) clearInterval(syncedKickInterval);
  let checks = 0;
  let kicked = 0;
  let recoveries = 0;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await tickInner(); } finally { busy = false; }
  };
  const tickInner = async () => {
    if (isReady || client !== activeClient || !activeClient?.pupPage) {
      clearInterval(syncedKickInterval); syncedKickInterval = null;
      return;
    }
    checks++;
    try {
      const sock = await activeClient.pupPage.evaluate(() => {
        try {
          const S = window.require('WAWebSocketModel').Socket;
          return { state: S.state, hasSynced: !!S.hasSynced, handler: typeof window.onAppStateHasSyncedEvent };
        } catch (e) {
          return { error: String(e?.message || e) };
        }
      });
      if (checks <= 3 || checks % 6 === 0) {
        console.log(`[WhatsAppWeb] 🔎 pós-init: socket=${JSON.stringify(sock)} status=${connectionStatus}`);
      }
      // Já tem evento de vida (qr/loading/authenticated): a lib está andando sozinha
      if (connectionStatus !== 'initializing') return;
      if (sock?.hasSynced && sock.handler === 'function' && kicked < 3) {
        kicked++;
        console.log(`[WhatsAppWeb] 🩹 Sessão já sincronizada sem 'ready' — disparando handler da lib (tentativa ${kicked}).`);
        await activeClient.pupPage.evaluate(() => window.onAppStateHasSyncedEvent());
      }
    } catch (e) {
      const msg = e?.message || String(e);
      console.warn('[WhatsAppWeb] pós-init: falha ao ler socket:', msg);
      // Log de prod 09/11 13:46: "Attempted to use detached Frame" 5s após o init.
      // O WhatsApp Web recarrega a página e o Puppeteer perde o frame; a lib
      // fica surda (nenhum evento) para sempre. Abre uma aba nova no MESMO
      // perfil (sessão do LocalAuth preservada) e reinjeta.
      if (/detached|Target closed|Session closed/i.test(msg) && recoveries < 2) {
        recoveries++;
        await recoverDetachedPage(activeClient, recoveries);
      }
    }
  };
  setTimeout(tick, 5_000);
  syncedKickInterval = setInterval(tick, 15_000);
}

// 09/11/2026 (log de prod 14:31–14:36): "detached Frame" + "Connection closed" ao
// listar abas = o PROCESSO do Chrome morreu logo depois de abrir o WhatsApp Web.
// A lib não ouve o browser cair, então ficávamos 240s surdos até o watchdog.
// Aqui logamos como o Chrome saiu (código/sinal) e reiniciamos na hora.
function watchBrowserProcess(activeClient) {
  const browser = activeClient?.pupBrowser;
  if (!browser || typeof browser.on !== 'function') return;
  const proc = typeof browser.process === 'function' ? browser.process() : null;
  if (proc && typeof proc.once === 'function') {
    proc.once('exit', (code, signal) => {
      console.error(`[WhatsAppWeb] 💥 Processo do Chrome saiu: code=${code} signal=${signal} status=${connectionStatus} ready=${isReady}`);
    });
  }
  browser.once('disconnected', () => {
    if (client !== activeClient) return; // já trocamos de client (destroy/restart nosso)
    console.error(`[WhatsAppWeb] 💥 Conexão com o Chrome perdida (status=${connectionStatus}, ready=${isReady}).`);
    if (!isReady) restartForRecovery('Chrome caiu durante a inicialização');
  });
}

async function recoverDetachedPage(activeClient, attempt) {
  const browser = activeClient?.pupBrowser;
  if (!browser) return;
  try {
    const pages = await browser.pages();
    console.log(`[WhatsAppWeb] 🛠️ Frame destacado — recuperando página (tentativa ${attempt}). Abas: ${pages.map((p) => { try { return p.url(); } catch { return '?'; } }).join(' | ')}`);
    const oldPage = activeClient.pupPage;
    const page = await browser.newPage();
    const ua = activeClient.options?.userAgent;
    if (ua) await page.setUserAgent(ua);
    activeClient.pupPage = page;
    // Fecha a aba velha ANTES de abrir o WhatsApp na nova: duas abas no mesmo perfil dão conflito
    if (oldPage && oldPage !== page) { try { await oldPage.close(); } catch { /* já morta */ } }
    await page.goto('https://web.whatsapp.com/', { waitUntil: 'load', timeout: 120_000, referer: 'https://whatsapp.com/' });
    await activeClient.inject();
    // A lib só registra este listener na página original
    page.on('framenavigated', () => {
      activeClient.inject().catch((err) => console.warn('[WhatsAppWeb] reinject após navegação falhou:', err?.message || err));
    });
    console.log('[WhatsAppWeb] 🛠️ Página nova injetada — aguardando qr/ready.');
  } catch (err) {
    console.warn('[WhatsAppWeb] 🛠️ Recuperação da página falhou:', err?.message || err);
  }
}

// ─── Resolve caminho do Chrome ───────────────────────────────────────────────
function resolveChromePath() {
  // 1. Variável de ambiente explícita
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Versão fixada (config/chromeVersion.js) — tem prioridade sobre qualquer
  //    outra encontrada no disco. Sem isto, um Chrome antigo esquecido em
  //    .cache/puppeteer/ ganha do que o build acabou de instalar em chrome/,
  //    que foi exatamente a falha de 12/08/2026 (.cache tinha 128/146/148 e o
  //    148 vencia o 151.0.7922.77 recém-instalado).
  for (const base of ['chrome', path.join('.cache', 'puppeteer', 'chrome')]) {
    const pinned = path.join(process.cwd(), base, chromeBinarySubpath());
    if (fs.existsSync(pinned)) {
      console.log(`[WhatsAppWeb] Chrome fixado ${PINNED_CHROME_VERSION}: ${pinned}`);
      return pinned;
    }
  }
  console.warn(
    `[WhatsAppWeb] ⚠️ Chrome fixado ${PINNED_CHROME_VERSION} NÃO encontrado — ` +
    'caindo para descoberta automática. Versão divergente pode falhar com "frame was detached".'
  );

  // 3. Cache do puppeteer no projeto (.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome)
  try {
    const cacheDir = path.join(process.cwd(), '.cache', 'puppeteer', 'chrome');
    if (fs.existsSync(cacheDir)) {
      const versions = fs.readdirSync(cacheDir).filter(v => v.startsWith('linux-')).sort().reverse();
      for (const v of versions) {
        const p = path.join(cacheDir, v, 'chrome-linux64', 'chrome');
        if (fs.existsSync(p)) {
          console.log(`[WhatsAppWeb] Chrome encontrado no cache: ${p}`);
          return p;
        }
      }
    }
  } catch {}

  // 4. Chrome instalado via @puppeteer/browsers (novo path do Render)
  try {
    const browsersDir = path.join(process.cwd(), 'chrome');
    if (fs.existsSync(browsersDir)) {
      const versions = fs.readdirSync(browsersDir).filter(v => v.startsWith('linux-')).sort().reverse();
      for (const v of versions) {
        const p = path.join(browsersDir, v, 'chrome-linux64', 'chrome');
        if (fs.existsSync(p)) {
          console.log(`[WhatsAppWeb] Chrome encontrado em chrome/: ${p}`);
          return p;
        }
      }
    }
  } catch {}

  // 5. Caminhos do sistema
  const system = [
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const p of system) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── Filtro de ruído de pageerror/console do Puppeteer ───────────────────────
const PAGE_NOISE_PATTERNS = [
  /Failed to load resource: net::ERR_/i,
  /WebSocket connection to ['"]?wss?:\/\//i,
  /Failed to execute ['"]postMessage['"] on ['"]DOMWindow['"]/i,
  /Manifest:/i,
  /was loaded over HTTPS/i,
  /has been blocked by CORS/i,
  /Content Security Policy/i,
  /Refused to execute inline script/i,
  /Uncaught \(in promise\) undefined/i,
  /Error in event handler: TypeError: Cannot read properties of undefined/i,
  /Extension ['"][^'"]+['"] tried to modify/i,
  /runtime\.sendMessage/i,
  /runtime\.onMessage/i,
  /\[Report Only\]/i,
];

function isPageNoise(message) {
  return PAGE_NOISE_PATTERNS.some(re => re.test(message));
}

function attachPageNoiseFilters(newClient) {
  let attempts = 0;
  const maxAttempts = 30;

  const tryAttach = () => {
    const page = newClient?.pupPage;
    if (!page) {
      if (++attempts >= maxAttempts) return;
      return setTimeout(tryAttach, 1000);
    }

    page.on('pageerror', (err) => {
      const msg = err?.message || String(err);
      if (isPageNoise(msg)) return;
      console.warn('[WhatsAppWeb][pageerror]', msg);
    });

    page.on('console', (msg) => {
      try {
        const text = msg.text();
        if (isPageNoise(text)) return;
        const type = msg.type();
        if (type === 'error' || type === 'warning') {
          console.warn(`[WhatsAppWeb][console:${type}]`, text.slice(0, 500));
        }
      } catch (e) {
        // ignora erros ao ler mensagem do console
      }
    });

    console.log('[WhatsAppWeb] Filtros de ruído pageerror/console ativados.');
  };

  setTimeout(tryAttach, 1000);
}

// ─── Criação do cliente ─────────────────────────────────────────────────────
function getSessionDir() {
  const candidates = ['session', 'session-default'];
  for (const c of candidates) {
    const p = path.join(authPath, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function cleanupChromeCache() {
  const sessionDir = getSessionDir();
  if (!sessionDir) {
    console.log('[WhatsAppWeb] Nenhuma sessão encontrada para limpeza de cache.');
    return { removed: [], skippedReason: 'no_session' };
  }

  const cacheTargets = [
    'Default/Cache',
    'Default/Code Cache',
    'Default/GPUCache',
    'Default/Service Worker',
    'Default/blob_storage',
    'Default/optimization_guide_model_and_features_store',
    'Default/optimization_guide_prediction_model_downloads',
    'Default/PostjumpMetrics',
  ];

  const removed = [];
  for (const target of cacheTargets) {
    const targetPath = path.join(sessionDir, target);
    try {
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        removed.push(targetPath);
      }
    } catch (e) {
      console.warn(`[WhatsAppWeb] Não foi possível remover cache ${targetPath}:`, e.message);
    }
  }

  console.log(`[WhatsAppWeb] 🧹 Limpeza de cache do Chrome concluída. Itens removidos: ${removed.length}`);
  return { removed, skippedReason: null };
}

function cleanupChromeCacheIfNeeded() {
  try {
    const du = execSync(`du -sb ${authPath} 2>/dev/null || echo 0`).toString().trim();
    const bytes = parseInt(du.split(/\s+/)[0], 10) || 0;
    const mb = bytes / 1024 / 1024;
    const threshold = parseFloat(process.env.WHATSAPP_CACHE_CLEANUP_THRESHOLD_MB || '1500');

    if (mb > threshold) {
      console.log(`[WhatsAppWeb] ⚠️ Sessão com ${mb.toFixed(2)} MB. Acima de ${threshold} MB — limpando caches temporários...`);
      const result = cleanupChromeCache();
      return { triggered: true, sizeBeforeMB: mb, ...result };
    }

    return { triggered: false, sizeBeforeMB: mb };
  } catch (e) {
    console.warn('[WhatsAppWeb] Não foi possível verificar cache:', e.message);
    return { triggered: false, error: e.message };
  }
}

function createClient() {
  // Garante pasta de persistência
  try {
    if (!fs.existsSync(authPath)) {
      fs.mkdirSync(authPath, { recursive: true });
    }
  } catch (e) {
    console.warn('[WhatsAppWeb] Não foi possível criar authPath:', e.message);
  }

  // Limpeza preventiva de caches temporários do Chrome (mantém IndexedDB/auth)
  cleanupChromeCacheIfNeeded();

  const puppeteerOpts = {
    headless: 'new',
    // 09/11/2026: o Chrome morre ~5s depois de carregar o WhatsApp Web
    // ("Connection closed" ao listar abas) e a lib fica surda. Sem o stderr do
    // Chrome no log não dá para saber por quê. Desligue com WHATSAPP_CHROME_DUMPIO=false.
    dumpio: process.env.WHATSAPP_CHROME_DUMPIO !== 'false',
    protocolTimeout: 120_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--mute-audio',
        // 12/11/2026: só erros FATAIS do Chrome no log (os "dbus/bus.cc" e "vkCreateInstance" eram ruído
        // de servidor sem barramento de sistema nem GPU; o crash continua aparecendo).
        '--log-level=3',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--disable-extensions',
        // 09/11/2026: o WhatsApp Web troca de processo ao recarregar e o Puppeteer
        // fica com o frame "detached" (lib surda, preso em Inicializando). Sem
        // isolamento por site a página fica no mesmo processo.
        '--disable-site-isolation-trials',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };

  const chromePath = resolveChromePath();
  if (chromePath) {
    puppeteerOpts.executablePath = chromePath;
    console.log(`[WhatsAppWeb] Usando Chrome: ${chromePath}`);
  }

  // Limpa cache local stale do WhatsApp Web (pode ter HTML antigo)
  try {
    const staleCacheDir = path.resolve(process.cwd(), '.wwebjs_cache');
    if (fs.existsSync(staleCacheDir)) {
      fs.rmSync(staleCacheDir, { recursive: true, force: true });
      console.log('[WhatsAppWeb] 🧹 Cache local .wwebjs_cache removido (stale).');
    }
  } catch (e) {
    console.warn('[WhatsAppWeb] Não foi possível limpar cache local:', e.message);
  }

  const newClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: authPath,
    }),
    authTimeoutMs: 600_000,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 30_000,
    restartOnAuthFail: false,
    qrMaxRetries: 0, // 0 = nunca desistir — dá tempo ao usuário escanear
    puppeteer: puppeteerOpts,
  });

  // ─── Eventos básicos ─────────────────────────────────────────────────────
  newClient.on('qr', async (qr) => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] 📡 qr gerado — escaneie com o celular`);
    clearInitWatchdog();
    connectionStatus = 'qr';
    whatsappState.qrCount++;
    if (whatsappState.qrCount > 10) {
      console.warn('[WhatsAppWeb] ⚠️ POSSÍVEL LOOP DE AUTH — qrCount > 10');
    }
    try {
      qrCodeDataUrl = await qrcode.toDataURL(qr);
      const base64Data = qrCodeDataUrl.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(path.resolve(process.cwd(), 'qr-code.png'), Buffer.from(base64Data, 'base64'));
      await saveState();
      if (process.send) {
        process.send({ type: 'whatsapp_qr', qrCode: qrCodeDataUrl });
      }
    } catch (err) {
      console.error('[WhatsAppWeb] Erro ao gerar QR:', err.message);
    }

    // Pairing code DESABILITADO temporariamente — estava travando o Puppeteer/CDP
    // com Runtime.callFunctionOn timed out. Focando apenas no QR code.
    // const phoneNumber = process.env.WHATSAPP_PHONE_NUMBER;
    // if (phoneNumber && newClient.requestPairingCode) { ... }
  });

  newClient.on('authenticated', async () => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] 🔐 authenticated — celular escaneou o QR`);
    clearInitWatchdog();
    if (loadingWatchdog) { clearTimeout(loadingWatchdog); loadingWatchdog = null; }
    whatsappState.authenticated = true;
    whatsappState.lastAuthenticatedAt = new Date().toISOString();
    if (process.send) {
      process.send({ type: 'whatsapp_authenticated' });
    }
    // Fallback: se o evento ready nunca disparar (bug do whatsapp-web.js),
    // o polling de getState() detectará CONNECTED e forçará ready.
    startReadyPoll(newClient);
    // Aguarda até 10min para ready disparar; se não vier, respawn limpo
    loadingWatchdog = setTimeout(() => {
      console.error('[WhatsAppWeb] ⚠️ Autenticado mas ready não disparou em 10min — saindo para respawn limpo.');
      process.exit(2);
    }, 10 * 60 * 1000);
    connectionStatus = 'connecting';
    await saveState();
  });

  newClient.on('remote_session_saved', () => {
    console.log('[WhatsAppWeb] ☁️ Sessão salva no MongoDB.');
  });

  newClient.on('ready', async () => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] ✅ ready — WhatsApp conectado!`);
    clearInitWatchdog();
    if (loadingWatchdog) { clearTimeout(loadingWatchdog); loadingWatchdog = null; }
    if (readyPollInterval) { clearInterval(readyPollInterval); readyPollInterval = null; }
    isReady = true;
    qrCodeDataUrl = null;
    connectionStatus = 'ready';
    initAttempts = 0;
    whatsappState.qrCount = 0;
    whatsappState.ready = true;
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }

    await saveState();

    if (process.send) {
      process.send({ type: 'whatsapp_ready' });
    }

    scheduleAttributionJobs(newClient);
    startAttendancePollSync(newClient);
  });

  newClient.on('loading_screen', async (percent, message) => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] ⏳ loading_screen ${percent}% — ${message}`);
    clearInitWatchdog();
    connectionStatus = 'connecting';
    await saveState();
    if (loadingWatchdog) clearTimeout(loadingWatchdog);
    loadingWatchdog = setTimeout(() => {
      console.error('[WhatsAppWeb] ⚠️ Travado em loading_screen por 10min — saindo para respawn limpo.');
      process.exit(2);
    }, 10 * 60 * 1000);
  });

  newClient.on('disconnected', async (reason) => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] 🔴 disconnected: ${reason}`);
    if (loadingWatchdog) { clearTimeout(loadingWatchdog); loadingWatchdog = null; }
    if (readyPollInterval) { clearInterval(readyPollInterval); readyPollInterval = null; }
    if (attendancePollSyncInterval) { clearInterval(attendancePollSyncInterval); attendancePollSyncInterval = null; }
    isReady = false;
    connectionStatus = 'disconnected';
    whatsappState.ready = false;
    whatsappState.authenticated = false;
    whatsappState.lastDisconnectReason = reason;
    await saveState();
    if (process.send) {
      process.send({ type: 'whatsapp_disconnected', reason });
    }
    if (reason === 'LOGOUT') {
      console.log('[WhatsAppWeb] LOGOUT detectado — saindo para respawn limpo.');
      process.exit(1);
    }
    if (reason === 'Max qrcode retries reached') {
      console.log('[WhatsAppWeb] QRs expiraram sem scan — saindo para respawn e novo QR em 10s.');
      process.exit(1);
    }
  });

  newClient.on('error', (err) => {
    console.error('[WhatsAppWeb] ❌ error:', err.message);
  });

  newClient.on('auth_failure', async (msg) => {
    const ts = new Date().toISOString();
    console.error(`[WhatsAppWeb][${ts}] 🔴 auth_failure:`, msg);

    // qrCount === 0: sessão existente no disco foi rejeitada (nunca chegou a mostrar QR)
    // → limpa sessão stale e sai para o parent respawnar com QR novo
    if (whatsappState.qrCount === 0) {
      console.log('[WhatsAppWeb] 🧹 Sessão stale detectada (qrCount=0) — removendo e saindo para respawn limpo...');
      try {
        const localAuthDir = path.join(authPath, '.wwebjs_auth');
        if (fs.existsSync(localAuthDir)) {
          fs.rmSync(localAuthDir, { recursive: true, force: true });
          console.log('[WhatsAppWeb] Sessão local removida.');
        }
      } catch (e) {
        console.warn('[WhatsAppWeb] Erro ao remover sessão:', e.message);
      }
      connectionStatus = 'disconnected';
      await saveState();
      if (process.send) process.send({ type: 'whatsapp_disconnected', reason: `auth_failure_stale: ${msg}` });
      process.exit(1); // parent respawna child limpo, gera novo QR
      return;
    }

    // qrCount > 0: QRs expiraram sem ser escaneados — fica disconnected, espera ação manual
    connectionStatus = 'auth_failure';
    whatsappState.lastDisconnectReason = `auth_failure: ${msg}`;
    saveState();
    if (process.send) {
      process.send({ type: 'whatsapp_disconnected', reason: `auth_failure: ${msg}` });
    }
  });

  newClient.on('change_state', (state) => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] 🔄 change_state: ${state}`);
    if (state === 'CONFLICT' || state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
      connectionStatus = 'disconnected';
      whatsappState.ready = false;
      whatsappState.authenticated = false;
      saveState();
    }
  });

  // ─── Atribuição de origem (marketing) — só LÊ mensagens recebidas, nunca responde ──
  if (process.env.WA_ATTRIBUTION_CAPTURE !== 'false') {
    newClient.on('message', (msg) => {
      handleInboundAttribution(msg).catch((err) =>
        console.warn('[WhatsAppWeb] ⚠️ atribuição falhou (ignorado):', err?.message)
      );
    });
  }

  // O chip comum não passa pelo webhook da API oficial; captura a confirmação aqui.
  newClient.on('message', (msg) => {
    handleInboundAppointmentConfirmation(msg).catch((err) =>
      console.warn('[WhatsAppWeb] ⚠️ confirmação de atendimento falhou (ignorado):', err?.message)
    );
  });

  // Interesse em convênio (GEAP/IPASGO/Bradesco) citado pelo contato → lista de interesse do ERP.
  if (process.env.WA_CONVENIO_INTEREST_CAPTURE !== 'false') {
    newClient.on('message', (msg) => {
      handleInboundConvenioInterest(msg).catch((err) =>
        console.warn('[WhatsAppWeb] ⚠️ interesse em convênio falhou (ignorado):', err?.message)
      );
    });
  }

  // Mensagem que a CLÍNICA mandou (pelo ERP ou na mão, no celular/WhatsApp Web): grava a data na lista de
  // interesse em convênio para o envio em massa não repetir contato com quem a equipe acabou de falar.
  newClient.on('message_create', (msg) => {
    handleOutboundClinicMessage(msg).catch((err) =>
      console.warn('[WhatsAppWeb] ⚠️ registro de mensagem da clínica falhou (ignorado):', err?.message)
    );
  });

  // As opções clicáveis são enviadas como enquete, recurso suportado pelo WhatsApp Web.
  newClient.on('vote_update', (vote) => {
    console.log('[WhatsAppWeb] 🗳️ vote_update recebido');
    handleInboundAttendancePollVote(vote).catch((err) =>
      console.warn('[WhatsAppWeb] ⚠️ voto de confirmação falhou (ignorado):', err?.message)
    );
  });

  attachPageNoiseFilters(newClient);

  return newClient;
}

// Converte origens gravadas com o ID @lid no lugar do telefone. Idempotente: só toca em
// registro fora de /^55\d{10,11}$/ e só quando o WhatsApp resolve um número válido.
async function repairLidAttributions(client) {
  if (process.env.WA_ATTRIBUTION_CAPTURE === 'false' || !client?.getContactLidAndPhone) return;
  const LeadAttribution = (await import('../models/LeadAttribution.js')).default;
  const { normalizeE164BR } = await import('../utils/phone.js');
  const bad = await LeadAttribution.find({ phone: { $not: /^55\d{10,11}$/ } }).lean();
  let fixed = 0;
  for (const a of bad) {
    // normalizeE164BR prefixou "55" no lid: testa as duas formas
    const candidates = [a.phone, a.phone.startsWith('55') ? a.phone.slice(2) : null].filter(Boolean);
    let pn = null;
    for (const lid of candidates) {
      try {
        const [r] = await client.getContactLidAndPhone([`${lid}@lid`]);
        if (r?.pn) { pn = normalizeE164BR(String(r.pn).replace(/@.*$/, '')); if (pn) break; }
      } catch { /* tenta o próximo */ }
    }
    if (!pn || !/^55\d{10,11}$/.test(pn)) continue;
    if (await LeadAttribution.exists({ phone: pn })) await LeadAttribution.deleteOne({ _id: a._id }); // origem pelo número real prevalece
    else await LeadAttribution.updateOne({ _id: a._id }, { $set: { phone: pn } });
    fixed++;
  }
  console.log(`[WhatsAppWeb] 🔧 reparo @lid: ${fixed}/${bad.length} corrigidos`);
}

// Varre conversas com atividade recente (default 72h = cobre fim de semana com worker suspenso).
// Idempotente: a gravação é first-touch por telefone.
async function catchUpAttribution(client) {
  if (process.env.WA_ATTRIBUTION_CAPTURE === 'false' || !client) return;
  const hours = Number(process.env.WA_ATTRIBUTION_CATCHUP_HOURS || 72);
  const sinceSec = Math.floor(Date.now() / 1000) - hours * 3600;
  let checked = 0;
  try {
    const chats = (await client.getChats())
      .filter((c) => !c.isGroup && (c.timestamp || 0) >= sinceSec)
      .slice(0, 150);
    for (const chat of chats) {
      try {
        const msgs = await chat.fetchMessages({ limit: 8 });
        for (const m of msgs) {
          if (m.fromMe || (m.timestamp || 0) < sinceSec) continue;
          await handleInboundAttribution(m);
          checked++;
        }
      } catch { /* conversa com erro de carga — segue */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    console.log(`[WhatsAppWeb] 🔁 catch-up de atribuição: ${chats.length} conversas, ${checked} msgs verificadas (${hours}h)`);
  } catch (err) {
    console.warn('[WhatsAppWeb] ⚠️ catch-up via getChats falhou, tentando via Store:', err?.message);
    await catchUpAttributionViaStore(client, sinceSec, hours);
  }
}

// Fallback: lê as últimas mensagens já carregadas no Store do WhatsApp Web (getChats quebra em algumas versões).
async function catchUpAttributionViaStore(client, sinceSec, hours) {
  try {
    const rows = await client.pupPage.evaluate((since) => {
      const out = [];
      const chats = ((() => { try { return window.require('WAWebCollections'); } catch { return window.Store || {}; } })()).Chat?.getModelsArray?.() || [];
      for (const c of chats) {
        if (c.isGroup || (c.t || 0) < since) continue;
        const server = c.id?.server;
        const phone = server === 'c.us' ? c.id.user : (c.contact?.phoneNumber?.user || null);
        if (!phone || !/^55\d{10,11}$/.test(String(phone))) continue;
        const msgs = c.msgs?.getModelsArray?.() || [];
        for (const m of msgs.slice(-8)) {
          if (m.id?.fromMe || (m.t || 0) < since) continue;
          const ctx = m.ctwaContext || null;
          out.push({
            phone,
            body: m.body || '',
            ctwa: ctx ? { sourceId: ctx.sourceId || null, sourceUrl: ctx.sourceUrl || null, ctwaClid: ctx.ctwaClid || null, title: ctx.title || null } : null,
          });
        }
      }
      return out.slice(0, 1500);
    }, sinceSec);

    const { parseAttribution } = await import('../utils/attributionParser.js');
    const { captureInboundAttribution } = await import('./leadAttributionService.js');
    let found = 0;
    for (const r of rows) {
      if (!parseAttribution(r.body, r.ctwa)) continue;
      const res = await captureInboundAttribution({ phone: r.phone, text: r.body, ctwa: r.ctwa, capturedBy: 'whatsapp_web_catchup' });
      if (res) found++;
    }
    console.log(`[WhatsAppWeb] 🔁 catch-up (Store): ${rows.length} msgs lidas, ${found} com origem (${hours}h)`);
  } catch (err) {
    console.warn('[WhatsAppWeb] ⚠️ catch-up via Store falhou (ignorado):', err?.message);
  }
}

// Telefone BR plausível (DDI 55 + DDD + 8/9 dígitos). IDs @lid têm 14-15 dígitos e não passam.
const isRealBRPhone = (p) => /^55\d{10,11}$/.test(String(p || '').replace(/\D/g, ''));

// Contatos @lid: Contact.number devolve o ID interno (não o telefone). Tenta as fontes
// que expõem o número real e só aceita resultado com formato de telefone BR.
async function resolveRealPhoneFromLid(msg, lid) {
  const candidates = [];
  try {
    const client = msg.client;
    if (client?.getContactLidAndPhone) {
      const r = await client.getContactLidAndPhone([lid]);
      const pn = r?.[0]?.pn;
      if (pn) candidates.push(String(pn).replace('@c.us', ''));
    }
  } catch { /* lib sem o método — segue */ }
  try {
    const c = await msg.getContact();
    if (c?.id?._serialized?.endsWith('@c.us')) candidates.push(c.id.user);
    if (c?.number) candidates.push(c.number);
  } catch { /* segue */ }
  try {
    const p = await msg.client?.pupPage?.evaluate((id) => {
      const ct = ((() => { try { return window.require('WAWebCollections'); } catch { return window.Store || {}; } })()).Contact?.get?.(id);
      return ct?.phoneNumber?.user || null;
    }, lid);
    if (p) candidates.push(p);
  } catch { /* segue */ }
  return candidates.find(isRealBRPhone) || null;
}

// Fire-and-forget: extrai origem (site/anúncio) da mensagem recebida e grava por telefone.
async function handleInboundAttribution(msg) {
  if (!msg || msg.fromMe || msg.isStatus) return;
  const from = msg.from || '';
  if (!from || from.endsWith('@g.us') || from.endsWith('@newsletter') || from === 'status@broadcast') return;

  const text = msg.body || '';
  const ctwaRaw = msg._data?.ctwaContext || null;

  // Checagem barata antes de qualquer I/O
  const { parseAttribution } = await import('../utils/attributionParser.js');
  const ctwa = ctwaRaw
    ? { sourceId: ctwaRaw.sourceId || null, sourceUrl: ctwaRaw.sourceUrl || null, ctwaClid: ctwaRaw.ctwaClid || null, title: ctwaRaw.title || null }
    : null;
  if (ctwaRaw) console.log('[WhatsAppWeb] 📣 ctwaContext recebido — chaves:', Object.keys(ctwaRaw).join(','));
  if (!parseAttribution(text, ctwa)) return;

  let phone = from.endsWith('@c.us') ? from.replace('@c.us', '') : null;
  if (!phone) phone = await resolveRealPhoneFromLid(msg, from);
  if (!phone) {
    console.warn('[WhatsAppWeb] ⚠️ origem detectada mas telefone real não resolvido (@lid) — não gravo para não perder o vínculo com o agendamento');
    return;
  }

  const { captureInboundAttribution } = await import('./leadAttributionService.js');
  await captureInboundAttribution({ phone, text, ctwa, capturedBy: 'whatsapp_web' });
}

async function handleInboundConvenioInterest(msg) {
  if (!msg || msg.fromMe || msg.isStatus) return;
  const from = msg.from || '';
  if (!from || from.endsWith('@g.us') || from.endsWith('@newsletter') || from === 'status@broadcast') return;

  // Checagem barata antes de qualquer I/O
  const { matchWaitlistConvenios } = await import('../constants/convenioWaitlist.js');
  const convenios = matchWaitlistConvenios(msg.body);
  if (!convenios.length) return;

  let phone = from.endsWith('@c.us') ? from.replace('@c.us', '') : null;
  if (!phone) phone = await resolveRealPhoneFromLid(msg, from);
  if (!phone) return;

  const { recordWhatsappInterest } = await import('./convenioWaitlistWhatsapp.js');
  const at = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();
  for (const convenio of convenios) {
    await recordWhatsappInterest({
      phone, convenio, name: msg._data?.notifyName || null,
      firstAt: at, lastAt: at, snippet: msg.body, snippetFromContact: true,
      mentionedBy: ['contato'], capturedBy: 'live',
    });
  }
}

/**
 * Varre o histórico do WhatsApp Web atrás de quem falou do convênio e grava na lista de interesse.
 * SÓ LEITURA no WhatsApp (busca nativa + Store); a escrita é só em convenio_waitlist.
 * Roda no processo do WhatsApp (fila whatsapp-scan, workers/entrypoints/whatsapp-child.js).
 */
// 12/11/2026: pageSize 100 → 25. A busca rápida da Unimed (muitas mensagens, várias com miniatura de anúncio)
// estourou a memória do crm-worker em segundos. Páginas menores e só os campos necessários na memória.
export async function scanConvenioInterest({ convenio, maxPages = 80, pageSize = 25 } = {}) {
  if (!isReady || !client) throw new Error('WhatsApp não está conectado');
  const { WAITLIST_WHATSAPP_KEYWORDS } = await import('../constants/convenioWaitlist.js');
  const kw = WAITLIST_WHATSAPP_KEYWORDS[convenio];
  if (!kw) throw new Error(`Convênio sem palavras de busca: ${convenio}`);

  const isContactChat = (id) => typeof id === 'string' && (id.endsWith('@c.us') || id.endsWith('@lid'));
  const hits = [];
  const stats = { method: 'search', messages: 0, unresolved: 0, searchError: null };

  // 1) Busca nativa do WhatsApp (mesma da lupa do app): cobre todo o histórico sincronizado.
  const seen = new Set();
  const found = [];
  try {
    for (const term of kw.terms) {
      for (let page = 1; page <= maxPages; page++) {
        const msgs = await client.searchMessages(term, { page, limit: pageSize });
        if (!msgs?.length) break;
        for (const m of msgs) {
          const id = m.id?._serialized || `${m.from}:${m.timestamp}:${m.body?.length}`;
          if (seen.has(id)) continue;
          seen.add(id);
          if (m.isStatus || !kw.regex.test(m.body || '')) continue;
          // Guarda só o necessário (o Message traz _data com miniaturas em base64 — pesado).
          found.push({
            fromMe: Boolean(m.fromMe), from: m.from, to: m.to, body: String(m.body || '').slice(0, 500),
            timestamp: m.timestamp, notifyName: m._data?.notifyName || null, msg: String((m.fromMe ? m.to : m.from) || '').endsWith('@lid') ? m : null, // só @lid precisa do objeto para achar o telefone
          });
        }
        if (msgs.length < pageSize) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  } catch (err) {
    stats.searchError = err?.message || String(err);
    console.warn('[WhatsAppWeb] ⚠️ busca nativa falhou, usando mensagens carregadas:', stats.searchError);
  }

  const nameCache = new Map();
  const contactName = async (chatId) => {
    if (nameCache.has(chatId)) return nameCache.get(chatId);
    let name = null;
    try {
      const c = await client.getContactById(chatId);
      name = c?.name || c?.pushname || c?.shortName || null;
    } catch { /* sem nome — segue */ }
    nameCache.set(chatId, name);
    return name;
  };

  for (const m of found) {
    const chatId = m.fromMe ? m.to : m.from;
    if (!isContactChat(chatId)) continue;
    let phone = chatId.endsWith('@c.us') ? chatId.replace('@c.us', '') : (m.msg ? await resolveRealPhoneFromLid(m.msg, chatId) : null);
    if (!phone) { stats.unresolved++; continue; }
    hits.push({
      phone, convenio, fromMe: m.fromMe, body: m.body,
      at: new Date(Number(m.timestamp || 0) * 1000),
      name: (!m.fromMe && m.notifyName) || await contactName(chatId),
    });
  }

  // 2) Plano B: se a busca nativa não respondeu, lê as mensagens já carregadas no Store.
  if (!found.length) {
    stats.method = stats.searchError ? 'store_fallback' : 'search_empty+store';
    const rows = await client.pupPage.evaluate((source) => {
      const re = new RegExp(source, 'i');
      const out = [];
      for (const c of ((() => { try { return window.require('WAWebCollections'); } catch { return window.Store || {}; } })()).Chat?.getModelsArray?.() || []) {
        if (c.isGroup) continue;
        const server = c.id?.server;
        const phone = server === 'c.us' ? c.id.user : (c.contact?.phoneNumber?.user || null);
        if (!phone) continue;
        const name = c.contact?.name || c.contact?.pushname || c.formattedTitle || null;
        for (const m of c.msgs?.getModelsArray?.() || []) {
          if (!m.body || !re.test(m.body)) continue;
          out.push({ phone: String(phone), fromMe: Boolean(m.id?.fromMe), body: String(m.body).slice(0, 500), t: m.t || 0, name });
        }
      }
      return out.slice(0, 5000);
    }, kw.regex.source);
    for (const r of rows) hits.push({ phone: r.phone, convenio, fromMe: r.fromMe, body: r.body, at: new Date(r.t * 1000), name: r.name });
  }

  stats.messages = hits.length;
  const { groupHitsByContact, recordWhatsappInterest } = await import('./convenioWaitlistWhatsapp.js');
  const contacts = groupHitsByContact(hits);
  const counts = { created: 0, updated: 0, closed: 0, invalid: 0 };
  for (const c of contacts) {
    try {
      const r = await recordWhatsappInterest({ ...c, capturedBy: 'scan' });
      counts[r.result] = (counts[r.result] || 0) + 1;
    } catch (err) {
      counts.invalid++;
      console.warn('[WhatsAppWeb] ⚠️ falha ao gravar interessado (segue):', err?.message);
    }
  }
  const result = { ...stats, contacts: contacts.length, ...counts };
  console.log(`[WhatsAppWeb] 🔎 varredura ${convenio}:`, JSON.stringify(result));
  return result;
}

/**
 * Varredura PROFUNDA (só leitura): entra em cada conversa individual, puxa do celular as mensagens
 * antigas (loadEarlierMsgs, o mesmo "carregar mais" do WhatsApp Web) até a data de corte e procura os
 * 4 convênios de uma vez. A busca rápida (searchMessages) só enxerga o que já está no navegador (~2 meses).
 * Retomável: processa em lotes a partir de `startIndex` e chama `onBatch` com o progresso para gravar.
 *
 * @param {{ startIndex?: number, since?: Date, batchSize?: number, maxLoadsPerChat?: number,
 *           onBatch?: (p: object) => Promise<void> }} opts
 */
export async function scanConvenioInterestDeep({
  startIndex = 0,
  since = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000),
  batchSize = 20,
  maxLoadsPerChat = 80,
  onBatch,
} = {}) {
  if (!isReady || !client) throw new Error('WhatsApp não está conectado');
  const { WAITLIST_WHATSAPP_KEYWORDS, CONVENIOS_WAITLIST } = await import('../constants/convenioWaitlist.js');
  const { groupHitsByContact, recordWhatsappInterest } = await import('./convenioWaitlistWhatsapp.js');
  const patterns = CONVENIOS_WAITLIST.map((c) => [c, WAITLIST_WHATSAPP_KEYWORDS[c].regex.source]);

  // Ordem estável (id) para conseguir retomar do mesmo ponto depois de um restart do worker.
  const chatIds = await client.pupPage.evaluate(() => (((() => { try { return window.require('WAWebCollections'); } catch { return window.Store || {}; } })()).Chat?.getModelsArray?.() || [])
    .filter((c) => !c.isGroup && ['c.us', 'lid'].includes(c.id?.server))
    .map((c) => c.id._serialized)
    .sort());
  const total = chatIds.length;
  // 0 conversas = não achou a lista (mudança interna do WhatsApp Web); falhar é melhor que dizer "ninguém".
  if (!total) throw new Error('Não consegui ler a lista de conversas do WhatsApp Web');
  const stats = { total, done: Math.min(startIndex, total), messages: 0, contacts: 0, created: 0, updated: 0, closed: 0, invalid: 0, unresolved: 0, loadErrors: 0, oldest: null, byConvenio: {} };
  console.log(`[WhatsAppWeb] 🔎 varredura profunda: ${total} conversas (começando em ${startIndex})`);

  for (let i = startIndex; i < total; i += batchSize) {
    if (!isReady || !client) throw new Error('WhatsApp desconectou no meio da varredura');
    const ids = chatIds.slice(i, i + batchSize);
    const res = await client.pupPage.evaluate(async (ids, patterns, sinceTs, maxLoads) => {
      const regs = patterns.map(([c, src]) => [c, new RegExp(src, 'i')]);
      const loader = window.require?.('WAWebChatLoadMessages');
      const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('__timeout'), ms))]);
      const out = { rows: [], unresolved: 0, loadErrors: 0, oldest: null };
      const cols = ((() => { try { return window.require('WAWebCollections'); } catch { return window.Store || {}; } })());
      for (const id of ids) {
        const chat = cols.Chat?.get?.(id);
        if (!chat) continue;
        let phone = chat.id.server === 'c.us' ? chat.id.user
          : (chat.contact?.phoneNumber?.user || cols.Contact?.get?.(id)?.phoneNumber?.user || null);
        if (!phone && window.WWebJS?.enforceLidAndPnRetrieval) {
          try { const r = await window.WWebJS.enforceLidAndPnRetrieval(id); phone = r?.phone?.user || null; } catch { /* segue */ }
        }
        const name = chat.contact?.name || chat.contact?.pushname || chat.formattedTitle || null;
        // Carrega o histórico antigo até a data de corte (ou até não haver mais).
        for (let n = 0; n < maxLoads && loader?.loadEarlierMsgs; n++) {
          const arr = chat.msgs.getModelsArray();
          if (arr.length && (arr[0].t || 0) < sinceTs) break;
          let loaded;
          try { loaded = await withTimeout(loader.loadEarlierMsgs({ chat }), 20000); } catch { out.loadErrors++; break; }
          if (loaded === '__timeout') { out.loadErrors++; break; }
          if (!loaded || !loaded.length) break;
        }
        const msgs = chat.msgs.getModelsArray();
        if (msgs.length && (out.oldest === null || msgs[0].t < out.oldest)) out.oldest = msgs[0].t;
        let hit = false;
        for (const m of msgs) {
          if (!m.body || typeof m.body !== 'string' || (m.t || 0) < sinceTs) continue;
          for (const [c, re] of regs) {
            if (!re.test(m.body)) continue;
            hit = true;
            if (phone) out.rows.push({ phone: String(phone), convenio: c, fromMe: Boolean(m.id?.fromMe), body: m.body.slice(0, 500), t: m.t || 0, name });
          }
        }
        if (hit && !phone) out.unresolved++;
        // Libera da memória do navegador o que foi carregado (mantém só as recentes).
        try {
          const all = chat.msgs.getModelsArray();
          if (all.length > 60) {
            chat.msgs.remove(all.slice(0, all.length - 50));
            if (chat.msgs.msgLoadState) chat.msgs.msgLoadState.noEarlierMsgs = false;
          }
        } catch { /* sem limpeza — segue */ }
      }
      return out;
    }, ids, patterns, Math.floor(since.getTime() / 1000), maxLoadsPerChat);

    stats.unresolved += res.unresolved;
    stats.loadErrors += res.loadErrors;
    if (res.oldest && (!stats.oldest || res.oldest * 1000 < new Date(stats.oldest).getTime())) stats.oldest = new Date(res.oldest * 1000).toISOString();
    const hits = res.rows.map((r) => ({ phone: r.phone, convenio: r.convenio, fromMe: r.fromMe, body: r.body, at: new Date(r.t * 1000), name: r.name }));
    stats.messages += hits.length;
    for (const c of groupHitsByContact(hits)) {
      stats.contacts++;
      stats.byConvenio[c.convenio] = (stats.byConvenio[c.convenio] || 0) + 1;
      try {
        const r = await recordWhatsappInterest({ ...c, capturedBy: 'scan' });
        stats[r.result] = (stats[r.result] || 0) + 1;
      } catch (err) {
        stats.invalid++;
        console.warn('[WhatsAppWeb] ⚠️ falha ao gravar interessado (segue):', err?.message);
      }
    }
    stats.done = Math.min(i + batchSize, total);
    if (onBatch) await onBatch({ nextIndex: stats.done, stats: { ...stats } });
    if (stats.done % 200 < batchSize) console.log('[WhatsAppWeb] 🔎 varredura profunda:', JSON.stringify(stats));
    await new Promise((r) => setTimeout(r, 500)); // folga para envios da fila whatsapp-send
  }
  console.log('[WhatsAppWeb] 🔎 varredura profunda concluída:', JSON.stringify(stats));
  return stats;
}

async function handleOutboundClinicMessage(msg) {
  if (!msg || !msg.fromMe || msg.isStatus) return;
  const to = msg.to || '';
  if (!to || to.endsWith('@g.us') || to.endsWith('@newsletter') || to === 'status@broadcast') return;
  let phone = to.endsWith('@c.us') ? to.replace('@c.us', '') : null;
  if (!phone && to.endsWith('@lid')) phone = await resolveRealPhoneFromLid(msg, to);
  if (!phone) return;
  const { recordChatActivity } = await import('./convenioWaitlistWhatsapp.js');
  const at = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();
  await recordChatActivity([{ phone, clinicAt: at }]);
}

/**
 * Última mensagem da clínica e do contato em CADA conversa individual (SÓ LEITURA).
 * Olha as mensagens que o WhatsApp Web já tem carregadas; a conversa sem nenhuma carregada puxa 1 lote.
 * @param {{ onlyPhones?: Set<string>|null }} opts telefones (últimos 8 dígitos) que interessam — os outros nem carregam
 * @returns {Promise<{ rows: Array<{ phone: string, clinicAt: Date|null, contactAt: Date|null }>, chats: number, unresolved: number }>}
 */
export async function readChatActivity({ onlyTails = null } = {}) {
  if (!isReady || !client) throw new Error('WhatsApp não está conectado');
  const res = await client.pupPage.evaluate(async (tails) => {
    const cols = ((() => { try { return window.require('WAWebCollections'); } catch { return window.Store || {}; } })());
    const loader = window.require?.('WAWebChatLoadMessages');
    const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('__timeout'), ms))]);
    const want = tails ? new Set(tails) : null;
    const chats = (cols.Chat?.getModelsArray?.() || []).filter((c) => !c.isGroup && ['c.us', 'lid'].includes(c.id?.server));
    const out = { rows: [], chats: chats.length, unresolved: 0 };
    for (const chat of chats) {
      const id = chat.id._serialized;
      let phone = chat.id.server === 'c.us' ? chat.id.user
        : (chat.contact?.phoneNumber?.user || cols.Contact?.get?.(id)?.phoneNumber?.user || null);
      if (!phone && window.WWebJS?.enforceLidAndPnRetrieval) {
        try { const r = await withTimeout(window.WWebJS.enforceLidAndPnRetrieval(id), 3000); phone = r?.phone?.user || null; } catch { /* segue */ }
      }
      if (!phone) { out.unresolved++; continue; }
      if (want && !want.has(String(phone).slice(-8))) continue;
      let msgs = chat.msgs?.getModelsArray?.() || [];
      if (!msgs.length && loader?.loadEarlierMsgs) {
        try { await withTimeout(loader.loadEarlierMsgs({ chat }), 15000); } catch { /* segue */ }
        msgs = chat.msgs?.getModelsArray?.() || [];
      }
      let clinicT = 0;
      let contactT = 0;
      for (const m of msgs) {
        const t = m.t || 0;
        if (m.id?.fromMe) { if (t > clinicT) clinicT = t; } else if (t > contactT) contactT = t;
      }
      out.rows.push({ phone: String(phone), clinicT, contactT });
    }
    return out;
  }, onlyTails ? [...onlyTails] : null);
  return {
    chats: res.chats,
    unresolved: res.unresolved,
    rows: res.rows.map((r) => ({
      phone: r.phone,
      clinicAt: r.clinicT ? new Date(r.clinicT * 1000) : null,
      contactAt: r.contactT ? new Date(r.contactT * 1000) : null,
    })),
  };
}

/**
 * Última mensagem da clínica e do contato numa conversa (SÓ LEITURA). Usado pelo worker logo antes de cada
 * envio em massa. Sem conversa no WhatsApp = nunca falaram ({ clinicAt: null, contactAt: null }).
 */
export async function getChatActivity(phone) {
  if (!isReady || !client) throw new Error('WhatsApp não está conectado');
  const clean = normalizeE164BR(phone);
  if (!clean) throw new Error(`Número inválido: ${phone}`);
  const numberId = await client.getNumberId(clean);
  if (!numberId) return { clinicAt: null, contactAt: null, exists: false };
  let chat = null;
  try { chat = await client.getChatById(numberId._serialized); } catch { chat = null; }
  if (!chat) return { clinicAt: null, contactAt: null, exists: true };
  const msgs = await chat.fetchMessages({ limit: 60 });
  let clinicT = 0;
  let contactT = 0;
  for (const m of msgs || []) {
    const t = Number(m.timestamp) || 0;
    if (m.fromMe) { if (t > clinicT) clinicT = t; } else if (t > contactT) contactT = t;
  }
  return {
    exists: true,
    clinicAt: clinicT ? new Date(clinicT * 1000) : null,
    contactAt: contactT ? new Date(contactT * 1000) : null,
  };
}

async function handleInboundAppointmentConfirmation(msg) {
  if (!msg || msg.fromMe || msg.isStatus) return;
  const from = msg.from || '';
  if (!from || from.endsWith('@g.us') || from.endsWith('@newsletter') || from === 'status@broadcast') return;

  let phone = from.endsWith('@c.us') ? from.replace('@c.us', '') : null;
  if (!phone) phone = await resolveRealPhoneFromLid(msg, from);
  if (!phone) return;

  const { recordAttendanceConfirmationResponse } = await import('./appointment/attendanceConfirmation.service.js');
  await recordAttendanceConfirmationResponse({
    phone,
    text: msg.body || '',
    buttonId: msg.selectedButtonId || msg._data?.selectedButtonId || null,
    messageId: msg.id?._serialized || msg.id || null,
    respondedAt: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date(),
  });
}

async function handleInboundAttendancePollVote(vote) {
  const selectedOption = vote?.selectedOptions?.[0]?.name || '';
  if (!selectedOption) return;

  const phone = await resolveAttendancePollVoterPhone(vote, client);
  const pollMessageId = vote?.parentMsgKey?._serialized
    || vote?.parentMessage?.id?._serialized
    || null;
  if (!phone) {
    console.warn('[WhatsAppWeb] ⚠️ voto de confirmação ignorado: telefone do paciente não resolvido');
    return;
  }

  const { recordAttendanceConfirmationPollVote } = await import('./appointment/attendanceConfirmation.service.js');
  const result = await recordAttendanceConfirmationPollVote({
    phone,
    pollMessageId,
    optionName: selectedOption,
    respondedAt: vote?.interractedAtTs ? new Date(Number(vote.interractedAtTs)) : new Date(),
  });
  if (!result?.matched) {
    console.warn('[WhatsAppWeb] ⚠️ voto recebido, mas nenhum lembrete pendente foi vinculado:', result?.reason || 'desconhecido');
  }
}

// ─── Inicialização ───────────────────────────────────────────────────────────
export async function initWhatsAppClient() {
  console.log(`[WhatsAppWeb] 📂 Auth path: ${authPath}`);

  // 🧨 LIMPEZA DE SESSÃO: definir WHATSAPP_FORCE_CLEAN_SESSION='true' no dashboard.
  const forceCleanRaw = String(process.env.WHATSAPP_FORCE_CLEAN_SESSION || '').toLowerCase();
  const forceClean = ['true', '1', 'yes'].includes(forceCleanRaw);
  console.log(`[WhatsAppWeb][DIAG] FORCE_CLEAN env=${process.env.WHATSAPP_FORCE_CLEAN_SESSION} parsed=${forceClean}`);

  if (forceClean) {
    console.log('[WhatsAppWeb] 🧨 LIMPEZA MANUAL autorizada — removendo sessão...');
    const targets = [
      path.join(authPath, '.wwebjs_auth'),
      path.join(authPath, '.booting'),
      path.join(authPath, '.crash-log.json'),
      path.join(authPath, 'session'),
      path.join(process.cwd(), '.wwebjs_cache'),
    ];
    for (const t of targets) {
      try {
        if (fs.existsSync(t)) {
          fs.rmSync(t, { recursive: true, force: true });
          console.log(`[WhatsAppWeb] 🗑️  Removido: ${t}`);
        }
      } catch (e) {
        console.warn(`[WhatsAppWeb] ⚠️ Não foi possível remover ${t}:`, e.message);
      }
    }
  } else {
    console.log('[WhatsAppWeb] 💾 Sessão preservada — FORCE_CLEAN desativado.');
  }

  if (isReady && client) {
    console.log('[WhatsAppWeb] Já está ready — ignorando init.');
    return;
  }
  if (client) {
    console.log('[WhatsAppWeb] Cliente já existe — não criando outro.');
    return;
  }
  if (isInitializing) {
    console.log('[WhatsAppWeb] Inicialização já em andamento — aguardando.');
    return;
  }

  if (initAttempts >= MAX_INIT_ATTEMPTS) {
    console.log('[WhatsAppWeb] 🔁 Resetando contador de tentativas.');
    initAttempts = 0;
  }

  isInitializing = true;
  initAttempts++;
  console.log(`[WhatsAppWeb] 🚀 Inicializando... (tentativa ${initAttempts}/${MAX_INIT_ATTEMPTS})`);

  // Atualiza estado periodicamente desde o início, não só após ready
  if (stateSaveInterval) clearInterval(stateSaveInterval);
  stateSaveInterval = setInterval(() => saveState(), 30_000);

  // ─── DIAGNÓSTICO COMPLETO ───────────────────────────────────────────────────
  const chromePath = resolveChromePath();
  console.log('[WhatsAppWeb][DIAG] Chrome path resolvido:', chromePath || 'NULL — usando default do puppeteer');
  console.log('[WhatsAppWeb][DIAG] Node.js:', process.version);

  try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const wwebjsPkg = require('whatsapp-web.js/package.json');
    const pupPkg = require('puppeteer-core/package.json');
    console.log('[WhatsAppWeb][DIAG] whatsapp-web.js version:', wwebjsPkg.version, wwebjsPkg.gitHead ? `(git: ${wwebjsPkg.gitHead})` : '');
    console.log('[WhatsAppWeb][DIAG] puppeteer-core version:', pupPkg.version);
  } catch (verErr) {
    console.log('[WhatsAppWeb][DIAG] Não foi possível logar versões:', verErr.message);
  }
  console.log('[WhatsAppWeb][DIAG] CWD:', process.cwd());
  console.log('[WhatsAppWeb][DIAG] Auth path:', authPath);
  console.log('[WhatsAppWeb][DIAG] FORCE_CLEAN:', process.env.WHATSAPP_FORCE_CLEAN_SESSION);
  try {
    const cacheDir = path.join(process.cwd(), '.cache', 'puppeteer', 'chrome');
    if (fs.existsSync(cacheDir)) {
      console.log('[WhatsAppWeb][DIAG] Versões Chrome no cache:', fs.readdirSync(cacheDir).join(', '));
    } else {
      console.log('[WhatsAppWeb][DIAG] Cache puppeteer NÃO existe em:', cacheDir);
    }
  } catch (e) { console.warn('[WhatsAppWeb][DIAG] Erro ao listar cache:', e.message); }
  // ───────────────────────────────────────────────────────────────────────────

  // Remove Chrome singleton lock files deixados por instâncias anteriores (ex: redeploy no Render).
  // Busca recursiva — funciona independente do path exato criado pelo LocalAuth (session vs session-default).
  // Apenas os locks são removidos — a sessão WPP (cookies/auth) é preservada.
  const LOCK_NAMES = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
  function removeSingletonLocks(dir) {
    if (!fs.existsSync(dir)) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          removeSingletonLocks(full);
        } else if (LOCK_NAMES.has(entry.name)) {
          try {
            fs.unlinkSync(full);
            console.log(`[WhatsAppWeb] 🔓 Lock removido: ${full}`);
          } catch (e) {
            console.warn(`[WhatsAppWeb] Aviso ao remover lock ${full}:`, e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[WhatsAppWeb] Erro ao varrer locks:', e.message);
    }
  }
  removeSingletonLocks(authPath);

  connectionStatus = 'initializing';
  await saveState();
  client = createClient();
  clearInitWatchdog();
  initWatchdog = setTimeout(() => {
    initWatchdog = null;
    // Ainda sem qr/loading/authenticated/ready: o Chrome travou na abertura do WhatsApp Web
    if (!isReady && connectionStatus === 'initializing') {
      restartForRecovery(`init travado: sem QR nem conexão em ${Math.round(INIT_TIMEOUT_MS / 1000)}s`);
    }
  }, INIT_TIMEOUT_MS);
  try {
    await client.initialize();
    watchBrowserProcess(client);
    // initialize() resolveu = sessão reconhecida como pareada (senão teria saído QR).
    // Se 'ready' não vier, é a corrida do whatsapp-web.js: o hasSynced já estava
    // true antes do listener 'change:hasSynced' ser registrado. Ver kickSyncedSession.
    startSyncedSessionKick(client);
  } catch (err) {
    clearInitWatchdog();
    const msg = err?.message || String(err);
    console.error('[WhatsAppWeb] Falha na inicialização:', msg);
    console.error('[WhatsAppWeb][DIAG] Stack completo:', err?.stack || 'sem stack');
    connectionStatus = 'error';
    await saveState();
    await safeDestroyClient();

    if (msg.includes('Execution context was destroyed')) {
      console.log('[WhatsAppWeb] ⚠️ Navegação interna do WhatsApp em andamento — retry em 60s.');
      if (retryTimeout) clearTimeout(retryTimeout);
      retryTimeout = setTimeout(() => initWhatsAppClient(), 60_000);
      isInitializing = false;
      return;
    }

    if (msg.includes('Runtime.callFunctionOn timed out') || msg.includes('Protocol timeout')) {
      console.log('[WhatsAppWeb] ⏳ Chromium lento no Render — aguardando 60s antes de retry...');
      if (retryTimeout) clearTimeout(retryTimeout);
      retryTimeout = setTimeout(() => initWhatsAppClient(), 60_000);
      isInitializing = false;
      return;
    }

    const isFatal = msg.includes('Target closed') ||
                    msg.includes('Protocol error') ||
                    msg.includes('Session closed');
    if (isFatal && process.send) {
      console.error('[WhatsAppWeb] 💥 Browser fatal durante init — saindo para respawn limpo.');
      process.exit(1);
    }

    if (retryTimeout) clearTimeout(retryTimeout);
    retryTimeout = setTimeout(() => {
      console.log('[WhatsAppWeb] 🔁 Retry agendado após erro...');
      initWhatsAppClient();
    }, 30_000);
  } finally {
    isInitializing = false;
  }
}

async function safeDestroyClient() {
  if (!client) return;
  if (stateSaveInterval) { clearInterval(stateSaveInterval); stateSaveInterval = null; }
  if (attendancePollSyncInterval) { clearInterval(attendancePollSyncInterval); attendancePollSyncInterval = null; }
  try {
    await client.destroy();
    console.log('[WhatsAppWeb] Cliente destruído para retry.');
  } catch (e) {
    // ignora erro ao destruir
  }
  client = null;
}

// ─── Status ──────────────────────────────────────────────────────────────────
export async function getStatus() {
  // Se o singleton tem dados recentes (< 30s), usa ele (worker ativo)
  if (whatsappState.updatedAt) {
    const age = Date.now() - new Date(whatsappState.updatedAt).getTime();
    if (age < 30_000) {
      return {
        status: whatsappState.status,
        ready: whatsappState.ready,
        authenticated: whatsappState.authenticated,
        qrCode: whatsappState.qrCode,
        lastDisconnectReason: whatsappState.lastDisconnectReason,
        lastAuthenticatedAt: whatsappState.lastAuthenticatedAt,
        qrCount: whatsappState.qrCount,
        initAttempts: whatsappState.initAttempts,
        pid: whatsappState.pid,
        uptime: whatsappState.uptime,
        updatedAt: whatsappState.updatedAt,
        error: null,
      };
    }
  }

  // Fallback: consulta MongoDB (server.js principal ou outros processos)
  try {
    const state = await WhatsAppWebState.findOne({ instanceId: 'main' }).lean();
    if (state) {
      return {
        status: state.status,
        ready: state.ready,
        authenticated: state.authenticated ?? false,
        qrCode: state.qrCode,
        lastDisconnectReason: state.lastDisconnectReason ?? null,
        lastAuthenticatedAt: state.lastAuthenticatedAt ?? null,
        qrCount: state.qrCount ?? 0,
        initAttempts: state.initAttempts ?? 0,
        pid: state.pid ?? null,
        uptime: state.uptime ?? null,
        updatedAt: state.updatedAt ?? null,
        error: null,
      };
    }
  } catch (err) {
    return {
      status: 'error',
      ready: false,
      authenticated: false,
      qrCode: null,
      error: err.message,
    };
  }

  return {
    status: 'unknown',
    ready: false,
    authenticated: false,
    qrCode: null,
    error: null,
  };
}

// ─── Enviar mensagem ─────────────────────────────────────────────────────────
export async function sendMessage(phone, message, options = {}) {
  if (!isReady || !client) {
    throw new Error('WhatsApp não está conectado');
  }
  const clean = normalizeE164BR(phone);
  if (!clean) {
    throw new Error(`Número inválido: ${phone}`);
  }
  console.log(`[WhatsAppWeb] 📤 Enviando para ${clean}...`);
  try {
    const numberId = await client.getNumberId(clean);
    if (!numberId) {
      throw new Error(`Número ${clean} não possui WhatsApp`);
    }
    let result;
    if (options.attendanceConfirmation && options.appointmentId) {
      await client.sendMessage(numberId._serialized, message);
      try {
        if (typeof Poll !== 'function') throw new Error('Poll não disponível nesta versão');
        const poll = new Poll(
          'Confirme sua presença 💚',
          ['Confirmar presença ✅', 'Falar com a recepção'],
          { allowMultipleAnswers: false }
        );
        // waitUntilMsgSent: sem esperar o envio efetivo, a biblioteca devolve
        // `undefined` para criação de enquete e gravávamos 'unknown' no agendamento.
        result = await client.sendMessage(numberId._serialized, poll, { waitUntilMsgSent: true });
      } catch (pollError) {
        console.warn('[WhatsAppWeb] ⚠️ Opções clicáveis indisponíveis; enviando fallback em texto:', pollError.message);
        result = await client.sendMessage(numberId._serialized, `Responda:\n*1* — Confirmar presença\n*2* — Falar com a recepção`, { waitUntilMsgSent: true });
      }
    } else {
      result = await client.sendMessage(numberId._serialized, message, { waitUntilMsgSent: true });
    }
    // `null` (e não 'unknown'): um ID falso faz o voto da enquete casar com nada e
    // some com o registro em silêncio. Sem ID, o serviço cai no fallback por telefone.
    const messageId = result?.id?._serialized || null;
    console.log(`[WhatsAppWeb] ✅ Enviado para ${clean} — ID: ${messageId || 'sem id (fallback por telefone ativo)'}`);
    return { success: true, messageId };
  } catch (err) {
    console.error(`[WhatsAppWeb] ❌ Erro ao enviar para ${clean}:`, err.message);
    throw err;
  }
}

// ─── Soft reconnect (recovery automático — preserva sessão no MongoDB) ────────
export async function softReconnect() {
  console.log('[WhatsAppWeb] 🔄 Soft reconnect — preservando sessão no MongoDB...');
  isReady = false;
  whatsappState.ready = false;
  whatsappState.status = 'reconnecting';
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }

  if (client) {
    try { await client.destroy(); } catch {}
    client = null;
  }

  await saveState();
  await initWhatsAppClient();
}

// ─── Limpa sessão (botão "Desconectar" — apaga sessão local) ─────────────
export async function clearSession() {
  console.log('[WhatsAppWeb] 🧹 Limpando sessão...');

  whatsappState.status = 'disconnected';
  whatsappState.ready = false;
  whatsappState.authenticated = false;
  whatsappState.qrCode = null;
  whatsappState.lastDisconnectReason = null;
  whatsappState.lastAuthenticatedAt = null;
  whatsappState.qrCount = 0;
  updateState({});

  try {
    await WhatsAppWebState.findOneAndUpdate(
      { instanceId: 'main' },
      { status: 'disconnected', ready: false, qrCode: null, pid: null, uptime: null, reconnectSignal: new Date(), updatedAt: new Date() },
      { upsert: true }
    );
    console.log('[WhatsAppWeb] Estado limpo no MongoDB + sinal de reconexão gravado.');
  } catch (e) {
    console.warn('[WhatsAppWeb] Erro ao limpar estado MongoDB:', e.message);
  }

  // Remove sessão local do LocalAuth
  try {
    const localAuthDir = path.join(authPath, '.wwebjs_auth');
    if (fs.existsSync(localAuthDir)) {
      fs.rmSync(localAuthDir, { recursive: true, force: true });
      console.log('[WhatsAppWeb] Sessão local removida.');
    }
  } catch (e) {
    console.warn('[WhatsAppWeb] Erro ao remover sessão local:', e.message);
  }

  return { success: true, message: 'Sessão limpa. Reinicie o worker do WhatsApp para gerar novo QR.' };
}

// ─── Reconectar manual (botão "Gerar novo QR") ───────────────────────────────
// Reinicia o Chrome PRESERVANDO a sessão: se ela ainda vale, reconecta sozinho
// (sem QR); se o WhatsApp a rejeitar, o próprio whatsapp-web.js mostra QR novo.
// Antes chamava initWhatsAppClient(), que não fazia nada enquanto o init
// anterior estivesse travado (isInitializing) — o botão ficava sem efeito.
export async function reconnect() {
  console.log('[WhatsAppWeb] 🔄 Reconnect manual — reiniciando Chrome (sessão preservada)...');
  qrCodeDataUrl = null;
  initAttempts = 0;
  whatsappState.ready = false;
  whatsappState.qrCode = null;
  whatsappState.qrCount = 0;
  await restartForRecovery('reconexão manual (botão Gerar novo QR)');
  return { success: true, message: 'Reconectando... se pedir, escaneie o novo QR.' };
}

// ─── Sinal externo de reconexão (backend → worker via MongoDB) ───────────────
// Chamado pelo heartbeat do child a cada 5s. Se o backend gravou um novo
// reconnectSignal (via clearSession), o worker detecta e chama reconnect().
let _lastReconnectSignal = null;

export async function checkExternalReconnectSignal() {
  // Não bloqueia em isInitializing: é justamente quando o init trava que o botão precisa agir.
  if (isReady) return;
  try {
    const state = await WhatsAppWebState.findOne({ instanceId: 'main' }).select('reconnectSignal').lean();
    if (!state?.reconnectSignal) return;
    const signal = new Date(state.reconnectSignal).getTime();
    if (_lastReconnectSignal === null) {
      _lastReconnectSignal = signal;
      return;
    }
    if (signal > _lastReconnectSignal) {
      _lastReconnectSignal = signal;
      console.log('[WhatsAppWeb] 🔔 Sinal de reconexão externo detectado — gerando novo QR...');
      await reconnect();
    }
  } catch (e) {
    // ignora erros de leitura
  }
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────
export async function gracefulShutdownWhatsApp() {
  console.log('[WhatsAppWeb] 🛑 Graceful shutdown...');
  if (client) {
    try {
      await client.destroy();
      console.log('[WhatsAppWeb] ✅ Cliente destruído.');
    } catch (err) {
      console.warn('[WhatsAppWeb] Erro ao destruir:', err.message);
    }
  }
}

export default {
  initWhatsAppClient,
  getStatus,
  sendMessage,
  reconnect,
  softReconnect,
  clearSession,
  checkExternalReconnectSignal,
  gracefulShutdownWhatsApp,
};
