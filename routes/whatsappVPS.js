/**
 * 🟢 Rotas WhatsApp VPS
 * 
 * Proxy para VPS externo rodando whatsapp-web.js
 */

import express from 'express';
import { sendViaVPS, checkVPSStatus } from '../services/whatsappVPSService.js';

const router = express.Router();

/**
 * POST /api/whatsapp-vps/send
 * Envia mensagem via VPS
 */
router.post('/send', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'phone e message são obrigatórios' 
      });
    }
    
    const result = await sendViaVPS(phone, message);
    res.json({ success: true, ...result });
    
  } catch (error) {
    console.error('[WhatsApp VPS] Erro:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/whatsapp-vps/status
 * Status da conexão VPS
 */
router.get('/status', async (req, res) => {
  try {
    const status = await checkVPSStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ 
      connected: false, 
      error: error.message 
    });
  }
});

export default router;
