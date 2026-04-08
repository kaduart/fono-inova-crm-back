// routes/dailyClosing.v2.js
/**
 * Caixa / Fluxo de Caixa V2
 * 
 * GET /api/v2/daily-closing?startDate=2026-04-01&endDate=2026-04-07
 * Retorna: resumo do período + array diário para gráfico
 */

import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import DailyClosingSnapshot from '../models/DailyClosingSnapshot.js';
import { calculateDailyClosing } from '../services/dailyClosing/index.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

/**
 * Busca ou calcula fechamento de um dia específico
 */
async function getOrCalculateDailyClosing(date, clinicId, forceRefresh = false) {
    // Se forçar refresh, deleta snapshot existente
    if (forceRefresh) {
        await DailyClosingSnapshot.deleteOne({
            date,
            clinicId: clinicId || 'default'
        });
        console.log(`[DailyClosingV2] Snapshot deletado para refresh: ${date}`);
    }
    
    // Busca snapshot
    const snapshot = await DailyClosingSnapshot.findOne({
        date,
        clinicId: clinicId || 'default'
    }).lean();

    if (snapshot) {
        console.log(`[DailyClosingV2] Retornando snapshot: ${date}`);
        return snapshot.report;
    }

    // Calcula síncrono
    console.log(`[DailyClosingV2] Calculando: ${date}`);
    const report = await calculateDailyClosing(date, clinicId);
    
    // Salva para próximas requisições
    await DailyClosingSnapshot.create({
        date,
        clinicId: clinicId || 'default',
        report,
        calculatedAt: new Date()
    });

    return report;
}

/**
 * GET /api/v2/daily-closing
 * 
 * Query params:
 * - date: data específica (YYYY-MM-DD) - compatibilidade legacy
 * - startDate: início do período (YYYY-MM-DD)
 * - endDate: fim do período (YYYY-MM-DD)
 * 
 * Se só date for passado, retorna aquele dia.
 * Se startDate/endDate forem passados, retorna período.
 */
router.get('/', auth, async (req, res) => {
    try {
        const { date, startDate, endDate, refresh } = req.query;
        const clinicId = req.user?.clinicId || 'default';
        const forceRefresh = refresh === 'true';

        // Modo LEGACY: apenas uma data
        if (date && !startDate && !endDate) {
            const targetDate = moment.tz(date, TIMEZONE).format('YYYY-MM-DD');
            const report = await getOrCalculateDailyClosing(targetDate, clinicId, forceRefresh);
            
            return res.json({
                success: true,
                data: report,
                meta: { 
                    mode: 'single',
                    date: targetDate,
                    source: 'snapshot_or_calculated'
                }
            });
        }

        // Modo PERÍODO: startDate até endDate
        const start = startDate 
            ? moment.tz(startDate, TIMEZONE).startOf('day')
            : moment.tz(TIMEZONE).startOf('day');
        
        const end = endDate
            ? moment.tz(endDate, TIMEZONE).endOf('day')
            : moment.tz(TIMEZONE).endOf('day');

        // Limita a 31 dias para performance
        const daysDiff = end.diff(start, 'days');
        if (daysDiff > 31) {
            return res.status(400).json({
                success: false,
                error: 'Período máximo: 31 dias',
                maxDays: 31,
                requestedDays: daysDiff
            });
        }

        // Busca dados de cada dia
        const dailyData = [];
        let totalReceived = 0;
        let totalExpected = 0;
        let totalAppointments = 0;
        let totalConfirmed = 0;

        const current = start.clone();
        while (current.isSameOrBefore(end, 'day')) {
            const dateStr = current.format('YYYY-MM-DD');
            
            try {
                const report = await getOrCalculateDailyClosing(dateStr, clinicId);
                
                const received = report.summary?.financial?.totalReceived || 0;
                const expected = report.summary?.financial?.totalExpected || 0;
                const appointments = report.summary?.appointments?.total || 0;
                const confirmed = report.summary?.appointments?.attended || 0;

                dailyData.push({
                    date: dateStr,
                    received,
                    expected,
                    appointments,
                    confirmed,
                    attendanceRate: appointments > 0 ? (confirmed / appointments) * 100 : 0
                });

                totalReceived += received;
                totalExpected += expected;
                totalAppointments += appointments;
                totalConfirmed += confirmed;

            } catch (err) {
                console.error(`[DailyClosingV2] Erro no dia ${dateStr}:`, err.message);
                dailyData.push({
                    date: dateStr,
                    received: 0,
                    expected: 0,
                    appointments: 0,
                    confirmed: 0,
                    attendanceRate: 0,
                    error: true
                });
            }

            current.add(1, 'day');
        }

        // Calcula comparativo com período anterior
        const periodDays = daysDiff + 1;
        const previousStart = start.clone().subtract(periodDays, 'days');
        const previousEnd = end.clone().subtract(periodDays, 'days');
        
        let previousTotal = 0;
        const prevCurrent = previousStart.clone();
        while (prevCurrent.isSameOrBefore(previousEnd, 'day')) {
            const dateStr = prevCurrent.format('YYYY-MM-DD');
            try {
                const report = await getOrCalculateDailyClosing(dateStr, clinicId);
                previousTotal += report.summary?.financial?.totalReceived || 0;
            } catch (e) {
                // ignora erro no período anterior
            }
            prevCurrent.add(1, 'day');
        }

        const variation = previousTotal > 0 
            ? ((totalReceived - previousTotal) / previousTotal) * 100 
            : 0;

        res.json({
            success: true,
            data: {
                period: {
                    start: start.format('YYYY-MM-DD'),
                    end: end.format('YYYY-MM-DD'),
                    days: periodDays
                },
                summary: {
                    totalReceived,
                    totalExpected,
                    totalPending: totalExpected - totalReceived,
                    totalAppointments,
                    totalConfirmed,
                    attendanceRate: totalAppointments > 0 ? (totalConfirmed / totalAppointments) * 100 : 0,
                    collectionRate: totalExpected > 0 ? (totalReceived / totalExpected) * 100 : 0
                },
                comparison: {
                    previousPeriodTotal: previousTotal,
                    variation: Math.round(variation * 100) / 100,
                    trend: variation >= 0 ? 'up' : 'down'
                },
                daily: dailyData
            },
            meta: {
                mode: 'period',
                source: 'snapshot_or_calculated'
            }
        });

    } catch (error) {
        console.error('[DailyClosingV2] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST - Calcula e salva snapshot síncrono (mantém para compatibilidade)
router.post('/run', auth, async (req, res) => {
    try {
        const { date } = req.body;
        const targetDate = date
            ? moment.tz(date, TIMEZONE).format('YYYY-MM-DD')
            : moment.tz(TIMEZONE).format('YYYY-MM-DD');

        const report = await calculateDailyClosing(targetDate, req.user?.clinicId);

        await DailyClosingSnapshot.findOneAndUpdate(
            { date: targetDate, clinicId: req.user?.clinicId || 'default' },
            { date: targetDate, clinicId: req.user?.clinicId || 'default', report, calculatedAt: new Date() },
            { upsert: true }
        );

        res.status(202).json({
            success: true,
            message: 'Fechamento calculado',
            data: { date: targetDate, status: 'processed' }
        });

    } catch (error) {
        console.error('[DailyClosingV2] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
