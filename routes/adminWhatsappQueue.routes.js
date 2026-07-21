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

const router = Router();

router.get('/status', auth, async (req, res) => {
  try {
    const status = await getQueueStatus();
    res.json(status);
  } catch (err) {
    console.error('[AdminWhatsappQueue] Erro ao buscar status:', err.message);
    res.status(500).json({ error: 'Falha ao buscar status da fila' });
  }
});

router.get('/audit-log', auth, async (req, res) => {
  try {
    const entries = await getRecentAuditLog();
    res.json({ entries });
  } catch (err) {
    console.error('[AdminWhatsappQueue] Erro ao buscar auditoria:', err.message);
    res.status(500).json({ error: 'Falha ao buscar histórico' });
  }
});

router.post('/pause', auth, authorize(['admin']), async (req, res) => {
  try {
    const status = await pauseQueue(req.user);
    res.json(status);
  } catch (err) {
    console.error('[AdminWhatsappQueue] Erro ao pausar fila:', err.message);
    res.status(500).json({ error: 'Falha ao pausar fila' });
  }
});

router.post('/resume', auth, authorize(['admin']), async (req, res) => {
  try {
    const status = await resumeQueue(req.user);
    res.json(status);
  } catch (err) {
    console.error('[AdminWhatsappQueue] Erro ao retomar fila:', err.message);
    res.status(500).json({ error: 'Falha ao retomar fila' });
  }
});

router.post('/clear-stuck', auth, authorize(['admin']), async (req, res) => {
  try {
    const result = await clearStuckRetries(req.user);
    res.json(result);
  } catch (err) {
    console.error('[AdminWhatsappQueue] Erro ao limpar jobs travados:', err.message);
    res.status(500).json({ error: 'Falha ao limpar jobs travados' });
  }
});

export default router;
