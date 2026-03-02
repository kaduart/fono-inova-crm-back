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

/**
 * @route   POST /api/financial/convenio/faturar-lote
 * @desc    Faturar múltiplos atendimentos de convênio em lote
 * @body    { paymentIds: string[], notaFiscal?: string, dataFaturamento?: string }
 * @access  Admin/Secretary
 * 
 * 💡 Fatura vários atendimentos de uma vez (checkbox no frontend)
 */
router.post('/faturar-lote', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { paymentIds, notaFiscal, dataFaturamento } = req.body;

        if (!paymentIds || !Array.isArray(paymentIds) || paymentIds.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Array paymentIds é obrigatório'
            });
        }

        const result = await ConvenioMetricsService.faturarEmLote({
            paymentIds,
            notaFiscal,
            dataFaturamento: dataFaturamento || new Date().toISOString().split('T')[0]
        });

        res.json({
            success: true,
            message: `${result.faturados} atendimentos faturados com sucesso`,
            data: result
        });

    } catch (error) {
        console.error('[ConvenioRoutes] Erro ao faturar em lote:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao faturar atendimentos',
            message: error.message
        });
    }
});

/**
 * @route   POST /api/financial/convenio/faturar-todos-paciente
 * @desc    Faturar TODOS os atendimentos pendentes de um paciente específico
 * @body    { patientId: string, notaFiscal?: string }
 * @access  Admin/Secretary
 */
router.post('/faturar-todos-paciente', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { patientId, notaFiscal } = req.body;

        if (!patientId) {
            return res.status(400).json({
                success: false,
                error: 'patientId é obrigatório'
            });
        }

        const result = await ConvenioMetricsService.faturarTodosDoPaciente({
            patientId,
            notaFiscal,
            dataFaturamento: new Date().toISOString().split('T')[0]
        });

        res.json({
            success: true,
            message: `${result.faturados} atendimentos do paciente faturados`,
            data: result
        });

    } catch (error) {
        console.error('[ConvenioRoutes] Erro ao faturar paciente:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao faturar atendimentos do paciente',
            message: error.message
        });
    }
});

/**
 * @route   POST /api/financial/convenio/receber
 * @desc    Receber pagamento de convênio (registra no caixa do dia do recebimento)
 * @body    { paymentId: string, dataRecebimento: string, valorRecebido: number, notaFiscal?: string }
 * @access  Admin/Secretary
 */
router.post('/receber', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { paymentId, dataRecebimento, valorRecebido, notaFiscal } = req.body;

        if (!paymentId || !dataRecebimento) {
            return res.status(400).json({
                success: false,
                error: 'paymentId e dataRecebimento são obrigatórios'
            });
        }

        const result = await ConvenioMetricsService.receberPagamentoConvenio({
            paymentId,
            dataRecebimento,
            valorRecebido,
            notaFiscal
        });

        res.json({
            success: true,
            message: 'Recebimento registrado com sucesso',
            data: result
        });

    } catch (error) {
        console.error('[ConvenioRoutes] Erro ao receber pagamento:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao registrar recebimento',
            message: error.message
        });
    }
});

/**
 * @route   POST /api/financial/convenio/receber-lote
 * @desc    Receber múltiplos pagamentos de convênio em lote
 * @body    { paymentIds: string[], dataRecebimento: string }
 * @access  Admin/Secretary
 */
router.post('/receber-lote', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { paymentIds, dataRecebimento } = req.body;

        if (!paymentIds || !Array.isArray(paymentIds) || paymentIds.length === 0 || !dataRecebimento) {
            return res.status(400).json({
                success: false,
                error: 'paymentIds (array) e dataRecebimento são obrigatórios'
            });
        }

        const result = await ConvenioMetricsService.receberEmLote({
            paymentIds,
            dataRecebimento
        });

        res.json({
            success: true,
            message: `${result.recebidos} pagamentos recebidos com sucesso`,
            data: result
        });

    } catch (error) {
        console.error('[ConvenioRoutes] Erro ao receber em lote:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao registrar recebimentos',
            message: error.message
        });
    }
});

export default router;
