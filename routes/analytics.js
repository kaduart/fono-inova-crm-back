import dotenv from 'dotenv';
import express from 'express';
import { analyzeHistoricalConversations, getLatestInsights } from '../services/amandaLearningService.js';

import { getGA4Events, getGA4Metrics } from '../services/analytics.js';
import { getInternalAnalytics } from '../services/analyticsInternal.js';
dotenv.config();

const router = express.Router();
function getDefaultDates() {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 7);

    const format = (d) => d.toISOString().split('T')[0];
    return { startDate: format(start), endDate: format(end) };
}

router.get('/events', async (req, res) => {
    try {
        let { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            ({ startDate, endDate } = getDefaultDates());
        }

        // Tenta GA4 primeiro
        let events = await getGA4Events(startDate, endDate);
        
        // Se GA4 retornar vazio ou falhar, usa dados internos
        if (!events || events.length === 0) {
            console.log('📊 GA4 vazio, usando dados internos...');
            const internal = await getInternalAnalytics(startDate, endDate);
            events = internal.events;
        }
        
        res.json(events);
    } catch (err) {
        console.error('❌ Erro em /events:', err.message);
        // Mesmo em erro, tenta retornar dados internos
        try {
            let { startDate, endDate } = req.query;
            if (!startDate || !endDate) {
                ({ startDate, endDate } = getDefaultDates());
            }
            const internal = await getInternalAnalytics(startDate, endDate);
            res.json(internal.events);
        } catch (internalErr) {
            res.status(500).json({ error: 'Erro ao buscar eventos' });
        }
    }
});


router.get('/metrics', async (req, res) => {
    try {
        let { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            ({ startDate, endDate } = getDefaultDates());
        }

        // Tenta GA4 primeiro
        let metrics = await getGA4Metrics(startDate, endDate);
        
        // Se GA4 retornar zerado ou falhar, usa dados internos
        if (!metrics || metrics.totalUsers === 0) {
            console.log('📊 GA4 zerado, usando dados internos...');
            const internal = await getInternalAnalytics(startDate, endDate);
            if (internal.metrics) {
                metrics = internal.metrics;
            }
        }
        
        res.json(metrics);
    } catch (err) {
        console.error('❌ Erro em /metrics:', err.message);
        // Mesmo em erro, tenta retornar dados internos
        try {
            let { startDate, endDate } = req.query;
            if (!startDate || !endDate) {
                ({ startDate, endDate } = getDefaultDates());
            }
            const internal = await getInternalAnalytics(startDate, endDate);
            res.json(internal.metrics);
        } catch (internalErr) {
            res.status(500).json({ error: 'Erro ao buscar métricas' });
        }
    }
});

// POST /api/analytics/learn (Roda análise manual)
router.post('/learn', async (req, res) => {
    try {
        const insights = await analyzeHistoricalConversations();
        res.json({
            success: true,
            insights,
            message: 'Análise completa! Insights salvos.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/analytics/insights (Vê insights atuais)
router.get('/insights', async (req, res) => {
    try {
        const insights = await getLatestInsights();
        res.json(insights);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
