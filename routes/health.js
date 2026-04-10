/**
 * 🔥 HEALTH CHECK ENDPOINT
 * 
 * Monitora saúde do sistema:
 * - Eventos travados em processing
 * - Filas com backlog
 * - Memória
 * - Inconsistências
 * 
 * Uso: GET /api/health
 *        GET /api/health/detailed (com estatísticas completas)
 */

import express from 'express';
import mongoose from 'mongoose';
import EventStore from '../models/EventStore.js';
import Appointment from '../models/Appointment.js';
import { Queue } from 'bullmq';
import { redisConnection } from '../infrastructure/queue/queueConfig.js';

const router = express.Router();

// Thresholds de alerta
const ALERTS = {
    stuckEvents: 5,           // +5 eventos travados = alerta
    stuckMinutes: 10,         // Eventos travados há +10 min
    memoryPercent: 85,        // Memória acima de 85%
    queueWaiting: 50          // +50 jobs esperando
};

/**
 * Health check básico
 * GET /api/health
 */
router.get('/', async (req, res) => {
    try {
        const checks = await runBasicChecks();
        const isHealthy = checks.status === 'healthy';
        
        res.status(isHealthy ? 200 : 503).json({
            status: checks.status,
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            checks: checks.details
        });
    } catch (error) {
        res.status(503).json({
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Health check detalhado
 * GET /api/health/detailed
 */
router.get('/detailed', async (req, res) => {
    try {
        const [basic, detailed] = await Promise.all([
            runBasicChecks(),
            runDetailedChecks()
        ]);
        
        const isHealthy = basic.status === 'healthy' && detailed.criticalIssues === 0;
        
        res.status(isHealthy ? 200 : 503).json({
            status: isHealthy ? 'healthy' : 'degraded',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            summary: {
                basic: basic.details,
                detailed: detailed.summary
            },
            alerts: detailed.alerts,
            metrics: detailed.metrics
        });
    } catch (error) {
        res.status(503).json({
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Verifica eventos travados
 * GET /api/health/stuck-events
 */
router.get('/stuck-events', async (req, res) => {
    try {
        const minAgeMinutes = parseInt(req.query.minutes) || ALERTS.stuckMinutes;
        const minAgeMs = minAgeMinutes * 60 * 1000;
        const cutoffTime = new Date(Date.now() - minAgeMs);

        const stuckEvents = await EventStore.find({
            status: 'processing',
            updatedAt: { $lt: cutoffTime }
        })
        .select('eventId eventType aggregateId updatedAt createdAt')
        .sort({ updatedAt: 1 })
        .limit(50);

        const eventsWithAge = stuckEvents.map(evt => ({
            ...evt.toObject(),
            stuckMinutes: Math.round((Date.now() - evt.updatedAt.getTime()) / 60000)
        }));

        const isAlert = stuckEvents.length >= ALERTS.stuckEvents;

        res.status(isAlert ? 503 : 200).json({
            status: isAlert ? 'alert' : 'ok',
            count: stuckEvents.length,
            threshold: ALERTS.stuckEvents,
            minAgeMinutes,
            events: eventsWithAge
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Verifica filas
 * GET /api/health/queues
 */
router.get('/queues', async (req, res) => {
    try {
        const queueNames = [
            'complete-orchestrator',
            'cancel-orchestrator',
            'package-projection',
            'package-validation',
            'patient-projection',
            'totals-calculation',
            'daily-closing'
        ];

        const queueStats = {};
        let hasAlert = false;

        for (const name of queueNames) {
            try {
                const queue = new Queue(name, { connection: redisConnection });
                const [waiting, active, completed, failed, delayed] = await Promise.all([
                    queue.getWaitingCount(),
                    queue.getActiveCount(),
                    queue.getCompletedCount(),
                    queue.getFailedCount(),
                    queue.getDelayedCount()
                ]);

                queueStats[name] = {
                    waiting,
                    active,
                    completed,
                    failed,
                    delayed,
                    alert: waiting > ALERTS.queueWaiting
                };

                if (queueStats[name].alert) hasAlert = true;
                await queue.close();
            } catch (err) {
                queueStats[name] = { error: err.message };
            }
        }

        res.status(hasAlert ? 503 : 200).json({
            status: hasAlert ? 'alert' : 'ok',
            queues: queueStats,
            alertThreshold: ALERTS.queueWaiting
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// FUNÇÕES AUXILIARES
// ==========================================

async function runBasicChecks() {
    const checks = {
        database: false,
        memory: { ok: false, percent: 0 },
        stuckEvents: { count: 0, alert: false }
    };

    // 1. Database
    checks.database = mongoose.connection.readyState === 1;

    // 2. Memória
    const memUsage = process.memoryUsage();
    const heapPercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);
    checks.memory = {
        ok: heapPercent < ALERTS.memoryPercent,
        percent: heapPercent,
        used: Math.round(memUsage.heapUsed / 1024 / 1024),
        total: Math.round(memUsage.heapTotal / 1024 / 1024)
    };

    // 3. Eventos travados
    const minAgeMs = ALERTS.stuckMinutes * 60 * 1000;
    const stuckCount = await EventStore.countDocuments({
        status: 'processing',
        updatedAt: { $lt: new Date(Date.now() - minAgeMs) }
    });
    checks.stuckEvents = {
        count: stuckCount,
        alert: stuckCount >= ALERTS.stuckEvents
    };

    // Determina status geral
    const hasIssues = !checks.database || 
                      !checks.memory.ok || 
                      checks.stuckEvents.alert;

    return {
        status: hasIssues ? 'degraded' : 'healthy',
        details: checks
    };
}

async function runDetailedChecks() {
    const alerts = [];
    const metrics = {};

    // 1. Appointments por status
    metrics.appointments = await Appointment.aggregate([
        { $group: { _id: '$operationalStatus', count: { $sum: 1 } } }
    ]);

    // 2. Eventos por status (últimas 24h)
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    metrics.events24h = await EventStore.aggregate([
        { 
            $match: { createdAt: { $gte: last24h } }
        },
        { 
            $group: { 
                _id: '$status', 
                count: { $sum: 1 },
                types: { $addToSet: '$eventType' }
            } 
        }
    ]);

    // 3. Inconsistências
    const inconsistentAppointments = await Appointment.countDocuments({
        operationalStatus: 'processing_complete',
        updatedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) }
    });

    if (inconsistentAppointments > 0) {
        alerts.push({
            level: 'warning',
            type: 'inconsistent_appointments',
            message: `${inconsistentAppointments} appointments travados há +10 min`,
            count: inconsistentAppointments
        });
    }

    // 4. Verifica se há eventos MUITO antigos (mais de 1 hora)
    const veryOldEvents = await EventStore.countDocuments({
        status: 'processing',
        updatedAt: { $lt: new Date(Date.now() - 60 * 60 * 1000) }
    });

    if (veryOldEvents > 0) {
        alerts.push({
            level: 'critical',
            type: 'very_old_stuck_events',
            message: `${veryOldEvents} eventos travados há +1 hora`,
            count: veryOldEvents
        });
    }

    return {
        summary: {
            appointmentsByStatus: metrics.appointments,
            eventsLast24h: metrics.events24h
        },
        metrics,
        alerts,
        criticalIssues: alerts.filter(a => a.level === 'critical').length
    };
}

export default router;
