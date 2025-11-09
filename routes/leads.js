// routes/leads.js - VERSÃO COMPLETA ATUALIZADA
import express from 'express';
import {
    // 📊 Funções de planilha
    convertLeadToPatient,
    // 🆕 Funções de anúncios
    createLeadFromAd,
    createLeadFromSheet,
    // ✅ NOVAS - Listagem
    getAllLeads,
    getLeadById,
    getSheetMetrics,
    getWeeklyMetrics,
    googleLeadWebhook,
    metaLeadWebhook
} from '../controllers/leadController.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

// =====================================================================
// 📋 ROTAS DE LISTAGEM (NOVAS)
// =====================================================================
router.get('/', auth, getAllLeads);
router.get('/:id', auth, getLeadById);

// =====================================================================
// 🆕 ROTAS DE ANÚNCIOS (AMANDA 2.0)
// =====================================================================
router.post('/from-ad', auth, createLeadFromAd);

// Webhooks Meta Ads (públicos)
router.get('/webhook/meta', metaLeadWebhook);
router.post('/webhook/meta', metaLeadWebhook);

// Webhook Google Ads (público)
router.post('/webhook/google', googleLeadWebhook);

// =====================================================================
// 📊 ROTAS DE PLANILHA (EXISTENTES)
// =====================================================================
router.post('/from-sheet', createLeadFromSheet);
router.get('/sheet-metrics', getSheetMetrics);
router.get('/weekly-metrics', getWeeklyMetrics);
router.post('/:leadId/convert-to-patient', convertLeadToPatient);

export default router;