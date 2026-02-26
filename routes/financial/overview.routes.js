// routes/financial/overview.routes.js
// Endpoint consolidado para Visão Geral Estratégica

import express from 'express';
import { auth, authorize } from '../../middleware/auth.js';
import FinancialOverviewService from '../../services/financial/FinancialOverviewService.js';

const router = express.Router();

/**
 * @route   GET /api/financial/overview
 * @desc    Visão geral financeira estratégica com comparação de períodos
 * @query   month (number), year (number), compare (optional: previous|lastYear)
 * @access  Admin/Secretary
 */
router.get('/', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { month, year, compare = 'previous' } = req.query;

        // Validações
        if (!month || !year) {
            return res.status(400).json({
                success: false,
                error: 'Parâmetros obrigatórios: month e year'
            });
        }

        const mes = parseInt(month);
        const ano = parseInt(year);

        if (mes < 1 || mes > 12) {
            return res.status(400).json({
                success: false,
                error: 'Mês deve estar entre 1 e 12'
            });
        }

        console.log(`[FinancialOverview] Buscando overview para ${mes}/${ano}, comparação: ${compare}`);

        // Buscar dados
        const overview = await FinancialOverviewService.getOverview({
            month: mes,
            year: ano,
            compare
        });

        res.json({
            success: true,
            data: overview
        });

    } catch (error) {
        console.error('[FinancialOverview] Erro:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao calcular visão geral financeira',
            message: error.message
        });
    }
});

/**
 * @route   GET /api/financial/metrics/leads
 * @desc    Lista detalhada de leads do período
 * @access  Admin/Secretary
 */
router.get('/metrics/leads', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { month, year, page = 1, limit = 20, origin, status, search } = req.query;
        
        if (!month || !year) {
            return res.status(400).json({
                success: false,
                error: 'Parâmetros obrigatórios: month e year'
            });
        }

        const result = await FinancialOverviewService.getLeadsDetalhados({
            month: parseInt(month),
            year: parseInt(year),
            page: parseInt(page),
            limit: parseInt(limit),
            origin,
            status,
            search
        });

        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[FinancialOverview] Erro ao buscar leads:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar leads',
            message: error.message
        });
    }
});

/**
 * @route   GET /api/financial/metrics/avaliacoes-agendadas
 * @desc    Lista detalhada de avaliações agendadas
 * @access  Admin/Secretary
 */
router.get('/metrics/avaliacoes-agendadas', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { month, year, page = 1, limit = 20, status, doctorId, dateFrom, dateTo, search } = req.query;
        
        if (!month || !year) {
            return res.status(400).json({
                success: false,
                error: 'Parâmetros obrigatórios: month e year'
            });
        }

        const result = await FinancialOverviewService.getAvaliacoesAgendadas({
            month: parseInt(month),
            year: parseInt(year),
            page: parseInt(page),
            limit: parseInt(limit),
            status,
            doctorId,
            dateFrom,
            dateTo,
            search
        });

        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[FinancialOverview] Erro ao buscar avaliações:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar avaliações',
            message: error.message
        });
    }
});

/**
 * @route   GET /api/financial/metrics/avaliacoes-realizadas
 * @desc    Lista detalhada de avaliações realizadas
 * @access  Admin/Secretary
 */
router.get('/metrics/avaliacoes-realizadas', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { month, year, page = 1, limit = 20, status, doctorId, dateFrom, dateTo, search } = req.query;
        
        if (!month || !year) {
            return res.status(400).json({
                success: false,
                error: 'Parâmetros obrigatórios: month e year'
            });
        }

        const result = await FinancialOverviewService.getAvaliacoesRealizadas({
            month: parseInt(month),
            year: parseInt(year),
            page: parseInt(page),
            limit: parseInt(limit),
            status,
            doctorId,
            dateFrom,
            dateTo,
            search
        });

        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[FinancialOverview] Erro ao buscar avaliações:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar avaliações',
            message: error.message
        });
    }
});

/**
 * @route   GET /api/financial/metrics/pacotes
 * @desc    Lista detalhada de pacotes fechados
 * @access  Admin/Secretary
 */
router.get('/metrics/pacotes', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { month, year, page = 1, limit = 20 } = req.query;
        
        if (!month || !year) {
            return res.status(400).json({
                success: false,
                error: 'Parâmetros obrigatórios: month e year'
            });
        }

        const result = await FinancialOverviewService.getPacotesFechados({
            month: parseInt(month),
            year: parseInt(year),
            page: parseInt(page),
            limit: parseInt(limit)
        });

        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[FinancialOverview] Erro ao buscar pacotes:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar pacotes',
            message: error.message
        });
    }
});

/**
 * @route   GET /api/financial/metrics/sessoes
 * @desc    Lista detalhada de sessões do mês
 * @access  Admin/Secretary
 */
router.get('/metrics/sessoes', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { month, year, page = 1, limit = 20 } = req.query;
        
        if (!month || !year) {
            return res.status(400).json({
                success: false,
                error: 'Parâmetros obrigatórios: month e year'
            });
        }

        const result = await FinancialOverviewService.getSessoesMes({
            month: parseInt(month),
            year: parseInt(year),
            page: parseInt(page),
            limit: parseInt(limit)
        });

        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[FinancialOverview] Erro ao buscar sessões:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar sessões',
            message: error.message
        });
    }
});

export default router;
