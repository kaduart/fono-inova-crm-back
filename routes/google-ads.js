import express from 'express';
import { getCampaigns, getAds } from '../services/google-ads.js';
import { validateGoogleAdsData } from '../middleware/googleValidation.js';

const router = express.Router();

router.get('/campaigns', validateGoogleAdsData, async (req, res) => {
  try {
    const campaigns = await getCampaigns();
    res.json(campaigns);
  } catch (error) {
    console.error('Erro detalhado:', error);
    res.status(500).json({
      error: 'Erro ao buscar campanhas',
      details: error.message
    });
  }
});

router.get('/ads', validateGoogleAdsData, async (req, res) => {
  try {
    const ads = await getAds();
    res.json(ads);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar anúncios' });
  }
});

export default router;
