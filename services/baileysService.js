/**
 * 🟢 Serviço Baileys - WhatsApp não-oficial
 * Envia mensagens direto pelo WhatsApp Web (sem abrir navegador)
 * Sessão persistida no MongoDB (sobrevive reinícios do Render)
 * 
 * ⚠️ AVISO: Isso viola os termos do WhatsApp. Use por sua conta e risco.
 * Volume baixo (20-100/dia) = risco menor, mas existe.
 */

import pkg from "@whiskeysockets/baileys";
const { default: makeWASocket, DisconnectReason, initAuthCreds } = pkg;
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import { useMongoAuthState } from "./baileysMongoAuth.js";
import BaileysSession from "../models/BaileysSession.js";

class BaileysService {
  constructor() {
    this.sock = null;
    this.qr = null;
    this.status = "disconnected";
    this.connectionInfo = null;
    this.saveCreds = null;
    this.isInitialized = false;
  }

  /**
   * Limpa completamente a sessão
   */
  async clearSession() {
    console.log("[Baileys] Limpando sessão...");
    this.qr = null;
    this.status = "disconnected";
    this.isInitialized = false;
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (e) {
        // Ignora erro
      }
      this.sock = null;
    }
    // Limpa do MongoDB
    await BaileysSession.deleteOne({ sessionId: 'default' });
    console.log("[Baileys] Sessão limpa!");
  }

  /**
   * Inicializa a conexão com WhatsApp
   */
  async initialize(forceNew = false) {
    if (this.isInitialized && !forceNew) {
      console.log("[Baileys] Já inicializado");
      return;
    }

    if (forceNew) {
      await this.clearSession();
    }

    try {
      this.status = "connecting";
      this.isInitialized = true;
      console.log("[Baileys] Inicializando com MongoDB...");

      // Usa auth state do MongoDB (persistente)
      const { state, saveCreds } = await useMongoAuthState('default');
      this.saveCreds = saveCreds;

      console.log("[Baileys] Estado carregado:", { 
        hasCreds: !!state.creds,
        hasMe: !!state.creds?.me,
        noiseKey: !!state.creds?.noiseKey 
      });

      this.sock = makeWASocket({
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        version: [2, 3000, 1015901307],
      });

      // Evento de conexão
      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log("[Baileys] connection.update:", { 
          connection, 
          hasQR: !!qr, 
          qrLength: qr?.length 
        });

        if (qr) {
          this.qr = qr;
          this.status = "qr_required";
          console.log("\n╔════════════════════════════════════════════════╗");
          console.log("║     QR CODE GERADO - Escaneie no WhatsApp      ║");
          console.log("╚════════════════════════════════════════════════╝\n");
          
          try {
            const qrTerminal = await QRCode.toString(qr, { type: "terminal", small: true });
            console.log(qrTerminal);
          } catch (e) {
            console.log("QR:", qr.substring(0, 60) + "...");
          }
          console.log("");
        }

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(
            "[Baileys] Conexão fechada. Reconectar?",
            shouldReconnect,
            "Erro:", lastDisconnect?.error?.message
          );

          this.status = "disconnected";
          this.sock = null;
          this.isInitialized = false;

          if (shouldReconnect) {
            const delay = this.qr ? 3000 : 8000;
            console.log(`[Baileys] Reconectando em ${delay/1000}s...`);
            setTimeout(() => this.initialize(), delay);
          }
        } else if (connection === "open") {
          console.log("[Baileys] ✅ CONECTADO! WhatsApp pronto.");
          this.status = "connected";
          this.qr = null;
        }
      });

      // Salva credenciais no MongoDB
      this.sock.ev.on("creds.update", saveCreds);

      // Evento de mensagens
      this.sock.ev.on("messages.upsert", (m) => {
        if (m.type === "notify") {
          const msg = m.messages[0];
          if (!msg.key.fromMe) {
            console.log(`[Baileys] Msg de ${msg.key.remoteJid}:`, 
              msg.message?.conversation?.substring(0, 30) || "[mídia]"
            );
          }
        }
      });

    } catch (error) {
      console.error("[Baileys] Erro ao inicializar:", error);
      this.status = "disconnected";
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Envia mensagem de texto
   */
  async sendText(phone, message) {
    if (!this.sock || this.status !== "connected") {
      throw new Error("WhatsApp não conectado. Escaneie o QR code primeiro.");
    }

    const formattedPhone = phone.replace(/\D/g, "");
    const jid = `${formattedPhone}@s.whatsapp.net`;

    try {
      console.log(`[Baileys] Enviando para ${formattedPhone}...`);
      const result = await this.sock.sendMessage(jid, { text: message });
      console.log(`[Baileys] ✅ Enviado! ID: ${result.key.id}`);
      
      return {
        success: true,
        messageId: result.key.id,
        timestamp: result.messageTimestamp,
        to: formattedPhone,
      };
    } catch (error) {
      console.error("[Baileys] Erro ao enviar:", error);
      throw error;
    }
  }

  getStatus() {
    return {
      status: this.status,
      hasQR: !!this.qr,
      qrCode: this.qr,
      connected: this.status === "connected",
    };
  }

  async disconnect() {
    await this.clearSession();
  }

  async getQRCodeBase64() {
    if (!this.qr) return null;
    try {
      return await QRCode.toDataURL(this.qr, { width: 400, margin: 2 });
    } catch (e) {
      return null;
    }
  }
}

const baileysService = new BaileysService();
export default baileysService;
export { BaileysService };
