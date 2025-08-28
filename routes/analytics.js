import express from 'express';
import { getGA4Events } from '../services/analytics.js';

const router = express.Router();

router.get('/events', async (req, res) => {
    try {
        const events = await getGA4Events();
        res.json(events);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar eventos GA4' });
    }
});

export default router;
