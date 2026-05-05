/**
 * 🟢 Serviço WhatsApp Web.js (nativo)
 * 
 * Conecta diretamente ao WhatsApp Web usando o chip/celular do usuário.
 * Salva sessão em .whatsapp-session/ para não precisar escanear QR toda hora.
 */

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';

const SESSION_PATH = path.resolve(process.cwd(), '.whatsapp-session');

// Garante que a pasta existe
if (!fs.existsSync(SESSION_PATH)) {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

let client = null;
let isReady = false;
let qrCodeDataUrl = null;
let lastError = null;
let connectionStatus = 'initializing'; // initializing, qr, ready, error

/**
 * Inicializa o cliente WhatsApp Web
 */
export function initWhatsAppClient() {
  if (client) return;

  console.log('[WhatsAppWeb] Inicializando cliente...');
  connectionStatus = 'initializing';

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    console.log('[WhatsAppWeb] QR Code gerado. Escaneie com o celular.');
    connectionStatus = 'qr';
    try {
      qrCodeDataUrl = await qrcode.toDataURL(qr);
    } catch (err) {
      console.error('[WhatsAppWeb] Erro ao gerar QR:', err.message);
    }
  });

  client.on('ready', () => {
    console.log('[WhatsAppWeb] ✅ Cliente pronto!');
    isReady = true;
    qrCodeDataUrl = null;
    connectionStatus = 'ready';
    lastError = null;
  });

  client.on('authenticated', () => {
    console.log('[WhatsAppWeb] 🔐 Autenticado');
  });

  client.on('auth_failure', (msg) => {
    console.error('[WhatsAppWeb] ❌ Falha na autenticação:', msg);
    lastError = msg;
    connectionStatus = 'error';
  });

  client.on('disconnected', (reason) => {
    console.log('[WhatsAppWeb] 🔌 Desconectado:', reason);
    isReady = false;
    connectionStatus = 'disconnected';
    // Reinicia após 5s
    setTimeout(() => {
      client.destroy().catch(() => {});
      client = null;
      initWhatsAppClient();
    }, 5000);
  });

  client.on('error', (err) => {
    console.error('[WhatsAppWeb] Erro:', err.message);
    lastError = err.message;
    connectionStatus = 'error';
  });

  client.initialize().catch((err) => {
    console.error('[WhatsAppWeb] Falha ao inicializar:', err.message);
    lastError = err.message;
    connectionStatus = 'error';
  });
}

/**
 * Retorna status da conexão
 */
export function getStatus() {
  return {
    status: connectionStatus,
    ready: isReady,
    qrCode: qrCodeDataUrl,
    error: lastError
  };
}

/**
 * Envia mensagem via WhatsApp Web
 * @param {string} phone - número no formato 556292013573
 * @param {string} message - texto da mensagem
 */
export async function sendMessage(phone, message) {
  console.log('[WhatsAppWeb] Tentando enviar...', { isReady, hasClient: !!client, clientReady: client?.info?.me?.user });
  
  if (!client || !client.info) {
    throw new Error('WhatsApp não está conectado. Escaneie o QR code primeiro.');
  }

  // Garante formato correto: 556292013573@c.us
  let chatId = phone.replace(/\D/g, '');
  
  // Adiciona 55 se não tiver código do país
  if (!chatId.startsWith('55') && chatId.length === 11) {
    chatId = '55' + chatId;
  } else if (!chatId.startsWith('55') && chatId.length === 10) {
    chatId = '55' + chatId;
  }
  
  if (!chatId.endsWith('@c.us')) {
    chatId = `${chatId}@c.us`;
  }

  try {
    // Resolve o ID correto do número (inclui LID se necessário)
    const numberDetails = await client.getNumberId(chatId.replace('@c.us', ''));
    if (!numberDetails) {
      throw new Error('Número não encontrado no WhatsApp');
    }
    
    const response = await client.sendMessage(numberDetails._serialized, message);
    return {
      success: true,
      messageId: response.id._serialized,
      timestamp: response.timestamp
    };
  } catch (err) {
    console.error('[WhatsAppWeb] Erro ao enviar:', err.message);
    throw new Error(`Erro ao enviar mensagem: ${err.message}`);
  }
}

/**
 * Força reconexão (limpa sessão e gera novo QR)
 */
export async function reconnect() {
  isReady = false;
  qrCodeDataUrl = null;
  connectionStatus = 'initializing';
  lastError = null;

  if (client) {
    try {
      await client.logout();
      await client.destroy();
    } catch (e) {
      // ignora
    }
    client = null;
  }

  // Limpa sessão
  try {
    fs.rmSync(SESSION_PATH, { recursive: true, force: true });
    fs.mkdirSync(SESSION_PATH, { recursive: true });
  } catch (e) {
    // ignora
  }

  initWhatsAppClient();
  return { success: true, message: 'Reconectando... Escaneie o novo QR code.' };
}

export default {
  initWhatsAppClient,
  getStatus,
  sendMessage,
  reconnect
};
