// back/routes/adminWhatsappQueue.routes.js
/**
 * Kill switch admin da fila whatsapp-send (ver whatsappQueueControlService.js).
 */

import { Router } from 'express';
import { auth, authorize } from '../middleware/auth.js';
import {
  getQueueStatus,
  pauseQueue,
  resumeQueue,
  clearStuckRetries,
  getRecentAuditLog,
} from '../services/whatsappQueueControlService.js';
import { cleanupChromeCache } from '../services/whatsappWebJsService.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = Router();

router.get('/status', auth, async (req, res) => {
  try {
    const status = await getQueueStatus();
    res.json(status);
  } catch (err) {
    console.error('[AdminWhatsappQueue] Erro ao buscar status:', err.message);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Falha ao buscar status da fila', { status: 500 }), req);
  }
});

router.get('/audit-log', auth, async (req, res) => {
  try {
    const entries = await getRecentAuditLog();
    res.json({ entries });
  } catch (err) {
    console.error('[AdminWhatsappQueue] Erro ao buscar auditoria:', err.message);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Falha ao buscar histórico', { status: 500 }), req);
  }
});

router.post('/pause', auth, authorize(['admin']), async (req, res) => {
  try {
    const status = await pauseQueue(req.user);
    res.json(status);
  } catch (err) {
    console.error('[AdminWhatsappQueue] Erro ao pausar fila:', err.message);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Falha ao pausar fila', { status: 500 }), req);
  }
});

router.post('/resume', auth, authorize(['admin']), async (req, res) => {
  try {
    const status = await resumeQueue(req.user);
    res.json(status);
  } catch (err) {
    console.error('[AdminWhatsappQueue] Erro ao retomar fila:', err.message);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Falha ao retomar fila', { status: 500 }), req);
  }
});

router.post('/clear-stuck', auth, authorize(['admin']), async (req, res) => {
  try {
    const result = await clearStuckRetries(req.user);
    res.json(result);
  } catch (err) {
    console.error('[AdminWhatsappQueue] Erro ao limpar jobs travados:', err.message);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Falha ao limpar jobs travados', { status: 500 }), req);
  }
});

router.post('/cleanup-cache', auth, authorize(['admin']), async (req, res) => {
  try {
    const result = cleanupChromeCache();
    res.json({
      success: true,
      message: 'Cache temporário do Chrome limpo. A autenticação da sessão foi preservada.',
      removed: result.removed,
      skippedReason: result.skippedReason,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[AdminWhatsappQueue] Erro ao limpar cache do Chrome:', err.message);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Falha ao limpar cache do Chrome', { status: 500 }), req);
  }
});

export default router;
