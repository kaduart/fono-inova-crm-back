import express from 'express';
import { getStatus, clearSession } from '../services/whatsappWebJsService.js';
import { whatsappSendQueue } from '../config/bullConfig.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';
import { markAttendanceConfirmationQueued } from '../services/appointment/attendanceConfirmation.service.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { requireStaff, requireStaffOrAgenda, requireAdmin } from '../middleware/requireRole.js';

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

/**
 * POST /api/whatsapp-web/ads-chat-activity   (admin)
 * Body: { since?: 'YYYY-MM-DD' } (padrão: 30 dias atrás)
 * Retomada dos leads de anúncio: enfileira a conferência SÓ LEITURA da última mensagem (clínica × contato)
 * de cada telefone que veio de anúncio desde `since`. Não envia nada. Resultado em GET .../latest.
 */
router.post('/ads-chat-activity', requireAdmin, async (req, res) => {
  try {
    const { listAdPhones, startOfDayBRT } = await import('../services/adsChatActivity.js');
    const since = req.body?.since ? startOfDayBRT(req.body.since) : new Date(Date.now() - 30 * 86400000);
    if (!since) return sendApiError(res, new AppError('BAD_REQUEST', 'since deve ser YYYY-MM-DD', { status: 400 }), req);
    const WhatsAppScanRun = (await import('../models/WhatsAppScanRun.js')).default;
    const pending = await WhatsAppScanRun.findOne({ kind: 'ads_chat_activity', status: { $in: ['queued', 'running'] }, createdAt: { $gte: new Date(Date.now() - 60 * 60000) } }).lean();
    if (pending) return res.json({ runId: pending._id, status: pending.status, people: pending.phones?.length || 0, reused: true });
    const phones = await listAdPhones({ since });
    if (!phones.length) return res.json({ runId: null, status: 'empty', people: 0 });
    const run = await WhatsAppScanRun.create({ kind: 'ads_chat_activity', convenio: 'ads', phones, since, requestedBy: req.user?._id || req.user?.id || null });
    const { whatsappScanQueue } = await import('../config/bullConfig.js');
    await whatsappScanQueue.add('ads-chat-activity', { runId: String(run._id), convenio: 'ads', adsActivity: true }, { jobId: `ads-chat-activity-${run._id}` });
    res.json({ runId: run._id, status: 'queued', people: phones.length });
  } catch (err) {
    sendApiError(res, err, req);
  }
});

/** GET /api/whatsapp-web/ads-chat-activity/latest (admin) — status e contagens da última conferência. */
router.get('/ads-chat-activity/latest', requireAdmin, async (req, res) => {
  try {
    const WhatsAppScanRun = (await import('../models/WhatsAppScanRun.js')).default;
    const run = await WhatsAppScanRun.findOne({ kind: 'ads_chat_activity' }).sort({ createdAt: -1 }).lean();
    if (!run) return res.json({ run: null });
    const { rows, ...stats } = run.stats || {};
    res.json({ run: { id: run._id, status: run.status, since: run.since, people: run.phones?.length || 0, createdAt: run.createdAt, finishedAt: run.finishedAt, error: run.error, stats, rows: rows?.length || 0 } });
  } catch (err) {
    sendApiError(res, err, req);
  }
});

export default router;
