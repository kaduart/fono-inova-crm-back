// insurance/convenioApiController.js
/**
 * API Controller para integração com Convênios
 * 
 * Endpoints que usam dados reais do banco (Convenio, InsuranceBatch, etc)
 */

import {
    getActiveConvenios,
    getConvenioSessionValue,
    findPendingSessionsForBilling,
    createBatchFromPendingSessions,
    processConvenioReturn,
    getConvenioStats,
    getAllConveniosWithStats
} from './services/convenioIntegrationService.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import { sendApiError } from '../../errors/buildErrorResponse.js';
import { AppError } from '../../errors/AppError.js';

/**
 * GET /api/insurance/convenios
 * Lista todos os convênios ativos com estatísticas
 */
export async function listConveniosHandler(req, res) {
    try {
        const convenios = await getAllConveniosWithStats();
        
        res.json({
            success: true,
            data: convenios
        });
    } catch (error) {
        console.error('[ConvenioApi] Erro ao listar convênios:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao buscar convênios',
          }),
          req
        );
    }
}

/**
 * GET /api/insurance/convenios/:code/valor
 * Busca valor de sessão para um convênio
 */
export async function getConvenioValueHandler(req, res) {
    try {
        const { code } = req.params;
        
        const value = await getConvenioSessionValue(code);
        
        res.json({
            success: true,
            data: {
                convenioCode: code,
                sessionValue: value
            }
        });
    } catch (error) {
        console.error('[ConvenioApi] Erro ao buscar valor:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao buscar valor',
          }),
          req
        );
    }
}

/**
 * GET /api/insurance/convenios/:code/sessoes-pendentes
 * Busca sessões pendentes de faturamento para um convênio
 */
export async function getPendingSessionsHandler(req, res) {
    try {
        const { code } = req.params;
        const { startDate, endDate } = req.query;
        
        if (!startDate || !endDate) {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Datas de início e fim são obrigatórias', {
                status: 400,
              }),
              req
            );
        }
        
        const sessions = await findPendingSessionsForBilling(startDate, endDate, code);
        
        // Calcula valor total estimado
        const sessionValue = await getConvenioSessionValue(code);
        const totalEstimated = sessions.length * sessionValue;
        
        res.json({
            success: true,
            data: {
                convenioCode: code,
                sessionsCount: sessions.length,
                sessionValue,
                totalEstimated,
                sessions: sessions.map(s => ({
                    id: s._id,
                    date: s.date,
                    patient: s.patient?.name,
                    doctor: s.doctor?.name,
                    specialty: s.specialty
                }))
            }
        });
    } catch (error) {
        console.error('[ConvenioApi] Erro ao buscar sessões:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao buscar sessões',
          }),
          req
        );
    }
}

/**
 * POST /api/insurance/convenios/:code/criar-lote
 * Cria um lote automaticamente a partir de sessões pendentes
 */
export async function createBatchAutoHandler(req, res) {
    try {
        const { code } = req.params;
        const { startDate, endDate } = req.body;
        
        if (!startDate || !endDate) {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Datas de início e fim são obrigatórias', {
                status: 400,
              }),
              req
            );
        }
        
        const result = await createBatchFromPendingSessions({
            convenioCode: code,
            startDate,
            endDate,
            createdBy: req.user?._id
        });
        
        if (!result.success) {
            return res.status(400).json(result);
        }
        
        res.status(201).json({
            success: true,
            message: 'Lote criado com sucesso',
            data: result
        });
    } catch (error) {
        console.error('[ConvenioApi] Erro ao criar lote:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao criar lote',
          }),
          req
        );
    }
}

/**
 * GET /api/insurance/convenios/:code/estatisticas
 * Estatísticas de faturamento para um convênio
 */
export async function getConvenioStatsHandler(req, res) {
    try {
        const { code } = req.params;
        const { startDate, endDate } = req.query;
        
        // Se não informar datas, usa últimos 30 dias
        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate ? new Date(startDate) : new Date(end - 30 * 24 * 60 * 60 * 1000);
        
        const stats = await getConvenioStats(code, start, end);
        
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('[ConvenioApi] Erro ao buscar estatísticas:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao buscar estatísticas',
          }),
          req
        );
    }
}

/**
 * POST /api/insurance/lotes/:id/processar-retorno
 * Processa retorno do convênio (atualiza sessões pagas/rejeitadas)
 */
export async function processReturnHandler(req, res) {
    try {
        const { id } = req.params;
        const { items, receivedAmount, returnFile } = req.body;
        
        if (!items || !Array.isArray(items)) {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Items do retorno são obrigatórios', {
                status: 400,
              }),
              req
            );
        }
        
        const result = await processConvenioReturn(id, {
            items,
            receivedAmount,
            returnFile
        });
        
        res.json({
            success: true,
            message: 'Retorno processado com sucesso',
            data: result
        });
    } catch (error) {
        console.error('[ConvenioApi] Erro ao processar retorno:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao processar retorno',
          }),
          req
        );
    }
}

/**
 * GET /api/insurance/resumo
 * Resumo geral de todos os convênios (dashboard)
 */
export async function getDashboardSummaryHandler(req, res) {
    try {
        // Lotes por status
        const batchesByStatus = await InsuranceBatch.aggregate([
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                    totalGross: { $sum: '$totalGross' },
                    totalReceived: { $sum: '$receivedAmount' }
                }
            }
        ]);
        
        // Convênios ativos
        const convenios = await getAllConveniosWithStats();
        
        // Totais gerais
        const totals = await InsuranceBatch.aggregate([
            {
                $group: {
                    _id: null,
                    totalSessions: { $sum: '$totalSessions' },
                    totalGross: { $sum: '$totalGross' },
                    totalReceived: { $sum: '$receivedAmount' },
                    totalGlosa: { $sum: '$totalGlosa' }
                }
            }
        ]);
        
        res.json({
            success: true,
            data: {
                batchesByStatus: batchesByStatus.reduce((acc, b) => {
                    acc[b._id] = {
                        count: b.count,
                        totalGross: b.totalGross,
                        totalReceived: b.totalReceived
                    };
                    return acc;
                }, {}),
                convenios,
                totals: totals[0] || {
                    totalSessions: 0,
                    totalGross: 0,
                    totalReceived: 0,
                    totalGlosa: 0
                }
            }
        });
    } catch (error) {
        console.error('[ConvenioApi] Erro ao buscar resumo:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao buscar resumo',
          }),
          req
        );
    }
}
