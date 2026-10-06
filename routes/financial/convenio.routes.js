// routes/financial/convenio.routes.js
// Rotas para métricas de convênio - SEPARA receita realizada de caixa

import express from 'express';
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import { auth, authorize } from '../../middleware/auth.js';
import ConvenioMetricsService from '../../services/financial/ConvenioMetricsService.js';
import { sendApiError } from '../../errors/buildErrorResponse.js';
import { AppError } from '../../errors/AppError.js';

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
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Parâmetros obrigatórios: month e year', {
                status: 400,
              }),
              req
            );
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
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao calcular métricas de convênio',
          }),
          req
        );
    }
});

/**
 * @route   GET /api/financial/convenio/faturamentos
 * @desc    Lista faturamentos de convênio no período (baseado em insurance.billedAt)
 * @query   month (number), year (number)
 * @access  Admin/Secretary
 * 
 * 💡 IMPORTANTE: Este endpoint retorna o valor das GUIAS ENVIADAS no período,
 * não o valor recebido (caixa). O faturamento pode acontecer em mês diferente 
 * do atendimento.
 */
router.get('/faturamentos', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { month, year } = req.query;

        if (!month || !year) {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Parâmetros obrigatórios: month e year', {
                status: 400,
              }),
              req
            );
        }

        console.log(`[ConvenioRoutes] Buscando faturamentos para ${month}/${year}`);

        const faturamentos = await ConvenioMetricsService.getFaturamentosPorPeriodo(
            parseInt(month),
            parseInt(year)
        );

        res.json({
            success: true,
            data: faturamentos
        });

    } catch (error) {
        console.error('[ConvenioRoutes] Erro ao buscar faturamentos:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao buscar faturamentos',
          }),
          req
        );
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
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao buscar resumo de convênios',
          }),
          req
        );
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
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Array paymentIds é obrigatório', {
                status: 400,
              }),
              req
            );
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
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao faturar atendimentos',
          }),
          req
        );
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
            return sendApiError(res, new AppError('BAD_REQUEST', 'patientId é obrigatório', { status: 400 }), req);
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
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao faturar atendimentos do paciente',
          }),
          req
        );
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
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'paymentId e dataRecebimento são obrigatórios', {
                status: 400,
              }),
              req
            );
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
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao registrar recebimento',
          }),
          req
        );
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
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'paymentIds (array) e dataRecebimento são obrigatórios', {
                status: 400,
              }),
              req
            );
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
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao registrar recebimentos',
          }),
          req
        );
    }
});

/**
 * @route   PUT /api/financial/convenio/commission-rules/:doctorId
 * @desc    Configurar regras de comissão por convênio para um profissional
 * @body    { byInsurance: { unimed: 50, amil: 55, ... } }
 * @access  Admin
 */
router.put('/commission-rules/:doctorId', auth, authorize(['admin']), async (req, res) => {
    try {
        const { doctorId } = req.params;
        const { byInsurance } = req.body;

        if (!byInsurance || typeof byInsurance !== 'object') {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'byInsurance deve ser um objeto com { convenio: valor }', {
                status: 400,
              }),
              req
            );
        }

        const Doctor = (await import('../../models/Doctor.js')).default;
        const doctor = await Doctor.findById(doctorId);

        if (!doctor) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Profissional não encontrado', { status: 404 }), req);
        }

        // 🆕 Converte byInsurance em regras do motor novo
        const existingRules = doctor.commissionRules?.rules || [];
        const otherRules = existingRules.filter(r => !(r.billingType === 'convenio' && r.serviceType === 'session'));
        const newRules = Object.entries(byInsurance).map(([insurance, value]) => ({
            _id: new mongoose.Types.ObjectId(),
            serviceType: 'session',
            billingType: 'convenio',
            insurance,
            commissionType: 'fixed',
            value,
            active: true,
            priority: 0,
            notes: 'Migrado de byInsurance via endpoint legado'
        }));

        doctor.commissionRules = doctor.commissionRules || {};
        doctor.commissionRules.rules = [...otherRules, ...newRules];
        doctor.commissionRuleVersion = (doctor.commissionRuleVersion || 1) + 1;
        await doctor.save();

        res.json({
            success: true,
            message: 'Regras de comissão atualizadas',
            data: {
                doctorId: doctor._id,
                doctorName: doctor.fullName,
                commissionRules: {
                    rules: doctor.commissionRules.rules
                }
            }
        });

    } catch (error) {
        console.error('[ConvenioRoutes] Erro ao atualizar regras:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao atualizar regras de comissão',
          }),
          req
        );
    }
});

/**
 * @route   GET /api/financial/convenio/commission-rules/:doctorId
 * @desc    Buscar regras de comissão de um profissional
 * @access  Admin
 */
router.get('/commission-rules/:doctorId', auth, authorize(['admin']), async (req, res) => {
    try {
        const { doctorId } = req.params;

        const Doctor = (await import('../../models/Doctor.js')).default;
        
        const doctor = await Doctor.findById(doctorId)
            .select('fullName commissionRules');

        if (!doctor) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Profissional não encontrado', { status: 404 }), req);
        }

        const convenioRules = (doctor.commissionRules?.rules || [])
            .filter(r => r.billingType === 'convenio' && r.serviceType === 'session')
            .reduce((acc, r) => {
                acc[r.insurance || 'convenio'] = r.value;
                return acc;
            }, {});

        res.json({
            success: true,
            data: {
                doctorId: doctor._id,
                doctorName: doctor.fullName,
                standardSession: 0,
                byInsurance: convenioRules
            }
        });

    } catch (error) {
        console.error('[ConvenioRoutes] Erro ao buscar regras:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao buscar regras de comissão',
          }),
          req
        );
    }
});

export default router;
