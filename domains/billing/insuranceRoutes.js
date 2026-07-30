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

// Investigação de arquitetura de convênio (2026-07-29) não achou nenhum chamador real
// (frontend, job, script) para as rotas abaixo, exceto o bloco ADMIN no fim do arquivo.
// Em vez de apagar direto, elas ficam instrumentadas por um ciclo de validação: se
// alguma disparar em produção, o warning abaixo aparece no log com quem chamou.
function warnDeprecated(routeLabel) {
    return (req, res, next) => {
        console.warn(
            `[DEPRECATED] Rota de convênio "${routeLabel}" chamada — candidata a remoção ` +
            `(investigação 2026-07-29), verificar quem ainda usa. ` +
            `method=${req.method} path=${req.originalUrl} ip=${req.ip} ` +
            `userId=${req.user?.id ?? 'não autenticado'} role=${req.user?.role ?? 'n/a'} ` +
            `userAgent=${req.get('User-Agent') ?? 'n/a'}`
        );
        next();
    };
}

// ============================================
// CONVÊNIOS (Dados Reais)
// ============================================

// Listar convênios ativos com estatísticas
router.get('/convenios', warnDeprecated('listConveniosHandler'), listConveniosHandler);

// Resumo geral (dashboard)
router.get('/resumo', warnDeprecated('getDashboardSummaryHandler'), getDashboardSummaryHandler);

// Valor de sessão de um convênio
router.get('/convenios/:code/valor', warnDeprecated('getConvenioValueHandler'), getConvenioValueHandler);

// Sessões pendentes de faturamento
router.get('/convenios/:code/sessoes-pendentes', warnDeprecated('getPendingSessionsHandler'), getPendingSessionsHandler);

// Criar lote automaticamente
router.post('/convenios/:code/criar-lote', warnDeprecated('createBatchAutoHandler'), createBatchAutoHandler);

// Estatísticas do convênio
router.get('/convenios/:code/estatisticas', warnDeprecated('getConvenioStatsHandler'), getConvenioStatsHandler);

// ============================================
// LOTES (Event-Driven)
// ============================================

// CRUD de lotes
router.post('/batches', warnDeprecated('createBatchHandler'), createBatchHandler);
router.get('/batches', warnDeprecated('listBatchesHandler'), listBatchesHandler);
router.get('/batches/:id', warnDeprecated('getBatchHandler'), getBatchHandler);

// Ações
router.post('/batches/:id/seal', warnDeprecated('sealBatchHandler'), sealBatchHandler);
router.post('/batches/:id/reprocess', warnDeprecated('reprocessBatchHandler'), reprocessBatchHandler);
router.post('/batches/:id/simulate-response', warnDeprecated('simulateResponseHandler'), simulateResponseHandler);

// Processar retorno do convênio (Categoria C — validar operacionalmente antes de remover)
router.post('/lotes/:id/processar-retorno', warnDeprecated('processReturnHandler'), processReturnHandler);

// Estatísticas gerais
router.get('/stats', warnDeprecated('getStatsHandler'), getStatsHandler);

// ============================================
// ADMIN - GERENCIAMENTO DE CONVÊNIOS
// ============================================

import { auth } from '../../middleware/auth.js';
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

// CRUD de convênios — gap de auth achado em 2026-07-29 (investigação de arquitetura de
// convênio): essas rotas nunca tiveram `auth`, nem aqui nem no app.use de server.js.
// O frontend já manda o JWT em toda chamada (não está na lista de rotas públicas de
// front/src/services/api.ts), então aplicar auth aqui não deveria quebrar a UI.
router.get('/admin/convenios', auth, listAllConveniosHandler);
router.get('/admin/convenios/validar-codigo/:code', auth, validateCodeHandler);
router.get('/admin/convenios/:code', auth, getConvenioDetailsHandler);
router.post('/admin/convenios', auth, createConvenioHandler);
router.put('/admin/convenios/:code', auth, updateConvenioHandler);
router.delete('/admin/convenios/:code', auth, deactivateConvenioHandler);
router.post('/admin/convenios/:code/ativar', auth, activateConvenioHandler);

// Importação em massa (Categoria C — validar operacionalmente antes de remover)
router.post('/admin/convenios/importar', auth, warnDeprecated('importConveniosHandler'), importConveniosHandler);

export default router;
