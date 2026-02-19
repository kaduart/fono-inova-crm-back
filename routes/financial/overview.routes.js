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

export default router;
