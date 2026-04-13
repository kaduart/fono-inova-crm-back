// routes/financialDashboard.v2.js
/**
 * 💰 DASHBOARD FINANCEIRO V2 - PROJECTION-BASED
 * 
 * NÃO calcula em tempo real!
 * Lê dados pré-calculados da FinancialProjection.
 * 
 * 🎯 Event-driven: dados atualizados via PAYMENT_COMPLETED
 */

import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import FinancialProjectionHandler from '../projections/financialProjection.js';
import FinancialProjection from '../models/FinancialProjection.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

// GET /v2/financial/dashboard - Dashboard via projection
router.get('/', auth, async (req, res) => {
    try {
        const { month, year, forceRealTime } = req.query;
        const targetMonth = month ? parseInt(month) : moment().month() + 1;
        const targetYear = year ? parseInt(year) : moment().year();
        const monthKey = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
        
        console.log(`[DashboardV2] Mês: ${monthKey}`);
        
        // 🎯 PRIMEIRO: tenta ler da projection (super rápido)
        let data = await FinancialProjectionHandler.getDashboardData(monthKey);
        
        // Se não tem dados na projection OU forceRealTime=true, calcula agora
        const hasProjectionData = data.caixa > 0 || data.despesas > 0;
        
        if (!hasProjectionData || forceRealTime === 'true') {
            console.log(`[DashboardV2] Projection vazia, calculando real-time...`);
            data = await calculateRealTime(targetYear, targetMonth);
        }
        
        // A Receber (sempre calculado - depende de sessões)
        const aReceber = await calculateAReceber(targetYear, targetMonth);
        
        res.json({
            success: true,
            source: hasProjectionData ? 'projection' : 'real-time',
            resumo: {
                caixa: data.caixa,
                caixaDetalhe: data.caixaDetalhe,
                producao: data.producao,
                producaoDetalhe: data.producaoDetalhe,
                aReceber: {
                    total: aReceber.total,
                    mesAtual: aReceber.mesAtual,
                    historico: aReceber.historico
                },
                saldo: data.saldo,
                despesas: data.despesas
            },
            data: {
                period: { month: targetMonth, year: targetYear },
                cash: {
                    total: data.caixa,
                    breakdown: data.caixaDetalhe
                },
                revenue: {
                    total: data.producao,
                    byMethod: {} // Pode ser expandido
                },
                expenses: {
                    total: data.despesas,
                    count: 0
                },
                balance: data.saldo
            },
            metadata: {
                projection: hasProjectionData,
                lastUpdate: data.metadata?.ultimoPagamento
            }
        });
        
    } catch (error) {
        console.error('[DashboardV2] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 🔄 Fallback: Calcula real-time (se projection não existe)
 */
async function calculateRealTime(year, month) {
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').toDate();
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month').toDate();
    
    // Caixa (payments pagos no mês)
    const caixaPayments = await Payment.find({
        status: 'paid',
        $or: [
            { financialDate: { $gte: start, $lte: end } },
            { paymentDate: { $gte: start, $lte: end } }
        ]
    }).lean();
    
    const caixaTotal = caixaPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const caixaParticular = caixaPayments
        .filter(p => p.billingType !== 'convenio')
        .reduce((sum, p) => sum + (p.amount || 0), 0);
    const caixaConvenio = caixaPayments
        .filter(p => p.billingType === 'convenio')
        .reduce((sum, p) => sum + (p.amount || 0), 0);
    
    // Produção (sessões completed no mês)
    const sessoes = await Session.find({
        date: { $gte: start, $lte: end },
        status: 'completed'
    }).populate('package', 'insuranceGrossAmount').lean();
    
    let producaoParticular = 0;
    let producaoConvenio = 0;
    
    sessoes.forEach(s => {
        const valor = s.sessionValue || s.package?.insuranceGrossAmount || 0;
        if (s.paymentMethod === 'convenio' || s.billingType === 'convenio') {
            producaoConvenio += valor;
        } else {
            producaoParticular += valor;
        }
    });
    
    return {
        caixa: caixaTotal,
        caixaDetalhe: { particular: caixaParticular, convenio: caixaConvenio },
        producao: producaoParticular + producaoConvenio,
        producaoDetalhe: { particular: producaoParticular, convenio: producaoConvenio },
        despesas: 0, // Implementar se necessário
        saldo: caixaTotal
    };
}

/**
 * 📋 A Receber (sempre calculado)
 */
async function calculateAReceber(year, month) {
    const startOfMonth = moment.tz([year, month - 1], TIMEZONE).startOf('month');
    const endOfMonth = moment.tz([year, month - 1], TIMEZONE).endOf('month');
    const now = moment();
    
    const sessoes = await Session.find({
        status: 'completed',
        $or: [
            { paymentMethod: 'convenio' },
            { billingType: 'convenio' },
            { insuranceGuide: { $exists: true, $ne: null } }
        ],
        $or: [
            { isPaid: false },
            { isPaid: { $exists: false } },
            { paymentStatus: { $in: ['pending', 'pending_receipt'] } }
        ]
    }).populate('package', 'insuranceGrossAmount').lean();
    
    const total = sessoes.reduce((sum, s) => {
        return sum + (s.package?.insuranceGrossAmount || s.sessionValue || 0);
    }, 0);
    
    const mesAtual = sessoes
        .filter(s => {
            const data = moment(s.date);
            return data.isBetween(startOfMonth, endOfMonth, null, '[]');
        })
        .reduce((sum, s) => sum + (s.package?.insuranceGrossAmount || s.sessionValue || 0), 0);
    
    return {
        total,
        mesAtual,
        historico: total - mesAtual
    };
}

export default router;
