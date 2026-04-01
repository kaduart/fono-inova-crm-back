// insurance/insuranceRoutes.js
/**
 * Routes for Insurance API
 * 
 * Integração com dados reais de convênios
 */

import { Router } from 'express';
import {
    createBatchHandler,
    listBatchesHandler,
    getBatchHandler,
    sealBatchHandler,
    reprocessBatchHandler,
    simulateResponseHandler,
    getStatsHandler
} from './insuranceController.js';

import {
    listConveniosHandler,
    getConvenioValueHandler,
    getPendingSessionsHandler,
    createBatchAutoHandler,
    getConvenioStatsHandler,
    processReturnHandler,
    getDashboardSummaryHandler
} from './convenioApiController.js';

const router = Router();

// ============================================
// CONVÊNIOS (Dados Reais)
// ============================================

// Listar convênios ativos com estatísticas
router.get('/convenios', listConveniosHandler);

// Resumo geral (dashboard)
router.get('/resumo', getDashboardSummaryHandler);

// Valor de sessão de um convênio
router.get('/convenios/:code/valor', getConvenioValueHandler);

// Sessões pendentes de faturamento
router.get('/convenios/:code/sessoes-pendentes', getPendingSessionsHandler);

// Criar lote automaticamente
router.post('/convenios/:code/criar-lote', createBatchAutoHandler);

// Estatísticas do convênio
router.get('/convenios/:code/estatisticas', getConvenioStatsHandler);

// ============================================
// LOTES (Event-Driven)
// ============================================

// CRUD de lotes
router.post('/batches', createBatchHandler);
router.get('/batches', listBatchesHandler);
router.get('/batches/:id', getBatchHandler);

// Ações
router.post('/batches/:id/seal', sealBatchHandler);
router.post('/batches/:id/reprocess', reprocessBatchHandler);
router.post('/batches/:id/simulate-response', simulateResponseHandler);

// Processar retorno do convênio
router.post('/lotes/:id/processar-retorno', processReturnHandler);

// Estatísticas gerais
router.get('/stats', getStatsHandler);

// ============================================
// ADMIN - GERENCIAMENTO DE CONVÊNIOS
// ============================================

import {
    listAllConveniosHandler,
    getConvenioDetailsHandler,
    createConvenioHandler,
    updateConvenioHandler,
    deactivateConvenioHandler,
    activateConvenioHandler,
    importConveniosHandler,
    validateCodeHandler
} from './convenioManageController.js';

// CRUD de convênios
router.get('/admin/convenios', listAllConveniosHandler);
router.get('/admin/convenios/validar-codigo/:code', validateCodeHandler);
router.get('/admin/convenios/:code', getConvenioDetailsHandler);
router.post('/admin/convenios', createConvenioHandler);
router.put('/admin/convenios/:code', updateConvenioHandler);
router.delete('/admin/convenios/:code', deactivateConvenioHandler);
router.post('/admin/convenios/:code/ativar', activateConvenioHandler);

// Importação em massa
router.post('/admin/convenios/importar', importConveniosHandler);

export default router;
