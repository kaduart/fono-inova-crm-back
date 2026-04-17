/**
 * 🖥️ Admin System Routes
 * - Bull Board dashboard em /admin/queues
 * - API de monitoramento em /api/admin/system-monitor
 */

import { Router } from 'express';
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { auth } from '../middleware/auth.js';
import { redisConnection } from '../config/redisConnection.js';
import mongoose from 'mongoose';

// Filas do event publisher
import { queues as eventQueues } from '../infrastructure/events/eventPublisher.js';

// Filas legadas/config
import {
  followupQueue,
  warmLeadFollowupQueue,
  videoGenerationQueue,
  posProducaoQueue,
  postGenerationQueue,
  doctorQueue
} from '../config/bullConfig.js';

import { gmbPublishRetryQueue } from '../config/bullConfigGmbRetry.js';

const router = Router();

// ==========================
// 1. BULL BOARD (Dashboard)
// ==========================
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues/");
export { serverAdapter };

const allQueues = [
  // Event-driven queues
  ...Object.values(eventQueues),
  // Legacy/config queues
  followupQueue,
  warmLeadFollowupQueue,
  videoGenerationQueue,
  posProducaoQueue,
  postGenerationQueue,
  doctorQueue,
  gmbPublishRetryQueue
];

// Remove duplicatas por nome (safety)
const uniqueQueues = [];
const seen = new Set();
for (const q of allQueues) {
  if (!seen.has(q.name)) {
    seen.add(q.name);
    uniqueQueues.push(q);
  }
}

createBullBoard({
  queues: uniqueQueues.map((q) => new BullMQAdapter(q)),
  serverAdapter,
});

// Nota: o Bull Board é montado em /admin/queues diretamente no server.js
// para manter URLs curtas e compatíveis

// ==========================
// 2. SYSTEM MONITOR API
// ==========================
router.get("/system-monitor", auth, async (req, res) => {
  try {
    const queueStats = [];

    for (const q of uniqueQueues) {
      try {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
          q.getWaitingCount(),
          q.getActiveCount(),
          q.getCompletedCount(),
          q.getFailedCount(),
          q.getDelayedCount()
        ]);

        queueStats.push({
          name: q.name,
          waiting,
          active,
          completed,
          failed,
          delayed,
          total: waiting + active + completed + failed + delayed
        });
      } catch (err) {
        queueStats.push({
          name: q.name,
          error: err.message
        });
      }
    }

    // Health Redis
    let redisHealth = { status: 'unknown' };
    try {
      await redisConnection.ping();
      redisHealth = { status: 'ok', connected: true };
    } catch (err) {
      redisHealth = { status: 'error', message: err.message };
    }

    // Health MongoDB
    let mongoHealth = { status: 'unknown' };
    try {
      const admin = mongoose.connection.db.admin();
      const result = await admin.ping();
      mongoHealth = { status: 'ok', ping: result?.ok === 1 };
    } catch (err) {
      mongoHealth = { status: 'error', message: err.message };
    }

    // Uptime / memória
    const memory = process.memoryUsage();

    res.json({
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
      },
      redis: redisHealth,
      mongodb: mongoHealth,
      queues: queueStats,
      totalQueues: uniqueQueues.length
    });
  } catch (error) {
    console.error('[AdminSystem] Erro no monitor:', error.message);
    res.status(500).json({ error: 'Falha ao coletar métricas do sistema' });
  }
});

export default router;
