/**
 * WhatsApp Web Service - Envia mensagens via Puppeteer (whatsapp-web.js)
 * Sessao persistente: escaneie o QR uma vez, fica conectado.
 */
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class WhatsAppWebService {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.qrCode = null;
    this.initCalled = false;
  }

  async initialize() {
    if (this.initCalled) return;
    this.initCalled = true;

    // Detecta caminho do Chrome (local vs Render)
    const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || 
                       process.env.CHROME_PATH ||
                       '/usr/bin/chromium-browser';
    
    console.log('[WhatsAppWeb] Usando Chrome em:', chromePath);

    // Caminho da sessão (persistente no Render)
    const sessionPath = process.env.WHATSAPP_SESSION_PATH || 
                        path.join(__dirname, '../.whatsapp-session');
    
    console.log('[WhatsAppWeb] Sessão em:', sessionPath);

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: sessionPath
      }),
      puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox', 
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      }
    });

    this.client.on('qr', (qr) => {
      this.qrCode = qr;
      this.isReady = false;
      console.log('[WhatsAppWeb] QR Code pronto - acesse GET /api/whatsapp-web/qr no navegador para escanear');
    });

    this.client.on('authenticated', () => {
      console.log('[WhatsAppWeb] Autenticado!');
    });

    this.client.on('ready', () => {
      this.isReady = true;
      this.qrCode = null;
      console.log('[WhatsAppWeb] Conectado e pronto para enviar mensagens!');
    });

    this.client.on('auth_failure', (msg) => {
      console.error('[WhatsAppWeb] Falha de autenticacao:', msg);
      this.isReady = false;
    });

    this.client.on('disconnected', (reason) => {
      console.log('[WhatsAppWeb] Desconectado:', reason);
      this.isReady = false;
      this.initCalled = false;
      setTimeout(() => this.initialize(), 5000);
    });

    console.log('[WhatsAppWeb] Inicializando...');
    await this.client.initialize().catch(err => {
      console.error('[WhatsAppWeb] Erro ao inicializar:', err.message);
      this.initCalled = false;
    });
  }

  async sendMessage(phone, message) {
    if (!this.isReady || !this.client) {
      throw new Error('WhatsApp nao esta conectado. Escaneie o QR em /api/whatsapp-web/qr');
    }

    let cleanPhone = phone.replace(/\D/g, '');
    if (!cleanPhone.startsWith('55')) {
      cleanPhone = '55' + cleanPhone;
    }

    if (cleanPhone.length < 12) {
      throw new Error(`Numero invalido: ${phone}`);
    }

    // Resolve o ID correto do numero (compativel com protocolo LID do WhatsApp)
    const numberId = await this.client.getNumberId(cleanPhone);
    if (!numberId) {
      throw new Error(`Numero ${cleanPhone} nao encontrado no WhatsApp. Verifique se o numero esta correto.`);
    }

    // Garante que quebras de linha sejam preservadas
    // Substitui \n literal por quebras de linha reais se necessário
    let formattedMessage = message;
    if (typeof message === 'string' && message.includes('\\n')) {
      formattedMessage = message.replace(/\\n/g, '\n');
    }

    await this.client.sendMessage(numberId._serialized, formattedMessage);
    return { success: true };
  }

  getStatus() {
    return {
      isReady: this.isReady,
      hasQR: !!this.qrCode,
      qrCode: this.qrCode
    };
  }
}

export default new WhatsAppWebService();
