// routes/financial/convenio.routes.js
// Rotas para métricas de convênio - SEPARA receita realizada de caixa

import express from 'express';
import { auth, authorize } from '../../middleware/auth.js';
import ConvenioMetricsService from '../../services/financial/ConvenioMetricsService.js';

const router = express.Router();

/**
 * @route   GET /api/financial/convenio/metrics
 * @desc    Métricas completas de convênio para um período
 * @query   month (number), year (number)
 * @access  Admin/Secretary
 * 
 * 💡 IMPORTANTE: Estas métricas SEPARAM:
 *    - Receita Realizada (produção) 
 *    - A Receber (pipeline de entrada)
 *    - Caixa (só quando o convênio pagar - via endpoint de cashflow)
 */
router.get('/metrics', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { month, year } = req.query;

        if (!month || !year) {
            return res.status(400).json({
                success: false,
                error: 'Parâmetros obrigatórios: month e year'
            });
        }

        console.log(`[ConvenioRoutes] Buscando métricas para ${month}/${year}`);

        const metrics = await ConvenioMetricsService.getConvenioMetrics({
            month: parseInt(month),
            year: parseInt(year)
        });

        res.json({
            success: true,
            data: metrics
        });

    } catch (error) {
        console.error('[ConvenioRoutes] Erro:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao calcular métricas de convênio',
            message: error.message
        });
    }
});

/**
 * @route   GET /api/financial/convenio/dashboard-summary
 * @desc    Resumo rápido para o dashboard principal (cards)
 * @access  Admin/Secretary
 */
router.get('/dashboard-summary', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const summary = await ConvenioMetricsService.getDashboardSummary();

        res.json({
            success: true,
            data: summary
        });

    } catch (error) {
        console.error('[ConvenioRoutes] Erro:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar resumo de convênios',
            message: error.message
        });
    }
});

/**
 * @route   GET /api/financial/convenio/fluxo-caixa
 * @desc    Fluxo de caixa específico de convênios (ENTRADAS e SAÍDAS)
 * @query   month (number), year (number)
 * @access  Admin/Secretary
 * 
 * 💡 NOTA: Este endpoint mostra o CAIXA REAL de convênios:
 *    - Entradas: Convênios que pagaram (received)
 *    - Saídas: Glosas, estornos, etc
 *    - Saldo: Entradas - Saídas
 */
router.get('/fluxo-caixa', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { month, year } = req.query;

        if (!month || !year) {
            return res.status(400).json({
                success: false,
                error: 'Parâmetros obrigatórios: month e year'
            });
        }

        // TODO: Implementar quando tivermos os dados de recebimento
        // Por enquanto, retorna estrutura
        res.json({
            success: true,
            data: {
                message: 'Funcionalidade em desenvolvimento',
                nota: 'Este endpoint mostrará o caixa REAL de convênios (quando o convênio pagar)',
                estrutura: {
                    entradas: 'Convênios recebidos no período',
                    saidas: 'Glosas e estornos',
                    saldo: 'Entradas - Saídas'
                }
            }
        });

    } catch (error) {
        console.error('[ConvenioRoutes] Erro:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao calcular fluxo de caixa de convênios',
            message: error.message
        });
    }
});

/**
 * @route   GET /api/financial/convenio/pacientes
 * @desc    Lista pacientes com convênio e seus totais
 * @query   month (number), year (number)
 * @access  Admin/Secretary
 */
router.get('/pacientes', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { month, year } = req.query;

        // TODO: Implementar agregação por paciente
        res.json({
            success: true,
            data: {
                message: 'Funcionalidade em desenvolvimento',
                descricao: 'Lista de pacientes com totais de sessões realizadas, a receber, etc'
            }
        });

    } catch (error) {
        console.error('[ConvenioRoutes] Erro:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar pacientes de convênio',
            message: error.message
        });
    }
});

export default router;
