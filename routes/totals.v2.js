// routes/totals.v2.js
/**
 * Rotas V2 para Totals - Event-driven
 * 
 * GET /v2/totals - Retorna snapshot (ou fallback para cálculo síncrono)
 * POST /v2/totals/recalculate - Solicita recálculo assíncrono
 * GET /v2/totals/status/:date - Status do cálculo
 */

import express from 'express';
import moment from 'moment-timezone';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import TotalsSnapshot from '../models/TotalsSnapshot.js';
import Payment from '../models/Payment.js';
import { createContextLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// ======================================================
// GET /v2/totals - Retorna totais (snapshot ou fallback)
// ======================================================
router.get('/', async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const log = createContextLogger(correlationId, 'totals_v2');
    
    try {
        const { clinicId, date, period = 'month', forceRecalculate } = req.query;
        const targetDate = date ? moment.tz(date, "America/Sao_Paulo") : moment.tz("America/Sao_Paulo");
        const dateStr = targetDate.format('YYYY-MM-DD');
        
        log.info('totals_requested', `Buscando totais: ${dateStr}`, { clinicId, period });

        // 🔹 ESTRATÉGIA 1: Busca snapshot
        let snapshot = await TotalsSnapshot.findOne({
            clinicId: clinicId || 'default',
            date: dateStr,
            period
        });

        // Se snapshot existe e não está stale, retorna
        const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutos
        const isStale = snapshot && (Date.now() - snapshot.calculatedAt.getTime() > STALE_THRESHOLD_MS);
        
        if (snapshot && !isStale && !forceRecalculate) {
            log.info('snapshot_hit', `Snapshot encontrado: ${dateStr}`);
            return res.json({
                success: true,
                data: {
                    totals: snapshot.totals,
                    period,
                    date: dateStr,
                    calculatedAt: snapshot.calculatedAt,
                    source: 'snapshot'
                },
                correlationId
            });
        }

        // 🔹 ESTRATÉGIA 2: Fallback síncrono (legado)
        log.info('snapshot_miss', `Calculando síncrono: ${dateStr}`);
        
        const now = targetDate;
        let rangeStart, rangeEnd;

        switch (period) {
            case "day":
                rangeStart = now.clone().startOf('day').toDate();
                rangeEnd = now.clone().endOf('day').toDate();
                break;
            case "week":
                rangeStart = now.clone().startOf('week').toDate();
                rangeEnd = now.clone().endOf('week').toDate();
                break;
            case "month":
                rangeStart = now.clone().startOf('month').toDate();
                rangeEnd = now.clone().endOf('month').toDate();
                break;
            case "year":
                rangeStart = now.clone().startOf('year').toDate();
                rangeEnd = now.clone().endOf('year').toDate();
                break;
            default:
                rangeStart = now.clone().startOf('month').toDate();
                rangeEnd = now.clone().endOf('month').toDate();
        }

        const matchStage = {
            status: { $ne: 'canceled' },
            $or: [
                {
                    paymentDate: {
                        $gte: rangeStart.toISOString().split('T')[0],
                        $lte: rangeEnd.toISOString().split('T')[0]
                    }
                },
                {
                    paymentDate: { $exists: false },
                    createdAt: { $gte: rangeStart, $lte: rangeEnd }
                }
            ]
        };

        if (clinicId) matchStage.clinicId = clinicId;

        const result = await Payment.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: null,
                    totalReceived: { 
                        $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] } 
                    },
                    totalPending: { 
                        $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0] } 
                    },
                    countReceived: { 
                        $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } 
                    },
                    countPending: { 
                        $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } 
                    },
                    particularReceived: {
                        $sum: {
                            $cond: [
                                { $and: [
                                    { $eq: ["$status", "paid"] },
                                    { $ne: ["$billingType", "convenio"] }
                                ]},
                                "$amount", 0
                            ]
                        }
                    }
                }
            }
        ]);

        const totals = result[0] || {
            totalReceived: 0,
            totalPending: 0,
            countReceived: 0,
            countPending: 0,
            particularReceived: 0
        };

        // Se snapshot estava stale, dispara recálculo em background
        if (isStale || forceRecalculate) {
            const eventId = uuidv4();
            await publishEvent(EventTypes.TOTALS_RECALCULATE_REQUESTED, {
                clinicId,
                date: dateStr,
                period,
                reason: isStale ? 'stale_snapshot' : 'force_recalculate'
            }, { correlationId, eventId });
            
            log.info('recalculate_triggered', `Recálculo em background: ${dateStr}`);
        }

        return res.json({
            success: true,
            data: {
                totals: {
                    totalReceived: totals.totalReceived,
                    totalPending: totals.totalPending,
                    countReceived: totals.countReceived,
                    countPending: totals.countPending,
                    particularReceived: totals.particularReceived
                },
                period,
                date: dateStr,
                source: 'sync_fallback',
                backgroundUpdate: isStale || forceRecalculate
            },
            correlationId
        });

    } catch (error) {
        log.error('totals_error', error.message);
        return res.status(500).json({
            success: false,
            error: error.message,
            correlationId
        });
    }
});

// ======================================================
// POST /v2/totals/recalculate - Solicita recálculo assíncrono
// ======================================================
router.post('/recalculate', async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const log = createContextLogger(correlationId, 'totals_v2');
    
    try {
        const { clinicId, date, period = 'month' } = req.body;
        const targetDate = date ? moment.tz(date, "America/Sao_Paulo") : moment.tz("America/Sao_Paulo");
        const dateStr = targetDate.format('YYYY-MM-DD');
        const eventId = uuidv4();

        log.info('recalculate_requested', `Solicitando recálculo: ${dateStr}`);
        console.log(`[TotalsV2] Publicando evento: ${eventId}`);

        try {
            const result = await publishEvent(EventTypes.TOTALS_RECALCULATE_REQUESTED, {
                clinicId,
                date: dateStr,
                period
            }, { correlationId, eventId });
            console.log(`[TotalsV2] Evento publicado:`, result);
        } catch (pubError) {
            console.error(`[TotalsV2] ERRO ao publicar:`, pubError.message);
            throw pubError;
        }

        return res.status(202).json({
            success: true,
            message: 'Recálculo solicitado',
            data: {
                eventId,
                status: 'pending',
                checkStatusUrl: `/api/v2/totals/status/${dateStr}?period=${period}&clinicId=${clinicId || ''}`
            },
            correlationId
        });

    } catch (error) {
        log.error('recalculate_error', error.message);
        return res.status(500).json({
            success: false,
            error: error.message,
            correlationId
        });
    }
});

// ======================================================
// GET /v2/totals/status/:date - Status do cálculo
// ======================================================
router.get('/status/:date', async (req, res) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    
    try {
        const { date } = req.params;
        const { clinicId, period = 'month' } = req.query;

        // Busca snapshot
        const snapshot = await TotalsSnapshot.findOne({
            clinicId: clinicId || 'default',
            date,
            period
        });

        if (!snapshot) {
            return res.json({
                success: true,
                data: {
                    status: 'not_calculated',
                    date,
                    period,
                    calculatedAt: null
                },
                correlationId
            });
        }

        const STALE_THRESHOLD_MS = 5 * 60 * 1000;
        const isStale = Date.now() - snapshot.calculatedAt.getTime() > STALE_THRESHOLD_MS;

        return res.json({
            success: true,
            data: {
                status: isStale ? 'stale' : 'ready',
                date,
                period,
                calculatedAt: snapshot.calculatedAt,
                totals: snapshot.totals
            },
            correlationId
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message,
            correlationId
        });
    }
});

export default router;
