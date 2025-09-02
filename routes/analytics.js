import express from 'express';
import { getGA4Events, getGA4Metrics } from '../services/analytics.js';

const router = express.Router();

// Eventos
router.get('/events', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const events = await getGA4Events(startDate, endDate);
        res.json(events);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar eventos GA4' });
    }
});

// Métricas gerais
router.get('/metrics', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const metrics = await getGA4Metrics(startDate, endDate);
        res.json(metrics);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar métricas GA4' });
    }
});

export default router;
