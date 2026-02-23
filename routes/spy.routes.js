import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import * as spyController from '../controllers/spyController.js';

const router = Router();
router.use(auth);

// Busca anúncios na Meta Ad Library
router.get('/ads', spyController.searchAds);

// Análise com IA
router.post('/analyze', spyController.analyzeAd);

// Adaptação para Fono Inova
router.post('/adapt', spyController.adaptAd);

// CRUD de salvos
router.get('/saved', spyController.listSaved);
router.post('/saved', spyController.saveAd);
router.delete('/saved/:id', spyController.deleteSaved);

// Keywords sugeridas
router.get('/keywords', spyController.getKeywords);

export default router;
