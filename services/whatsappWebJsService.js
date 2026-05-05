/**
 * 🟢 Serviço WhatsApp Web.js (produção — RemoteAuth + MongoDB)
 *
 * Conecta diretamente ao WhatsApp Web usando o chip/celular do usuário.
 * Persiste sessão no MongoDB (GridFS) via RemoteAuth → sobrevive restart/deploy.
 * Fila de envio com delay humano (anti-ban).
 * Reconexão automática com backoff exponencial.
 */

import pkg from 'whatsapp-web.js';
const { Client, RemoteAuth } = pkg;
import { MongoStore } from 'wwebjs-mongo';
import mongoose from 'mongoose';
import puppeteer from 'puppeteer';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';

// 🔒 Blindagem Render: garante que o Puppeteer saiba onde está o cache do Chrome
process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';

// ─── Singleton & Estado ─────────────────────────────────────────────────────
let client = null;
let isReady = false;
let qrCodeDataUrl = null;
let lastError = null;
let connectionStatus = 'waiting_mongo'; // waiting_mongo, initializing, qr, ready, error, disconnected
let reconnectRetries = 0;
let mongoStore = null;
let initRequested = false;

// ─── Fila de mensagens (anti-ban) ───────────────────────────────────────────
const messageQueue = [];
let isProcessingQueue = false;

// ─── Helpers ────────────────────────────────────────────────────────────────
function resolveChromePath() {
  try {
    const puppeteerPath = puppeteer.executablePath();
    if (fs.existsSync(puppeteerPath)) {
      console.log('[WhatsAppWeb] Chrome encontrado no cache do Puppeteer:', puppeteerPath);
      return puppeteerPath;
    }
  } catch { /* ignora */ }

  const systemPaths = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/chrome',
    '/opt/google/chrome/google-chrome',
    '/opt/google/chrome/chrome',
    '/snap/bin/chromium',
  ];

  for (const p of systemPaths) {
    if (fs.existsSync(p)) {
      console.log('[WhatsAppWeb] Chrome encontrado no sistema:', p);
      return p;
    }
  }

  console.log('[WhatsAppWeb] Chrome não encontrado em nenhum caminho conhecido.');
  return null;
}

function buildPuppeteerOptions() {
  const chromePath = resolveChromePath();
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  };
  if (chromePath) opts.executablePath = chromePath;
  return opts;
}

// ─── Inicialização do Cliente ───────────────────────────────────────────────
function createClient() {
  if (!mongoStore) {
    mongoStore = new MongoStore({ mongoose });
  }

  // RemoteAuth extrai o zip para o filesystem antes de carregar — garante pasta
  const authPath = path.resolve(process.cwd(), '.wwebjs_auth');
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  const newClient = new Client({
    authStrategy: new RemoteAuth({
      store: mongoStore,
      backupSyncIntervalMs: 300_000, // salva sessão a cada 5 min
    }),
    puppeteer: buildPuppeteerOptions(),
  });

  // QR
  newClient.on('qr', async (qr) => {
    console.log('[WhatsAppWeb] QR Code gerado. Escaneie com o celular.');
    connectionStatus = 'qr';
    try {
      qrCodeDataUrl = await qrcode.toDataURL(qr);
    } catch (err) {
      console.error('[WhatsAppWeb] Erro ao gerar QR:', err.message);
    }
  });

  // Ready
  newClient.on('ready', () => {
    console.log('[WhatsAppWeb] ✅ Cliente pronto!');
    isReady = true;
    reconnectRetries = 0;
    qrCodeDataUrl = null;
    connectionStatus = 'ready';
    lastError = null;
  });

  // Authenticated
  newClient.on('authenticated', () => {
    console.log('[WhatsAppWeb] 🔐 Autenticado — sessão salva no MongoDB');
  });

  // Auth Failure
  newClient.on('auth_failure', (msg) => {
    console.error('[WhatsAppWeb] ❌ Falha na autenticação:', msg);
    lastError = msg;
    connectionStatus = 'error';
  });

  // Disconnected → reconexão com backoff
  newClient.on('disconnected', async (reason) => {
    console.log('[WhatsAppWeb] 🔌 Desconectado:', reason);
    isReady = false;
    connectionStatus = 'disconnected';

    const delay = Math.min(60_000, 5_000 * (reconnectRetries + 1));
    reconnectRetries++;

    console.log(`[WhatsAppWeb] 🔁 Reconectando em ${delay / 1000}s (tentativa ${reconnectRetries})...`);

    setTimeout(async () => {
      try {
        await newClient.destroy();
      } catch { /* ignora */ }
      client = null;
      initRequested = false; // permite nova inicialização
      initWhatsAppClient();
    }, delay);
  });

  // Error
  newClient.on('error', (err) => {
    console.error('[WhatsAppWeb] Erro:', err.message);
    lastError = err.message;
    if (connectionStatus !== 'ready') connectionStatus = 'error';
  });

  return newClient;
}

function doInitialize() {
  if (client) return;
  console.log('[WhatsAppWeb] Inicializando cliente (RemoteAuth + MongoDB)...');
  connectionStatus = 'initializing';
  client = createClient();
  client.initialize().catch((err) => {
    console.error('[WhatsAppWeb] Falha ao inicializar:', err.message);
    lastError = err.message;
    connectionStatus = 'error';
  });
}

/**
 * Inicializa o cliente WhatsApp Web.
 * Se o MongoDB ainda não estiver conectado, aguarda automaticamente.
 */
export function initWhatsAppClient() {
  if (initRequested) return;
  initRequested = true;

  if (mongoose.connection.readyState === 1) {
    doInitialize();
  } else {
    console.log('[WhatsAppWeb] ⏳ Aguardando MongoDB conectar antes de inicializar...');
    connectionStatus = 'waiting_mongo';
    mongoose.connection.once('connected', () => {
      console.log('[WhatsAppWeb] MongoDB conectado. Inicializando agora...');
      doInitialize();
    });
  }
}

// ─── Status ─────────────────────────────────────────────────────────────────
export function getStatus() {
  return {
    status: connectionStatus,
    ready: isReady,
    qrCode: qrCodeDataUrl,
    error: lastError,
  };
}

// ─── Fila de envio (anti-ban) ───────────────────────────────────────────────
async function processQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return;
  isProcessingQueue = true;

  const { phone, message, resolve, reject } = messageQueue.shift();

  try {
    const result = await sendMessageImmediate(phone, message);
    resolve(result);
    console.log('[WhatsAppWeb] 📤 Enviado:', phone);
  } catch (err) {
    console.error('[WhatsAppWeb] ❌ Erro envio:', err.message);
    // Retry simples: coloca de volta no fim da fila (máx 3x)
    if (!err._retryCount) err._retryCount = 0;
    if (err._retryCount < 3) {
      err._retryCount++;
      messageQueue.push({ phone, message, resolve, reject, _retryCount: err._retryCount });
    } else {
      reject(err);
    }
  }

  // Delay humano: 3s + aleatório de até 2s
  const delay = 3000 + Math.random() * 2000;
  setTimeout(() => {
    isProcessingQueue = false;
    processQueue();
  }, delay);
}

/**
 * Envia mensagem via fila (público).
 * @param {string} phone - número no formato 556292013573
 * @param {string} message - texto da mensagem
 */
export async function sendMessage(phone, message) {
  if (!client || !client.info) {
    throw new Error('WhatsApp não está conectado. Escaneie o QR code primeiro.');
  }
  return new Promise((resolve, reject) => {
    messageQueue.push({ phone, message, resolve, reject });
    processQueue();
  });
}

/**
 * Envio imediato (uso interno).
 */
async function sendMessageImmediate(phone, message) {
  if (!client || !client.info) {
    throw new Error('WhatsApp não está conectado. Escaneie o QR code primeiro.');
  }

  let chatId = phone.replace(/\D/g, '');

  if (!chatId.startsWith('55') && chatId.length === 11) {
    chatId = '55' + chatId;
  } else if (!chatId.startsWith('55') && chatId.length === 10) {
    chatId = '55' + chatId;
  }

  if (!chatId.endsWith('@c.us')) {
    chatId = `${chatId}@c.us`;
  }

  const numberDetails = await client.getNumberId(chatId.replace('@c.us', ''));
  if (!numberDetails) {
    throw new Error('Número não encontrado no WhatsApp');
  }

  const response = await client.sendMessage(numberDetails._serialized, message);
  return {
    success: true,
    messageId: response.id._serialized,
    timestamp: response.timestamp,
  };
}

// ─── Reconexão manual ───────────────────────────────────────────────────────
export async function reconnect() {
  isReady = false;
  qrCodeDataUrl = null;
  connectionStatus = 'initializing';
  lastError = null;
  reconnectRetries = 0;

  if (client) {
    try {
      await client.logout();
      await client.destroy();
    } catch { /* ignora */ }
    client = null;
  }

  // Limpa sessão remota no MongoDB (força novo QR)
  if (mongoStore) {
    try {
      await mongoStore.delete({ session: 'RemoteAuth' });
      console.log('[WhatsAppWeb] Sessão remota removida do MongoDB.');
    } catch (e) {
      console.warn('[WhatsAppWeb] Não foi possível remover sessão remota:', e.message);
    }
  }

  initRequested = false; // permite nova inicialização
  doInitialize();
  return { success: true, message: 'Reconectando... Escaneie o novo QR code.' };
}

// ─── Default export ─────────────────────────────────────────────────────────
export default {
  initWhatsAppClient,
  getStatus,
  sendMessage,
  reconnect,
};
