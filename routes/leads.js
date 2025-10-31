// routes/leads.js
import express from 'express';
import {
    convertLeadToPatient,
    createLeadFromSheet,
    getSheetMetrics,
    getWeeklyMetrics
} from '../controllers/leadController.js';

const router = express.Router();

// Rotas específicas para integração com as planilhas
router.post('/from-sheet', createLeadFromSheet);
router.get('/sheet-metrics', getSheetMetrics);
router.get('/weekly-metrics', getWeeklyMetrics);
router.post('/:leadId/convert-to-patient', convertLeadToPatient);

export default router;