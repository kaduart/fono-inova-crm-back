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
function createClient() {
  // Garante pasta de persistência
  try {
    if (!fs.existsSync(authPath)) {
      fs.mkdirSync(authPath, { recursive: true });
    }
  } catch (e) {
    console.warn('[WhatsAppWeb] Não foi possível criar authPath:', e.message);
  }

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
    await saveState();
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

// ─── Inicialização ───────────────────────────────────────────────────────────
export async function initWhatsAppClient() {
  console.log(`[WhatsAppWeb] 📂 Auth path: ${authPath}`);

  // 🧨 LIMPEZA DE SESSÃO DESATIVADA por padrão — sessão deve persistir no disco.
  // Para forçar limpeza manual: definir WHATSAPP_FORCE_CLEAN_SESSION='true' E WHATSAPP_ALLOW_CLEAN='true'
  if (process.env.WHATSAPP_FORCE_CLEAN_SESSION === 'true' && process.env.WHATSAPP_ALLOW_CLEAN === 'true') {
    console.log('[WhatsAppWeb] 🧨 LIMPEZA MANUAL autorizada — removendo sessão...');
    const targets = [
      path.join(authPath, '.wwebjs_auth'),
      path.join(authPath, '.booting'),
      path.join(authPath, '.crash-log.json'),
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
  // Apenas os locks são removidos — a sessão WPP (cookies/auth) é preservada.
  const lockFiles = [
    path.join(authPath, '.wwebjs_auth', 'session-default', 'SingletonLock'),
    path.join(authPath, '.wwebjs_auth', 'session-default', 'SingletonCookie'),
    path.join(authPath, '.wwebjs_auth', 'session-default', 'SingletonSocket'),
  ];
  for (const lockFile of lockFiles) {
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
        console.log(`[WhatsAppWeb] 🔓 Lock file removido: ${lockFile}`);
      }
    } catch (e) {
      console.warn(`[WhatsAppWeb] Aviso ao remover lock file ${lockFile}:`, e.message);
    }
  }

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
    if (!numberId) {
      throw new Error(`Número ${clean} não possui WhatsApp`);
    }
    const result = await client.sendMessage(numberId._serialized, message);
    console.log(`[WhatsAppWeb] ✅ Enviado para ${clean} — ID: ${result?.id?._serialized || 'unknown'}`);
    return { success: true, messageId: result.id._serialized };
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
