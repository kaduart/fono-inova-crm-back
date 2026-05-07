/**
 * 🟢 Serviço WhatsApp Web.js (produção — LocalAuth + Disk)
 *
 * Conecta diretamente ao WhatsApp Web usando o chip/celular do usuário.
 * Usa LocalAuth para persistir sessão no filesystem (.wwebjs_auth/).
 * Em produção (Render), montar um Disk em .wwebjs_auth/ para sobreviver restart/deploy.
 * Fila de envio com delay humano (anti-ban).
 * Reconexão automática com backoff exponencial.
 */

import './setPuppeteerCache.js'; // ⚠️ DEVE vir antes de 'puppeteer'

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import mongoose from 'mongoose';
import puppeteer from 'puppeteer';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import WhatsAppWebState from '../models/WhatsAppWebState.js';
import { safeRedis } from '../config/redisConnection.js';

// ─── Singleton & Estado ─────────────────────────────────────────────────────
let client = null;
let isReady = false;
let qrCodeDataUrl = null;
let lastError = null;
let connectionStatus = 'waiting_mongo'; // waiting_mongo, initializing, qr, ready, error, disconnected
let reconnectRetries = 0;
let initRequested = false;
let isReconnecting = false;
let forceReadyInterval = null;
let qrScanTimestamp = null;
const WHATSAPP_LOCK_KEY = 'lock:whatsapp:init';
const WHATSAPP_LOCK_TTL_SECONDS = 30;

// ─── Persistência de estado no MongoDB (compartilhado entre API e worker) ──
async function saveState() {
  try {
    await WhatsAppWebState.findOneAndUpdate(
      { instanceId: 'main' },
      {
        status: connectionStatus,
        ready: isReady,
        qrCode: qrCodeDataUrl,
        error: lastError,
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error('[WhatsAppWeb] Erro ao salvar estado:', err.message);
  }
}

// ─── Fila de mensagens (anti-ban) ───────────────────────────────────────────
const messageQueue = [];
let isProcessingQueue = false;

// ─── Helpers ────────────────────────────────────────────────────────────────
function resolveChromePath() {
  // 1️⃣ Tenta o path oficial do Puppeteer (quando build/runtime estão alinhados)
  try {
    const puppeteerPath = puppeteer.executablePath();
    if (fs.existsSync(puppeteerPath)) {
      console.log('[WhatsAppWeb] Chrome encontrado no cache do Puppeteer:', puppeteerPath);
      return puppeteerPath;
    }
  } catch { /* ignora */ }

  // 2️⃣ 🔥 Busca dinâmica no cache do Puppeteer (Render / VPS / serverless)
  //    Ex: /opt/render/.cache/puppeteer/chrome/linux-147.0.7727.57/chrome-linux64/chrome
  const puppeteerCachePaths = [
    path.join(process.cwd(), '.cache', 'puppeteer', 'chrome'),
    '/opt/render/.cache/puppeteer/chrome',
    '/home/render/.cache/puppeteer/chrome',
    path.join(process.env.HOME || '', '.cache/puppeteer/chrome'),
  ];

  for (const base of puppeteerCachePaths) {
    if (!fs.existsSync(base)) continue;
    try {
      const versions = fs.readdirSync(base);
      for (const v of versions) {
        const candidate = path.join(base, v, 'chrome-linux64', 'chrome');
        if (fs.existsSync(candidate)) {
          console.log('[WhatsAppWeb] Chrome encontrado no cache dinâmico:', candidate);
          return candidate;
        }
      }
    } catch { /* ignora */ }
  }

  // 3️⃣ Fallback em paths do sistema operacional
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
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-component-update',
      '--disable-features=site-per-process',
      '--max_old_space_size=128', // limita memória do V8
    ],
  };
  if (chromePath) opts.executablePath = chromePath;
  return opts;
}

// ─── Inicialização do Cliente ───────────────────────────────────────────────
function createClient() {
  // LocalAuth salva sessão em .wwebjs_auth/ — montar Disk no Render
  const authPath = path.resolve(process.cwd(), '.wwebjs_auth');
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  const newClient = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: buildPuppeteerOptions(),
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EVENTOS DETALHADOS — LOG EM TUDO PARA DEBUG
  // ═══════════════════════════════════════════════════════════════════════════════

  const logEvent = (name, data = '') => {
    const ts = new Date().toISOString();
    console.log(`[WhatsAppWeb][${ts}] 📡 EVENTO: ${name}`, data);
  };

  // QR
  newClient.on('qr', async (qr) => {
    logEvent('qr', 'QR Code gerado — escaneie com o celular');
    connectionStatus = 'qr';
    qrScanTimestamp = Date.now();
    try {
      qrCodeDataUrl = await qrcode.toDataURL(qr);
      await saveState();
    } catch (err) {
      console.error('[WhatsAppWeb] Erro ao gerar QR:', err.message);
    }

    // WORKAROUND: verifica se client.info aparece após scan
    if (forceReadyInterval) clearInterval(forceReadyInterval);
    forceReadyInterval = setInterval(async () => {
      try {
        if (!client) return;
        if (client.info && !isReady) {
          logEvent('force_ready', `client.info detectado! wid=${client.info?.wid?._serialized}`);
          isReady = true;
          reconnectRetries = 0;
          qrCodeDataUrl = null;
          connectionStatus = 'ready';
          lastError = null;
          await saveState();
        }
        // WhatsApp moderno demora bastante no primeiro sync — dá 5 minutos
        if (qrScanTimestamp && Date.now() - qrScanTimestamp > 300_000 && !client.info && connectionStatus === 'qr') {
          logEvent('qr_timeout', '300s desde QR scan sem client.info — QR não foi escaneado ou falhou');
        }
      } catch (err) {
        console.error('[WhatsAppWeb] Erro no forceReadyInterval:', err.message);
      }
    }, 10_000);
  });

  // Authenticated
  newClient.on('authenticated', async () => {
    logEvent('authenticated', 'Celular escaneou o QR! Aguardando ready...');
    connectionStatus = 'connecting';
    qrScanTimestamp = Date.now();
    await saveState();
  });

  // Auth Failure
  newClient.on('auth_failure', async (msg) => {
    logEvent('auth_failure', `Falha: ${msg}`);
    lastError = msg;
    connectionStatus = 'error';
    await saveState();
  });

  // Loading Screen
  newClient.on('loading_screen', (percent, message) => {
    logEvent('loading_screen', `${percent}% — ${message}`);
  });

  // Ready
  newClient.on('ready', async () => {
    logEvent('ready', `Cliente pronto! info=${JSON.stringify({
      wid: client.info?.wid?._serialized,
      platform: client.info?.platform,
      name: client.info?.pushname,
    })}`);
    isReady = true;
    reconnectRetries = 0;
    qrCodeDataUrl = null;
    connectionStatus = 'ready';
    lastError = null;
    if (forceReadyInterval) clearInterval(forceReadyInterval);
    await saveState();
  });

  // Change State
  newClient.on('change_state', (state) => {
    logEvent('change_state', `Novo estado: ${state}`);
  });

  // Change Battery
  newClient.on('change_battery', (batteryInfo) => {
    logEvent('change_battery', `${batteryInfo.battery}% (plugged: ${batteryInfo.plugged})`);
  });

  // Disconnected
  newClient.on('disconnected', async (reason) => {
    logEvent('disconnected', `Razão: ${reason}`);
    isReady = false;
    connectionStatus = 'disconnected';
    if (forceReadyInterval) clearInterval(forceReadyInterval);
    await saveState();

    if (isReconnecting) {
      console.log('[WhatsAppWeb] ⏳ Reconexão já em andamento. Ignorando evento duplicado.');
      return;
    }
    isReconnecting = true;

    const delay = Math.min(60_000, 5_000 * (reconnectRetries + 1));
    reconnectRetries++;

    console.log(`[WhatsAppWeb] 🔁 Reconectando em ${delay / 1000}s (tentativa ${reconnectRetries})...`);

    setTimeout(async () => {
      try {
        await newClient.destroy();
      } catch { /* ignora */ }
      client = null;
      isReconnecting = false;
      initRequested = false;
      await initWhatsAppClient();
    }, delay);
  });

  // Error
  newClient.on('error', async (err) => {
    logEvent('error', err.message);
    lastError = err.message;
    if (connectionStatus !== 'ready') connectionStatus = 'error';
    await saveState();
  });

  // Message received
  newClient.on('message', (msg) => {
    logEvent('message_received', `De: ${msg.from} | Tipo: ${msg.type} | Body: ${msg.body?.substring(0, 50)}`);
  });

  // Message create
  newClient.on('message_create', (msg) => {
    if (msg.fromMe) {
      logEvent('message_sent', `Para: ${msg.to} | Body: ${msg.body?.substring(0, 50)}`);
    }
  });

  return newClient;
}

async function doInitialize() {
  if (client) return;
  console.log('[WhatsAppWeb] Inicializando cliente (LocalAuth + Disk)...');
  console.log('[WhatsAppWeb] AUTH STRATEGY: LocalAuth');
  connectionStatus = 'initializing';
  await saveState();
  client = createClient();
  client.initialize().catch(async (err) => {
    console.error('[WhatsAppWeb] Falha ao inicializar:', err.message);
    lastError = err.message;
    connectionStatus = 'error';
    client = null;
    initRequested = false;
    await saveState();
  });
}

/**
 * Inicializa o cliente WhatsApp Web.
 * Se o MongoDB ainda não estiver conectado, aguarda automaticamente.
 */
export async function initWhatsAppClient() {
  if (initRequested) return;

  // 🔒 Lock distribuído: garante 1 único processo inicializando WhatsApp no cluster
  try {
    const lockAcquired = await safeRedis.set(
      WHATSAPP_LOCK_KEY,
      process.pid?.toString() || '1',
      'NX',
      'EX',
      WHATSAPP_LOCK_TTL_SECONDS
    );
    if (!lockAcquired) {
      console.log('[WhatsAppWeb] 🔒 Lock já adquirido por outro processo. WhatsApp será inicializado pelo owner do lock.');
      initRequested = true; // impede tentativas repetidas neste processo
      return;
    }
    console.log('[WhatsAppWeb] 🔒 Lock adquirido. Este processo será responsável pelo WhatsApp Web.');
  } catch (err) {
    console.warn('[WhatsAppWeb] ⚠️ Não foi possível verificar lock Redis. Continuando mesmo assim:', err.message);
  }

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
export async function getStatus() {
  // Se estiver rodando no mesmo processo (worker ou API local), retorna estado local
  if (client || connectionStatus !== 'waiting_mongo') {
    return {
      status: connectionStatus,
      ready: isReady,
      qrCode: qrCodeDataUrl,
      error: lastError,
    };
  }

  // Se estiver na API web (sem Chrome), lê do MongoDB
  try {
    const state = await WhatsAppWebState.findOne({ instanceId: 'main' }).lean();
    if (state) {
      return {
        status: state.status,
        ready: state.ready,
        qrCode: state.qrCode,
        error: state.error,
      };
    }
  } catch (err) {
    console.error('[WhatsAppWeb] Erro ao ler estado do MongoDB:', err.message);
  }

  return {
    status: 'waiting_mongo',
    ready: false,
    qrCode: null,
    error: null,
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

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
export async function gracefulShutdownWhatsApp() {
  if (forceReadyInterval) {
    clearInterval(forceReadyInterval);
    forceReadyInterval = null;
  }
  if (!client) {
    console.log('[WhatsAppWeb] 🛑 Sem cliente ativo para desligar.');
  } else {
    console.log('[WhatsAppWeb] 🛑 Graceful shutdown iniciado...');
    try {
      await client.destroy();
      console.log('[WhatsAppWeb] ✅ Cliente destruído gracefully.');
    } catch (err) {
      console.warn('[WhatsAppWeb] ⚠️ Erro ao destruir cliente:', err.message);
    }
  }
  client = null;
  isReady = false;
  initRequested = false;
  isReconnecting = false;

  // 🔓 Libera lock distribuído para permitir que outro processo assuma se necessário
  try {
    await safeRedis.del(WHATSAPP_LOCK_KEY);
    console.log('[WhatsAppWeb] 🔓 Lock liberado.');
  } catch (err) {
    console.warn('[WhatsAppWeb] ⚠️ Erro ao liberar lock:', err.message);
  }
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

  // Limpa sessão local do filesystem (força novo QR)
  try {
    const authPath = path.resolve(process.cwd(), '.wwebjs_auth');
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('[WhatsAppWeb] Sessão local removida do filesystem.');
    }
  } catch (e) {
    console.warn('[WhatsAppWeb] Não foi possível remover sessão local:', e.message);
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
