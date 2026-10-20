import express from 'express';
import { getStatus, clearSession } from '../services/whatsappWebJsService.js';
import { whatsappSendQueue } from '../config/bullConfig.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';
import { markAttendanceConfirmationQueued } from '../services/appointment/attendanceConfirmation.service.js';

const router = express.Router();

/**
 * GET /api/whatsapp-web/status
 * Retorna status da conexão e QR code (se necessário)
 */
router.get('/status', async (req, res) => {
  // Impede 304: desabilita comparação de ETag e proíbe cache
  delete req.headers['if-none-match'];
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  const status = await getStatus();
  res.json(status);
});

/**
 * POST /api/whatsapp-web/send
 * Envia mensagem via WhatsApp Web
 * Body: { phone: "556292013573", message: "texto" }
 */
router.post('/send', async (req, res) => {
  try {
    let { phone, message, appointmentId, purpose } = req.body;

    if (!phone || !message) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'Campos obrigatórios: phone e message', {
          status: 400,
        }),
        req
      );
    }

    // Normaliza quebras de linha
    message = message
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r');

    if (purpose === 'attendance_confirmation' && !appointmentId) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'appointmentId é obrigatório para confirmação de atendimento', { status: 400 }), req);
    }

    const job = await whatsappSendQueue.add('send-message', { phone, message, appointmentId, purpose });
    if (purpose === 'attendance_confirmation') {
      const appointment = await markAttendanceConfirmationQueued(appointmentId);
      if (!appointment) {
        await job.remove().catch(() => {});
        return sendApiError(res, new AppError('NOT_FOUND', 'Agendamento ativo não encontrado', { status: 404 }), req);
      }
    }
    console.log('[WhatsAppWeb Route] Mensagem enfileirada:', job.id);
    res.json({ success: true, message: 'Mensagem enfileirada para envio', jobId: job.id });
  } catch (err) {
    console.error('[WhatsAppWeb Route] Erro:', err.message);
    sendApiError(res, err, req);
  }
});

/**
 * POST /api/whatsapp-web/reconnect
 * Limpa sessão e força novo QR code
 */
router.post('/reconnect', async (req, res) => {
  try {
    // ⚠️ No server.js principal NÃO chama reconnect() que dispara Puppeteer.
    // Apenas limpa a sessão no disk/MongoDB. O worker detecta e gera novo QR.
    const result = await clearSession();
    res.json(result);
  } catch (err) {
    sendApiError(res, err, req);
  }
});

export default router;
