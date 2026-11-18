// routes/health.v2.js
import express from 'express';
import mongoose from 'mongoose';
import { getQueue } from '../infrastructure/queue/queueConfig.js';
import { getRedis } from '../services/redisClient.js';
import { staffOnly, minimalHealthBody } from '../middleware/observabilityAccess.js';

const router = express.Router();

/**
 * GET /api/v2/health - Health check completo do sistema 4.0
 */
// Público: só status e horário. Contagem das filas fica em /detalhes (com login).
router.get('/', async (req, res) => {
  let ok = mongoose.connection.readyState === 1;
  try { await getRedis().ping(); } catch { ok = false; }
  res.status(ok ? 200 : 503).json(minimalHealthBody(ok));
});

router.get('/detalhes', ...staffOnly, async (req, res) => {
  const checks = {
    mongodb: false,
    redis: false,
    queues: {}
  };
  
  // Check MongoDB
  try {
    checks.mongodb = mongoose.connection.readyState === 1;
  } catch (err) {
    checks.mongodb = false;
  }
  
  // Check Redis
  try {
    const redis = getRedis();
    await redis.ping();
    checks.redis = true;
  } catch (err) {
    checks.redis = false;
  }
  
  // Check Queues
  const queueNames = [
    'appointment-processing',
    'payment-processing',
    'complete-orchestrator',
    'outbox-processor',
    'patient-projection',
    'package-projection',
    'insurance-orchestrator'
  ];
  
  for (const name of queueNames) {
    try {
      const queue = getQueue(name);
      const [waiting, active, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getFailedCount()
      ]);
      
      checks.queues[name] = {
        status: 'ok',
        waiting,
        active,
        failed
      };
    } catch (err) {
      checks.queues[name] = {
        status: 'error',
        error: err.message
      };
    }
  }
  
  const allOk = checks.mongodb && checks.redis && 
    Object.values(checks.queues).every(q => q.status === 'ok');
  
  res.status(allOk ? 200 : 503).json({
    success: allOk,
    timestamp: new Date().toISOString(),
    version: '4.0.0',
    checks
  });
});

export default router;
