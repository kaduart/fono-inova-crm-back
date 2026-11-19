/**
 * 🟢 Rotas WhatsApp VPS
 * 
 * Proxy para VPS externo rodando whatsapp-web.js
 */

import express from 'express';
import { sendViaVPS, checkVPSStatus } from '../services/whatsappVPSService.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { requireStaff, requireStaffOrAgenda, requireAdmin } from '../middleware/requireRole.js';
import { manualIdempotencyKey, manualKeyPolicy, sendManualOnce, manualSendResponse } from '../services/communication/manualSendOnce.js';

const router = express.Router();

// Envio pelo número da clínica: exige login (admin/secretária) ou o token da
// Agenda Externa. Emergência: WHATSAPP_WEB_AUTH_MODE=log só registra e libera.
const whatsappGuard = process.env.WHATSAPP_WEB_AUTH_MODE === 'log'
    ? (req, _res, next) => {
        if (!req.headers.authorization) console.warn('[WHATSAPP_UNAUTH_LOG]', req.method, req.originalUrl, req.ip);
        next();
    }
    : [flexibleAuth, requireStaffOrAgenda];
router.use(whatsappGuard);

/**
 * POST /api/whatsapp-vps/send
 * Envia mensagem via VPS
 */
router.post('/send', async (req, res) => {
  try {
    const { phone, message } = req.body;
    // Idempotency-Key: duplo clique / retry de rede = uma tentativa no VPS. Política
    // própria (a Agenda Externa também chama esta rota e pode não mandar a chave):
    // MANUAL_SEND_REQUIRE_KEY_VPS=off|log|on, padrão log.
    const { key, error: keyError, status: keyStatus, code: keyCode } = manualIdempotencyKey(req, {
      route: 'whatsappVPS.send',
      policy: manualKeyPolicy({ MANUAL_SEND_REQUIRE_KEY: process.env.MANUAL_SEND_REQUIRE_KEY_VPS })
    });
    if (keyError) {
      return sendApiError(res, new AppError(keyCode || 'BAD_REQUEST', keyError, { status: keyStatus || 400 }), req);
    }

    if (!phone || !message) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'phone e message são obrigatórios', { status: 400 }), req);
    }

    const sendOnce = await sendManualOnce({
      key: key && `vps:${key}`,
      actorId: req.user?._id || req.user?.id,
      destination: phone,
      send: () => sendViaVPS(phone, message)
    });
    const notSent = manualSendResponse(sendOnce.outcome, sendOnce.providerMessageId);
    if (notSent) return res.status(notSent.status).json(notSent.body);
    res.json({ success: true, ...sendOnce.result });
    
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
