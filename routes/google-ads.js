import express from 'express';
import { getCampaigns, getAds } from '../services/google-ads.js';
import { validateGoogleAdsData } from '../middleware/googleValidation.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = express.Router();

router.get('/campaigns', validateGoogleAdsData, async (req, res) => {
  try {
    const campaigns = await getCampaigns();
    res.json(campaigns);
  } catch (error) {
    console.error('Erro detalhado:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', 'Erro ao buscar campanhas', {
        status: 500,
        details: error.message,
      }),
      req
    );
  }
});

router.get('/ads', validateGoogleAdsData, async (req, res) => {
  try {
    const ads = await getAds();
    res.json(ads);
  } catch (err) {
    console.error(err);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao buscar anúncios', { status: 500 }), req);
  }
});

export default router;
