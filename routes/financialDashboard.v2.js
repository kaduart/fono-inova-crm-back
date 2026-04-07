// routes/financialDashboard.v2.js
import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Payment from '../models/Payment.js';
import Expense from '../models/Expense.js';
import Session from '../models/Session.js';

const router = express.Router();

// GET /v2/financial/dashboard - Dashboard completo
router.get('/', auth, async (req, res) => {
    try {
        const { month, year } = req.query;
        const targetMonth = month ? parseInt(month) : moment().month() + 1;
        const targetYear = year ? parseInt(year) : moment().year();
        
        // Período do mês
        const startOfMonth = moment.tz([targetYear, targetMonth - 1], "America/Sao_Paulo").startOf('month').toDate();
        const endOfMonth = moment.tz([targetYear, targetMonth - 1], "America/Sao_Paulo").endOf('month').toDate();
        
        // ========================================
        // 💰 CAIXA = Dinheiro que ENTROU no período
        // ========================================
        const caixaPayments = await Payment.find({
            paymentDate: { $gte: startOfMonth, $lte: endOfMonth },
            status: 'paid'
        }).lean();
        
        // Caixa total
        const caixaTotal = caixaPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
        
        // Caixa por tipo
        const caixaParticular = caixaPayments
            .filter(p => p.billingType !== 'convenio')
            .reduce((sum, p) => sum + (p.amount || 0), 0);
        
        const caixaConvenio = caixaPayments
            .filter(p => p.billingType === 'convenio')
            .reduce((sum, p) => sum + (p.amount || 0), 0);
        
        // ========================================
        // 📊 PRODUÇÃO = Tudo que foi REALIZADO no período
        // ========================================
        
        // Produção Particular (payments de particular realizados no mês)
        const particularPayments = await Payment.find({
            paymentDate: { $gte: startOfMonth, $lte: endOfMonth },
            billingType: { $ne: 'convenio' },
            status: { $in: ['paid', 'pending'] }
        }).lean();
        
        const producaoParticular = particularPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
        
        // Produção Convênio (sessões completed no mês)
        const convenioSessions = await Session.find({
            date: { $gte: startOfMonth, $lte: endOfMonth },
            status: 'completed',
            $or: [
                { paymentMethod: 'convenio' },
                { insuranceGuide: { $exists: true, $ne: null } }
            ]
        }).populate('package', 'insuranceGrossAmount').lean();
        
        const producaoConvenio = convenioSessions.reduce((sum, s) => {
            const valor = s.package?.insuranceGrossAmount || s.sessionValue || 0;
            return sum + valor;
        }, 0);
        
        // Produção total
        const producaoTotal = producaoParticular + producaoConvenio;
        
        // ========================================
        // 📋 A RECEBER = Convênios realizados mas não pagos
        // ========================================
        const aReceberSessions = await Session.find({
            date: { $lte: endOfMonth }, // Até o fim do mês pesquisado
            status: 'completed',
            $or: [
                { paymentMethod: 'convenio' },
                { insuranceGuide: { $exists: true, $ne: null } }
            ],
            $or: [
                { isPaid: false },
                { isPaid: { $exists: false } },
                { paymentStatus: { $in: ['pending', 'pending_receipt'] } }
            ]
        }).populate('package', 'insuranceGrossAmount').lean();
        
        const aReceberTotal = aReceberSessions.reduce((sum, s) => {
            const valor = s.package?.insuranceGrossAmount || s.sessionValue || 0;
            return sum + valor;
        }, 0);
        
        // Separar por período
        const aReceberMesAtual = aReceberSessions
            .filter(s => s.date >= startOfMonth && s.date <= endOfMonth)
            .reduce((sum, s) => sum + (s.package?.insuranceGrossAmount || s.sessionValue || 0), 0);
        
        const aReceberHistorico = aReceberSessions
            .filter(s => s.date < startOfMonth)
            .reduce((sum, s) => sum + (s.package?.insuranceGrossAmount || s.sessionValue || 0), 0);
        
        // ========================================
        // 💸 DESPESAS
        // ========================================
        const expenses = await Expense.find({
            date: { $gte: startOfMonth, $lte: endOfMonth }
        }).lean();
        
        const totalExpenses = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
        
        // ========================================
        // RESPOSTA
        // ========================================
        res.json({
            success: true,
            resumo: {
                // 💰 CAIXA (dinheiro que entrou)
                caixa: caixaTotal,
                caixaDetalhe: {
                    particular: caixaParticular,
                    convenio: caixaConvenio
                },
                
                // 📊 PRODUÇÃO (trabalho realizado)
                producao: producaoTotal,
                producaoDetalhe: {
                    particular: producaoParticular,
                    convenio: producaoConvenio
                },
                
                // 📋 A RECEBER
                aReceber: {
                    total: aReceberTotal,
                    mesAtual: aReceberMesAtual,
                    historico: aReceberHistorico
                },
                
                // 💸 SALDO
                saldo: caixaTotal - totalExpenses,
                despesas: totalExpenses
            },
            
            // Compatibilidade com estrutura antiga
            data: {
                period: { month: targetMonth, year: targetYear },
                cash: {
                    total: caixaTotal,
                    breakdown: {
                        particular: caixaParticular,
                        convenio: caixaConvenio
                    }
                },
                revenue: {
                    total: producaoTotal,
                    byMethod: caixaPayments.reduce((acc, p) => {
                        if (p.paymentMethod) {
                            acc[p.paymentMethod] = (acc[p.paymentMethod] || 0) + (p.amount || 0);
                        }
                        return acc;
                    }, {})
                },
                expenses: {
                    total: totalExpenses,
                    count: expenses.length
                },
                balance: caixaTotal - totalExpenses
            }
        });
    } catch (error) {
        console.error('[FinancialDashboardV2] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
