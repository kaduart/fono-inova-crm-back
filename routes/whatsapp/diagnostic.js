import express from 'express';
import { getIo } from '../../config/socket.js';
import { redisConnection } from '../../config/redisConnection.js';
import mongoose from 'mongoose';
import Message from '../../models/Message.js';
import Contacts from '../../models/Contacts.js';
import { publishEvent, EventTypes } from '../../infrastructure/events/eventPublisher.js';

const router = express.Router();

/**
 * 🔍 GET /api/diagnostic/chat-status
 * Retorna o status completo do sistema de chat
 */
router.get('/chat-status', async (req, res) => {
  try {
    const io = getIo();
    const status = {
      timestamp: new Date().toISOString(),
      socket: {
        connected: io?.engine?.clientsCount > 0,
        clientsCount: io?.engine?.clientsCount || 0
      },
      redis: {
        connected: false
      },
      queues: {},
      database: {
        connected: mongoose.connection.readyState === 1
      },
      recentMessages: {
        last5Minutes: 0,
        lastHour: 0,
        lastMessageAt: null
      }
    };

    // Verifica Redis
    try {
      await redisConnection.ping();
      status.redis.connected = true;
      
      // Conta chaves de debounce
      const debounceKeys = await redisConnection.keys('webhook:buffer:*');
      status.redis.debouncePending = debounceKeys.length;
      
      // Conta chaves de idempotência
      const idemKeys = await redisConnection.keys('msg:processed:*');
      status.redis.idempotencyKeys = idemKeys.length;
    } catch (err) {
      status.redis.error = err.message;
    }

    // Verifica filas
    try {
      const { getQueue } = await import('../infrastructure/queue/queueConfig.js');
      const inboundQueue = getQueue('whatsapp-inbound');
      status.queues.whatsappInbound = {
        waiting: await inboundQueue.getWaitingCount(),
        active: await inboundQueue.getActiveCount(),
        failed: await inboundQueue.getFailedCount()
      };
    } catch (err) {
      status.queues.error = err.message;
    }

    // Verifica mensagens recentes
    try {
      const cincoMinAtras = new Date(Date.now() - 5 * 60 * 1000);
      const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000);
      
      status.recentMessages.last5Minutes = await Message.countDocuments({ 
        timestamp: { $gte: cincoMinAtras } 
      });
      status.recentMessages.lastHour = await Message.countDocuments({ 
        timestamp: { $gte: umaHoraAtras } 
      });
      
      const ultimaMsg = await Message.findOne().sort({ timestamp: -1 }).lean();
      status.recentMessages.lastMessageAt = ultimaMsg?.timestamp;
      status.recentMessages.lastMessageFrom = ultimaMsg?.from;
    } catch (err) {
      status.recentMessages.error = err.message;
    }

    // Determina status geral
    const isHealthy = 
      status.socket.clientsCount > 0 &&
      status.redis.connected &&
      status.database.connected &&
      status.queues.whatsappInbound?.failed === 0;

    res.json({
      healthy: isHealthy,
      ...status
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🧪 POST /api/diagnostic/test-message
 * Envia uma mensagem de teste pelo socket
 */
router.post('/test-message', async (req, res) => {
  try {
    const io = getIo();
    const { phone = '5511999999999', text = 'Mensagem de teste' } = req.body;
    
    const testPayload = {
      id: `test-${Date.now()}`,
      from: phone,
      to: process.env.CLINIC_PHONE_E164 || '5511888888888',
      direction: 'inbound',
      type: 'text',
      content: text,
      text: text,
      status: 'received',
      timestamp: new Date(),
      leadId: 'test-lead-id',
      contactId: 'test-contact-id'
    };

    // Emite via socket
    io.emit('message:new', testPayload);
    io.emit('whatsapp:new_message', testPayload);

    res.json({
      success: true,
      message: 'Mensagem de teste emitida',
      payload: testPayload,
      clientsConnected: io?.engine?.clientsCount || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔄 POST /api/diagnostic/test-full-flow
 * Testa o fluxo completo: webhook → fila → socket
 */
router.post('/test-full-flow', async (req, res) => {
  try {
    const { phone = '5511999999999', text = 'Teste fluxo completo' } = req.body;
    
    // Simula uma mensagem recebida do webhook
    const msg = {
      id: `test-flow-${Date.now()}`,
      from: phone.replace(/\D/g, ''),
      timestamp: Math.floor(Date.now() / 1000).toString(),
      type: 'text',
      text: { body: text }
    };
    
    const value = {
      metadata: {
        display_phone_number: process.env.CLINIC_PHONE_E164 || '5511888888888'
      },
      messages: [msg]
    };

    // Publica o evento
    const result = await publishEvent(EventTypes.WHATSAPP_MESSAGE_RECEIVED, { msg, value });

    res.json({
      success: true,
      message: 'Evento publicado para processamento',
      eventId: result.eventId,
      queue: result.queues,
      checkStatus: 'Use GET /api/diagnostic/chat-status para verificar o processamento'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🧹 POST /api/diagnostic/clear-debounce
 * Limpa chaves de debounce presas
 */
router.post('/clear-debounce', async (req, res) => {
  try {
    const keys = await redisConnection.keys('webhook:buffer:*');
    let cleared = 0;
    
    for (const key of keys) {
      await redisConnection.del(key);
      cleared++;
    }

    res.json({
      success: true,
      cleared,
      message: `${cleared} chaves de debounce removidas`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📊 GET /api/diagnostic/last-webhooks
 * Retorna os últimos webhooks recebidos
 */
router.get('/last-webhooks', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    
    const logs = await mongoose.connection.collection('raw_webhook_logs')
      .find({})
      .sort({ receivedAt: -1 })
      .limit(parseInt(limit))
      .toArray();

    const formatted = logs.map(log => {
      const msg = log.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const statuses = log.body?.entry?.[0]?.changes?.[0]?.value?.statuses;
      
      return {
        receivedAt: log.receivedAt,
        type: msg ? 'message' : (statuses ? 'status' : 'unknown'),
        from: msg?.from,
        text: msg?.text?.body?.substring(0, 100),
        messageId: msg?.id,
        statuses: statuses?.map(s => ({
          id: s.id,
          status: s.status,
          recipient: s.recipient_id
        }))
      };
    });

    res.json({
      count: formatted.length,
      logs: formatted
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
