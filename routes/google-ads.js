import express from 'express';
import { getAds, getCampaigns } from '../services/google-ads.js';

const router = express.Router();

router.get('/campaigns', async (req, res) => {
    try {
        const campaigns = await getCampaigns();
        res.json(campaigns);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar campanhas' });
    }
});

router.get('/ads', async (req, res) => {
    try {
        const ads = await getAds();
        res.json(ads);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar anúncios' });
    }
});

export default router;
