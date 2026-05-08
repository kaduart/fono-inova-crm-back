/**
 * 💬 Serviço WhatsApp Web.js — versão MÍNIMA e estável
 *
 * Regra de ouro: NÃO tente "salvar" o sistema. Deixe o WhatsApp Web.js
 * trabalhar sozinho. Só inicializa, ouve eventos, e reinicia suave se cair.
 *
 * ZERO purge automático
 * ZERO stuck detection
 * ZERO force ready
 * ZERO reconnect storm
 * TIMEOUTS altos
 */

import './setPuppeteerCache.js';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import mongoose from 'mongoose';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import WhatsAppWebState from '../models/WhatsAppWebState.js';

// ─── Estado simples ──────────────────────────────────────────────────────────
let client = null;
let isReady = false;
let qrCodeDataUrl = null;
let connectionStatus = 'waiting_mongo';
let isInitializing = false;
let retryTimeout = null;
let initAttempts = 0;
const MAX_INIT_ATTEMPTS = 10;
let clientInstanceId = 0; // incremental para detectar client stale

// ─── Persistência MongoDB ────────────────────────────────────────────────────
async function saveState() {
  try {
    await WhatsAppWebState.findOneAndUpdate(
      { instanceId: 'main' },
      {
        status: connectionStatus,
        ready: isReady,
        qrCode: qrCodeDataUrl,
        pid: process.pid,
        uptime: process.uptime(),
        updatedAt: new Date(),
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('[WhatsAppWeb] Erro ao salvar estado:', err.message);
  }
}

// ─── Resolve caminho do Chrome ───────────────────────────────────────────────
function resolveChromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// ─── Criação do cliente ─────────────────────────────────────────────────────
function createClient() {
  const authPath = '/var/data/wwebjs_auth';
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

  // Limpa locks do Chromium de sessões anteriores que morreram sem cleanup
  const locks = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  for (const lock of locks) {
    const lockPath = path.join(authPath, lock);
    try {
      if (fs.existsSync(lockPath)) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        console.log(`[WhatsAppWeb] Lock removido: ${lock}`);
      }
    } catch (e) {
      // ignora erro ao remover lock
    }
  }

  const puppeteerOpts = {
    headless: true,
    protocolTimeout: 300_000, // 5 min — protocolo CDP
    handleSIGINT: false,      // NÃO deixa Puppeteer capturar sinais
    handleSIGTERM: false,     // Render mata o processo naturalmente
    handleSIGHUP: false,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',          // 🔥 ESSENCIAL pro plano Starter (512MB RAM)
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-breakpad',
        '--disable-component-update',
        '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess,InterestFeedContentSuggestions,MediaRouter,TranslateUI',
        '--disable-site-isolation-trials',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--password-store=basic',
        '--use-mock-keychain',
      ],
  };

  const chromePath = resolveChromePath();
  if (chromePath) {
    puppeteerOpts.executablePath = chromePath;
    console.log(`[WhatsAppWeb] Usando Chrome: ${chromePath}`);
  }

  const newClient = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    authTimeoutMs: 300_000, // 5 min — QR pode demorar pra escanear no Render
    takeoverOnConflict: true, // Se houver outra sessão ativa, toma controle
    takeoverTimeoutMs: 30_000,
    restartOnAuthFail: false, // NÃO reinicia sozinho em falha de auth
    qrMaxRetries: 0,          // SEM retry de QR (evita loop)
    puppeteer: puppeteerOpts,
  });

  // ─── Eventos básicos ─────────────────────────────────────────────────────
  newClient.on('qr', async (qr) => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] 📡 qr gerado — escaneie com o celular`);
    connectionStatus = 'qr';
    try {
      qrCodeDataUrl = await qrcode.toDataURL(qr);
      // Salva QR como PNG local para facilitar scan
      const base64Data = qrCodeDataUrl.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(path.resolve(process.cwd(), 'qr-code.png'), Buffer.from(base64Data, 'base64'));
      await saveState();
    } catch (err) {
      console.error('[WhatsAppWeb] Erro ao gerar QR:', err.message);
    }
  });

  newClient.on('authenticated', async () => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] 🔐 authenticated — celular escaneou o QR`);
    connectionStatus = 'connecting';
    await saveState();
  });

  newClient.on('ready', async () => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] ✅ ready — WhatsApp conectado!`);
    isReady = true;
    qrCodeDataUrl = null;
    connectionStatus = 'ready';
    initAttempts = 0; // zera contador de tentativas
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
    await saveState();
  });

  newClient.on('loading_screen', (percent, message) => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] ⏳ loading_screen ${percent}% — ${message}`);
  });

  newClient.on('disconnected', async (reason) => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] 🔴 disconnected: ${reason}`);
    isReady = false;
    connectionStatus = 'disconnected';
    await saveState();
    // NÃO reinicializa aqui. Deixa o processo morrer e o Render reiniciar.
  });

  newClient.on('error', (err) => {
    console.error('[WhatsAppWeb] ❌ error:', err.message);
  });

  return newClient;
}

// ─── Inicialização ───────────────────────────────────────────────────────────
export async function initWhatsAppClient() {
  // BLOQUEIO FORTE: se já está ready e com client válido, NUNCA re-inicializa
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

  // Se atingiu limite, reseta contador para tentar de novo
  if (initAttempts >= MAX_INIT_ATTEMPTS) {
    console.log('[WhatsAppWeb] 🔁 Resetando contador de tentativas.');
    initAttempts = 0;
  }

  // Limpa locks do Chromium de sessões anteriores que morreram sem cleanup
  const authPath = '/var/data/wwebjs_auth';
  try {
    if (fs.existsSync(authPath)) {
      let hasLock = false;
      // Busca recursiva por arquivos de lock
      function scan(dir) {
        for (const entry of fs.readdirSync(dir)) {
          const full = path.join(dir, entry);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            scan(full);
          } else if (['SingletonLock', 'SingletonSocket', 'SingletonCookie'].includes(entry)) {
            hasLock = true;
            fs.rmSync(full, { force: true });
            console.log(`[WhatsAppWeb] Lock removido: ${full}`);
          }
        }
      }
      scan(authPath);
      if (hasLock) {
        console.log('[WhatsAppWeb] Locks antigos limpos — sessão preservada.');
      }
    }
  } catch (e) {
    console.warn('[WhatsAppWeb] Não foi possível limpar locks:', e.message);
  }
  isInitializing = true;
  initAttempts++;
  console.log(`[WhatsAppWeb] 🚀 Inicializando... (tentativa ${initAttempts}/${MAX_INIT_ATTEMPTS})`);
  connectionStatus = 'initializing';
  await saveState();
  client = createClient();
  try {
    await client.initialize();
  } catch (err) {
    console.error('[WhatsAppWeb] Falha na inicialização:', err.message || err);
    connectionStatus = 'error';
    await saveState();
    // Destrói client e agenda retry em 30s
    await safeDestroyClient();
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
  try {
    const persist = (() => {
      try {
        const authPath = '/var/data/wwebjs_auth';
        if (!fs.existsSync(authPath)) return { exists: false, count: 0 };
        return { exists: true, count: fs.readdirSync(authPath).length };
      } catch (e) {
        return { exists: false, count: 0 };
      }
    })();

    if (client || connectionStatus !== 'waiting_mongo') {
      return {
        status: connectionStatus,
        ready: isReady,
        qrCode: qrCodeDataUrl,
        error: null,
        sessionPersisted: persist.exists && persist.count > 0,
        sessionFiles: persist.count,
        pid: process.pid,
        uptime: process.uptime(),
      };
    }

    const state = await WhatsAppWebState.findOne({ instanceId: 'main' }).lean();
    if (state) {
      return {
        status: state.status,
        ready: state.ready,
        qrCode: state.qrCode,
        error: state.error,
        sessionPersisted: null,
        pid: state.pid ?? null,
        uptime: state.uptime ?? null,
      };
    }
    return { status: 'unknown', ready: false, qrCode: null, error: null };
  } catch (err) {
    return { status: 'error', ready: false, qrCode: null, error: err.message };
  }
}

// ─── Enviar mensagem ─────────────────────────────────────────────────────────
export async function sendMessage(phone, message) {
  if (!isReady || !client) {
    throw new Error('WhatsApp não está conectado');
  }
  const chatId = phone.replace(/\D/g, '') + '@c.us';
  try {
    const result = await client.sendMessage(chatId, message);
    return { success: true, messageId: result.id._serialized };
  } catch (err) {
    console.error('[WhatsAppWeb] Erro ao enviar:', err.message);
    // ❌ NUNCA reinicia/reconnecta WhatsApp por erro de envio.
    // Lifecycle é responsabilidade do child process (crash/restart).
    throw err;
  }
}

// ─── Soft reconnect (recovery automático — NÃO limpa sessão) ─────────────────
export async function softReconnect() {
  console.log('[WhatsAppWeb] 🔄 Soft reconnect — preservando sessão...');
  isReady = false;
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }

  if (client) {
    try { await client.destroy(); } catch {}
    client = null;
  }

  await saveState();
  // NÃO limpa /var/data/wwebjs_auth — sessão é preservada
  await initWhatsAppClient();
}

// ─── Limpa sessão (usado pela API web — NÃO toca no client) ──────────────────
export async function clearSession() {
  console.log('[WhatsAppWeb] 🧹 Limpando sessão (API web)...');

  // Limpa estado no MongoDB
  try {
    await WhatsAppWebState.findOneAndUpdate(
      { instanceId: 'main' },
      { status: 'disconnected', ready: false, qrCode: null, pid: null, uptime: null, updatedAt: new Date() },
      { upsert: true }
    );
    console.log('[WhatsAppWeb] Estado limpo no MongoDB.');
  } catch (e) {
    console.warn('[WhatsAppWeb] Erro ao limpar MongoDB:', e.message);
  }

  // Limpa sessão local
  try {
    const authPath = '/var/data/wwebjs_auth';
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('[WhatsAppWeb] Sessão local removida.');
    }
  } catch (e) {
    console.warn('[WhatsAppWeb] Não foi possível remover sessão:', e.message);
  }

  return { success: true, message: 'Sessão limpa. Reinicie o worker do WhatsApp para gerar novo QR.' };
}

// ─── Reconectar manual (botão "Gerar novo QR") ───────────────────────────────
export async function reconnect() {
  console.log('[WhatsAppWeb] 🔄 Reconnect manual — limpando sessão...');
  isReady = false;
  qrCodeDataUrl = null;
  connectionStatus = 'initializing';
  initAttempts = 0;
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }

  if (client) {
    try { await client.destroy(); } catch {}
    client = null;
  }

  // Limpa sessão local
  try {
    const authPath = '/var/data/wwebjs_auth';
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('[WhatsAppWeb] Sessão local removida.');
    }
  } catch (e) {
    console.warn('[WhatsAppWeb] Não foi possível remover sessão:', e.message);
  }

  await saveState();
  await initWhatsAppClient();
  return { success: true, message: 'Reconectando... Escaneie o novo QR.' };
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
  gracefulShutdownWhatsApp,
};
