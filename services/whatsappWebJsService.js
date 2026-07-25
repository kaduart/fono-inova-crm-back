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
const { Client, LocalAuth } = pkg;
import { MongoStore } from 'wwebjs-mongo';
import mongoose from 'mongoose';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { normalizeE164BR } from '../utils/phone.js';
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
let readyPollInterval = null;
let stateSaveInterval = null;

function updateState(updates) {
  Object.assign(whatsappState, updates, { updatedAt: new Date().toISOString() });
}

function getSessionStorageInfo() {
  try {
    const du = execSync(`du -sb ${authPath} 2>/dev/null || echo 0`).toString().trim();
    const bytes = parseInt(du.split(/\s+/)[0], 10) || 0;
    const sessionSizeMB = parseFloat((bytes / 1024 / 1024).toFixed(2));

    const df = execSync(`df -h ${authPath} 2>/dev/null || echo ''`).toString().trim();
    const dfLine = df.split('\n')[1];
    let diskUsagePercent = null;
    if (dfLine) {
      const match = dfLine.match(/(\d+)%/);
      if (match) diskUsagePercent = parseInt(match[1], 10);
    }
    return { sessionSizeMB, diskUsagePercent };
  } catch (e) {
    console.warn('[WhatsAppWeb] Não foi possível obter storage:', e.message);
    return { sessionSizeMB: null, diskUsagePercent: null };
  }
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
  const { sessionSizeMB, diskUsagePercent } = getSessionStorageInfo();
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
        sessionSizeMB,
        diskUsagePercent,
        updatedAt: new Date(),
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('[WhatsAppWeb] Erro ao salvar estado:', err.message);
  }
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
      }
    } catch (e) {
      // ainda não está pronto — ignora
    }
  }, 10_000);
}

// ─── Resolve caminho do Chrome ───────────────────────────────────────────────
function resolveChromePath() {
  // 1. Variável de ambiente explícita
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Cache do puppeteer no projeto (.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome)
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

  // 3. Chrome instalado via @puppeteer/browsers (novo path do Render)
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

  // 4. Caminhos do sistema
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
    const threshold = parseFloat(process.env.WHATSAPP_CACHE_CLEANUP_THRESHOLD_MB || '400');

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

  // Diagnóstico de armazenamento
  try {
    const du = execSync(`du -sh ${authPath} 2>/dev/null || echo 'unknown'`).toString().trim();
    const df = execSync(`df -h ${authPath} 2>/dev/null || echo 'unknown'`).toString().trim();
    console.log(`[WhatsAppWeb][DIAG] Storage — sessão: ${du}`);
    console.log(`[WhatsAppWeb][DIAG] Storage — disco:\n${df}`);
  } catch (e) {
    console.warn('[WhatsAppWeb][DIAG] Não foi possível verificar storage:', e.message);
  }

  // Limpeza preventiva de caches temporários do Chrome (mantém IndexedDB/auth)
  cleanupChromeCacheIfNeeded();

  const puppeteerOpts = {
    headless: 'new',
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
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
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

    // Atualiza estado periodicamente (storage, uptime) mesmo sem eventos
    if (stateSaveInterval) clearInterval(stateSaveInterval);
    stateSaveInterval = setInterval(() => saveState(), 30_000);

    // Captura erros e logs do WhatsApp Web no browser (filtra ruído conhecido)
    if (newClient.pupPage) {
      try {
        const IGNORED_PAGE_ERRORS = [
          'IDBObjectStore',
          'DataError',
          'QuotaExceededError',
          'deidentified_telemetry',
          'dit.whatsapp.net',
        ];
        newClient.pupPage.on('pageerror', (err) => {
          const msg = err?.message || String(err);
          if (IGNORED_PAGE_ERRORS.some((x) => msg.includes(x))) {
            return;
          }
          console.error('[WhatsAppWeb][BROWSER PAGEERROR]', msg);
        });
        newClient.pupPage.on('console', (msg) => {
          const text = msg.text();
          if (msg.type() === 'error' && text.includes('deidentified_telemetry')) {
            return;
          }
          console.log(`[WhatsAppWeb][BROWSER CONSOLE ${msg.type()}]`, text);
        });
        console.log('[WhatsAppWeb][DIAG] Listeners de pageerror/console registrados.');
      } catch (e) {
        console.warn('[WhatsAppWeb][DIAG] Não foi possível registrar listeners do Puppeteer:', e.message);
      }
    }

    await saveState();

    // Monitoramento de storage para prevenir IndexedDB lotado/corrompido
    startStorageMonitor();

    if (process.send) {
      process.send({ type: 'whatsapp_ready' });
    }
  });

  newClient.on('loading_screen', async (percent, message) => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] ⏳ loading_screen ${percent}% — ${message}`);
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

  return newClient;
}

// ─── Monitoramento de storage (prevenção IndexedDB lotado) ─────────────────────
function checkStorageHealth() {
  try {
    const du = execSync(`du -sh ${authPath} 2>/dev/null || echo 'unknown'`).toString().trim();
    const df = execSync(`df -h ${authPath} 2>/dev/null || echo 'unknown'`).toString().trim();
    console.log(`[WhatsAppWeb][DIAG] Storage check — sessão: ${du}`);
    console.log(`[WhatsAppWeb][DIAG] Storage check — disco:\n${df}`);

    const dfLine = df.split('\n')[1];
    if (dfLine) {
      const useMatch = dfLine.match(/(\d+)%/);
      if (useMatch) {
        const usePct = parseInt(useMatch[1], 10);
        if (usePct > 80) {
          console.warn(`[WhatsAppWeb][ALERTA] Disco /var/data acima de 80%: ${usePct}%. Considere limpar a sessão (WHATSAPP_FORCE_CLEAN_SESSION=true) ou aumentar o disco.`);
        }
      }
    }
  } catch (e) {
    console.warn('[WhatsAppWeb][DIAG] Não foi possível verificar storage:', e.message);
  }
}

function startStorageMonitor() {
  checkStorageHealth();
  const interval = 60 * 60 * 1000; // a cada 1 hora
  setInterval(checkStorageHealth, interval);
  console.log(`[WhatsAppWeb][DIAG] Monitoramento de storage iniciado (a cada ${interval / 60000}min).`);
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
  try {
    await client.initialize();
  } catch (err) {
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

// ─── Diagnóstico direto no page.evaluate ─────────────────────────────────────
async function diagnosticGetChatById(chatId) {
  return client.pupPage.evaluate(async (chatId) => {
    try {
      const chat = await window.WWebJS.getChat(chatId);
      return { ok: true, chat };
    } catch (e) {
      return {
        ok: false,
        error: {
          message: e?.message,
          name: e?.name,
          stack: e?.stack,
          constructor: e?.constructor?.name,
          keys: e ? Object.keys(e) : [],
          raw: e ? JSON.stringify(e) : null,
        },
      };
    }
  }, chatId);
}

async function diagnosticSendMessage(chatId, content) {
  return client.pupPage.evaluate(async (chatId, content) => {
    try {
      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat) {
        return { ok: false, error: { message: 'Chat not found in window.WWebJS.getChat' } };
      }
      await window.WWebJS.sendSeen(chatId);
      const msg = await window.WWebJS.sendMessage(chat, content, {});
      return { ok: true, msgId: msg?.id?._serialized };
    } catch (e) {
      return {
        ok: false,
        error: {
          message: e?.message,
          name: e?.name,
          stack: e?.stack,
          constructor: e?.constructor?.name,
          keys: e ? Object.keys(e) : [],
          raw: e ? JSON.stringify(e) : null,
        },
      };
    }
  }, chatId, content);
}

// ─── Enviar mensagem ─────────────────────────────────────────────────────────
export async function sendMessage(phone, message) {
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
    console.log(`[WhatsAppWeb][DIAG] getNumberId(${clean}):`, JSON.stringify(numberId));

    // Se o WhatsApp retornou LID, resolvemos o PN associado.
    // O PN é o endereço que o WhatsApp consegue usar para envio, mesmo que
    // os dígitos pareçam divergentes do número cadastrado no CRM.
    let chatId;
    if (numberId?._serialized?.endsWith('@lid')) {
      try {
        const lidAndPhone = await client.getContactLidAndPhone([numberId._serialized]);
        console.log(`[WhatsAppWeb][DIAG] getContactLidAndPhone:`, JSON.stringify(lidAndPhone));
        const pn = lidAndPhone?.[0]?.pn;
        if (pn) {
          chatId = pn;
          console.log(`[WhatsAppWeb][DIAG] LID detectado; usando PN resolvido: ${chatId}`);
        } else {
          throw new Error(`LID encontrado (${numberId._serialized}) mas PN não resolvido`);
        }
      } catch (lidErr) {
        throw new Error(`Falha ao resolver PN para LID ${numberId._serialized}: ${lidErr?.message}`);
      }
    } else if (numberId?._serialized) {
      chatId = numberId._serialized;
      console.log(`[WhatsAppWeb][DIAG] Usando id resolvido pelo WhatsApp: ${chatId}`);
    } else {
      chatId = `${clean}@c.us`;
      console.log(`[WhatsAppWeb][DIAG] getNumberId não retornou id; usando fallback: ${chatId}`);
    }

    console.log(`[WhatsAppWeb][DIAG] Destino final escolhido: ${chatId}`);

    // Instrumentação: verifica estado do cliente, store e contato antes de enviar
    try {
      console.log(`[WhatsAppWeb][DIAG] Client state:`, await client.getState());
      console.log(`[WhatsAppWeb][DIAG] Client info:`, JSON.stringify(client.info));
    } catch (infoErr) {
      console.log(`[WhatsAppWeb][DIAG] Não foi possível logar client state/info:`, infoErr?.message);
    }

    try {
      const chats = await client.getChats();
      console.log(`[WhatsAppWeb][DIAG] getChats():`, { count: chats.length, sample: chats.slice(0, 3).map(c => c.id?._serialized) });
    } catch (chatsErr) {
      console.error(`[WhatsAppWeb][DIAG] getChats() falhou:`, {
        message: chatsErr?.message,
        name: chatsErr?.name,
        stack: chatsErr?.stack,
        raw: chatsErr ? JSON.stringify(chatsErr) : null,
      });
    }

    try {
      const contact = await client.getContactById(chatId);
      console.log(`[WhatsAppWeb][DIAG] getContactById(${chatId}):`, {
        id: contact?.id?._serialized,
        number: contact?.number,
        isBusiness: contact?.isBusiness,
        name: contact?.name,
      });
    } catch (contactErr) {
      console.error(`[WhatsAppWeb][DIAG] getContactById(${chatId}) falhou:`, {
        message: contactErr?.message,
        name: contactErr?.name,
        stack: contactErr?.stack,
        raw: contactErr ? JSON.stringify(contactErr) : null,
      });
    }

    try {
      console.log(`[WhatsAppWeb][DIAG] Verificando chat ${chatId}...`);
      const chatDiag = await diagnosticGetChatById(chatId);
      console.log(`[WhatsAppWeb][DIAG] diagnosticGetChatById:`, chatDiag);
    } catch (chatErr) {
      console.error(`[WhatsAppWeb][DIAG] diagnosticGetChatById(${chatId}) falhou:`, {
        message: chatErr?.message,
        name: chatErr?.name,
        stack: chatErr?.stack,
        raw: chatErr ? JSON.stringify(chatErr) : null,
      });
    }

    const result = await diagnosticSendMessage(chatId, message);
    if (!result.ok) {
      throw new Error(`diagnosticSendMessage falhou: ${JSON.stringify(result.error)}`);
    }
    const messageId = result.msgId || 'unknown';
    console.log(`[WhatsAppWeb] ✅ Enviado para ${clean} via ${chatId} — ID: ${messageId}`);
    return { success: true, messageId, chatId };
  } catch (err) {
    const diagnostic = {
      phone: clean,
      originalPhone: phone,
      message: err?.message,
      name: err?.name,
      stack: err?.stack,
      raw: err ? JSON.stringify(err) : null,
    };
    console.error(`[WhatsAppWeb] ❌ Erro ao enviar para ${clean}:`, diagnostic);
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
export async function reconnect() {
  console.log('[WhatsAppWeb] 🔄 Reconnect manual — limpando sessão local...');
  isReady = false;
  qrCodeDataUrl = null;
  connectionStatus = 'initializing';
  initAttempts = 0;
  whatsappState.ready = false;
  whatsappState.authenticated = false;
  whatsappState.qrCode = null;
  whatsappState.qrCount = 0;
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }

  if (client) {
    try { await client.destroy(); } catch {}
    client = null;
  }

  // Remove sessão local para forçar novo QR
  try {
    const localAuthDir = path.join(authPath, '.wwebjs_auth');
    if (fs.existsSync(localAuthDir)) {
      fs.rmSync(localAuthDir, { recursive: true, force: true });
      console.log('[WhatsAppWeb] Sessão local removida — próximo boot gerará novo QR.');
    }
  } catch (e) {
    console.warn('[WhatsAppWeb] Erro ao remover sessão local:', e.message);
  }

  await saveState();
  await initWhatsAppClient();
  return { success: true, message: 'Reconectando... Escaneie o novo QR.' };
}

// ─── Sinal externo de reconexão (backend → worker via MongoDB) ───────────────
// Chamado pelo heartbeat do child a cada 5s. Se o backend gravou um novo
// reconnectSignal (via clearSession), o worker detecta e chama reconnect().
let _lastReconnectSignal = null;

export async function checkExternalReconnectSignal() {
  if (isReady || isInitializing) return;
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
