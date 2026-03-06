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

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, '../.whatsapp-session')
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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

    await this.client.sendMessage(numberId._serialized, message);
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
