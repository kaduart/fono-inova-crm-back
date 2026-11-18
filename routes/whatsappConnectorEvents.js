// routes/whatsappConnectorEvents.js
// POST /api/whatsapp-connector/events — eventos do conector WhatsApp externo (18/11/2026).
// Autenticação própria por HMAC no corpo cru (não usa login de usuário). Ver services/whatsappConnector/eventsReceiver.js.
import express from 'express';
import { getQueue } from '../infrastructure/queue/queueConfig.js';
import {
  receiveConnectorEvents, bullEnqueuer, receiverSecret, CONNECTOR_EVENTS_QUEUE,
} from '../services/whatsappConnector/eventsReceiver.js';

const router = express.Router();

// Corpo CRU: a assinatura cobre os bytes exatos. O parser JSON global pula esta rota (server.js).
router.post('/events', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const { status, body } = await receiveConnectorEvents({
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.from(''),
      headers: req.headers,
      method: 'POST',
      path: req.originalUrl,
      secret: receiverSecret(),
      enqueue: bullEnqueuer(getQueue(CONNECTOR_EVENTS_QUEUE)),
    });
    if (status === 401) console.warn('[WA-CONNECTOR] 🚫 evento com assinatura recusada:', body.reason);
    res.status(status).json(body);
  } catch (err) {
    // Redis/fila fora: 503 faz o conector guardar e reentregar depois.
    console.error('[WA-CONNECTOR] ❌ não consegui enfileirar eventos:', err?.message);
    res.status(503).json({ error: 'indisponivel' });
  }
});

export default router;
