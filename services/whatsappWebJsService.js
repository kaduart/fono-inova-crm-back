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

// ─── Persistência MongoDB ────────────────────────────────────────────────────
async function saveState() {
  try {
    await WhatsAppWebState.findOneAndUpdate(
      { instanceId: 'main' },
      {
        status: connectionStatus,
        ready: isReady,
        qrCode: qrCodeDataUrl,
        updatedAt: new Date(),
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('[WhatsAppWeb] Erro ao salvar estado:', err.message);
  }
}

// ─── Criação do cliente ─────────────────────────────────────────────────────
function createClient() {
  const authPath = path.resolve(process.cwd(), '.wwebjs_auth');
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

  const newClient = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    authTimeoutMs: 300_000, // 5 min — QR pode demorar pra escanear no Render
    takeoverOnConflict: true, // Se houver outra sessão ativa, toma controle
    takeoverTimeoutMs: 30_000,
    puppeteer: {
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
        '--single-process',          // 🔥 essencial pra 512MB
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
    },
  });

  // ─── Eventos básicos ─────────────────────────────────────────────────────
  newClient.on('qr', async (qr) => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] 📡 qr gerado — escaneie com o celular`);
    connectionStatus = 'qr';
    try {
      qrCodeDataUrl = await qrcode.toDataURL(qr);
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
  if (client) {
    console.log('[WhatsAppWeb] Cliente já existe — não criando outro.');
    return;
  }
  if (isInitializing) {
    console.log('[WhatsAppWeb] Inicialização já em andamento — aguardando.');
    return;
  }
  if (initAttempts >= MAX_INIT_ATTEMPTS) {
    console.log('[WhatsAppWeb] 🚫 Limite de tentativas atingido. Pare o serviço e verifique.');
    connectionStatus = 'max_retries_reached';
    await saveState();
    return;
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
        const authPath = path.resolve(process.cwd(), '.wwebjs_auth');
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
        pid: null,
        uptime: null,
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
    throw err;
  }
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
    const authPath = path.resolve(process.cwd(), '.wwebjs_auth');
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
  gracefulShutdownWhatsApp,
};
