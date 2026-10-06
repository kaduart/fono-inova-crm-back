/**
 * 🟢 Rotas WhatsApp VPS
 * 
 * Proxy para VPS externo rodando whatsapp-web.js
 */

import express from 'express';
import { sendViaVPS, checkVPSStatus } from '../services/whatsappVPSService.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = express.Router();

/**
 * POST /api/whatsapp-vps/send
 * Envia mensagem via VPS
 */
router.post('/send', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'phone e message são obrigatórios', { status: 400 }), req);
    }
    
    const result = await sendViaVPS(phone, message);
    res.json({ success: true, ...result });
    
  } catch (error) {
    console.error('[WhatsApp VPS] Erro:', error);
    sendApiError(res, error, req);
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
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message, {
        status: 500,
        extra: { connected: false },
      }),
      req
    );
  }
});

export default router;
