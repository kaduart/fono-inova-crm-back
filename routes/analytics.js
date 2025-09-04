import dotenv from 'dotenv';
import express from 'express';
import { getGA4Events, getGA4Metrics } from '../services/analytics.js';
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

        const events = await getGA4Events(startDate, endDate);
        res.json(events);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar eventos GA4' });
    }
});


router.get('/metrics', async (req, res) => {
    try {
        let { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            ({ startDate, endDate } = getDefaultDates());
        }

        const metrics = await getGA4Metrics(startDate, endDate);
        res.json(metrics);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar métricas GA4' });
    }
});

export default router;
