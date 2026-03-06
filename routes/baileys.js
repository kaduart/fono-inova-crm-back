/**
 * 🟢 Rotas Baileys - Controle do WhatsApp não-oficial
 */

import express from "express";
import baileysService from "../services/baileysService.js";
import BaileysSession from "../models/BaileysSession.js";

const router = express.Router();

/**
 * GET /api/baileys/status
 * Retorna status da conexão
 */
router.get("/status", async (req, res) => {
  try {
    const status = baileysService.getStatus();
    
    // Se precisa de QR code, gera base64
    let qrCodeBase64 = null;
    if (status.hasQR) {
      qrCodeBase64 = await baileysService.getQRCodeBase64();
    }
    
    res.json({
      success: true,
      data: {
        ...status,
        qrCodeBase64,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/baileys/connect
 * Inicia conexão (gera QR code)
 */
router.post("/connect", async (req, res) => {
  try {
    await baileysService.initialize();
    
    // Aguarda um pouco para gerar o QR
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    const status = baileysService.getStatus();
    const qrCodeBase64 = await baileysService.getQRCodeBase64();
    
    res.json({
      success: true,
      message: status.hasQR 
        ? "Escaneie o QR code no WhatsApp"
        : "Conectado ou conectando...",
      data: {
        ...status,
        qrCodeBase64,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/baileys/disconnect
 * Desconecta
 */
router.post("/disconnect", async (req, res) => {
  try {
    await baileysService.disconnect();
    res.json({
      success: true,
      message: "Desconectado",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/baileys/send
 * Envia mensagem
 */
router.post("/send", async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({
        success: false,
        error: "phone e message são obrigatórios",
      });
    }
    
    const result = await baileysService.sendText(phone, message);
    
    res.json({
      success: true,
      message: "Mensagem enviada com sucesso!",
      data: result,
    });
  } catch (error) {
    console.error("[Baileys Route] Erro:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/baileys/reset
 * Limpa a sessão e força novo QR code
 */
router.post("/reset", async (req, res) => {
  try {
    // Limpa completamente e reinicializa
    await baileysService.initialize(true); // forceNew = true
    
    res.json({
      success: true,
      message: "Sessão limpa. Novo QR code será gerado em alguns segundos.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
