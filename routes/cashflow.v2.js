// routes/cashflow.v2.js
/**
 * Caixa Real V2 - Fluxo de dinheiro baseado em Payment
 */

import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Payment from '../models/Payment.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

/**
 * Classifica um pagamento por tipo baseado em notes/description
 */
function classifyPayment(payment) {
    const desc = (payment.notes || payment.description || '').toLowerCase();
    const method = (payment.paymentMethod || '').toLowerCase();
    
    // Se tem type definido no banco, usa ele
    if (payment.type === 'package' || payment.type === 'pacote') return 'package';
    if (payment.type === 'insurance' || payment.type === 'convenio') return 'insurance';
    if (payment.type === 'appointment' || payment.type === 'particular') return 'appointment';
    
    // Inferência pela descrição
    if (desc.includes('pacote') || desc.includes('package')) return 'package';
    if (desc.includes('convênio') || desc.includes('convenio') || desc.includes('insurance')) return 'insurance';
    if (desc.includes('per-session') || desc.includes('sessão') || desc.includes('atendimento') || desc.includes('particular')) return 'appointment';
    
    // LIMINAR_CREDIT geralmente é de pacote
    if (method.includes('liminar') || method.includes('credit')) return 'package';
    
    // Padrão
    return 'appointment';
}

/**
 * Extrai a especificação do atendimento (avaliação, teste, etc)
 */
function getEspecificacao(payment) {
    const desc = (payment.notes || payment.description || '').toLowerCase();
    const tipo = classifyPayment(payment);
    const serviceType = payment.serviceType;
    
    // Se for pacote, mostra o tipo de pacote
    if (tipo === 'package') {
        if (desc.includes('avaliação') || desc.includes('avaliacao')) return '📦 Pacote - Avaliação';
        if (desc.includes('teste') || desc.includes('linguinha')) return '📦 Pacote - Teste da Linguinha';
        return '📦 Venda de Pacote';
    }
    
    // Se for convênio
    if (tipo === 'insurance') {
        return '🏥 Convênio';
    }
    
    // Particular - usa serviceType se disponível (mais preciso)
    if (serviceType) {
        const serviceMap = {
            'evaluation': '👤 Avaliação',
            'session': '👤 Sessão',
            'package_session': '👤 Sessão de Pacote',
            'tongue_tie_test': '👤 Teste da Linguinha',
            'neuropsych_evaluation': '👤 Avaliação Neuropsicológica',
            'individual_session': '👤 Sessão Individual',
            'meet': '👤 Meet',
            'alignment': '👤 Alinhamento'
        };
        if (serviceMap[serviceType]) {
            return serviceMap[serviceType];
        }
    }
    
    // Fallback - identifica pelo texto da descrição
    if (desc.includes('avaliação') || desc.includes('avaliacao')) return '👤 Avaliação';
    if (desc.includes('teste') && desc.includes('linguinha')) return '👤 Teste da Linguinha';
    if (desc.includes('teste')) return '👤 Teste';
    if (desc.includes('sessão') || desc.includes('sessao')) return '👤 Sessão';
    if (desc.includes('retorno')) return '👤 Retorno';
    if (desc.includes('consulta')) return '👤 Consulta';
    if (desc.includes('per-session')) return '👤 Sessão';
    
    return '👤 Atendimento';
}

/**
 * Busca pagamentos reais do período com classificação
 */
async function getCashFlow(startDate, endDate, clinicId) {
    const start = moment.tz(startDate, TIMEZONE).startOf('day');
    const end = moment.tz(endDate, TIMEZONE).endOf('day');
    
    // CORREÇÃO: Usa Date (igual está no banco MongoDB)
    const rangeStart = new Date(start.format('YYYY-MM-DD') + 'T00:00:00.000Z');
    const rangeEnd = new Date(end.format('YYYY-MM-DD') + 'T23:59:59.999Z');

    const matchStage = {
        status: { $in: ['paid', 'completed', 'confirmed'] },
        paymentDate: { $gte: rangeStart, $lte: rangeEnd }
    };

    if (clinicId && clinicId !== 'default') {
        matchStage.clinicId = clinicId;
    }

    // Busca todos os pagamentos e classifica em JS
    const payments = await Payment.find(matchStage)
        .sort({ createdAt: -1 })
        .lean();

    let totalAmount = 0;
    let pix = 0;
    let cartao = 0;
    let dinheiro = 0;
    let particular = 0;
    let pacote = 0;
    let convenio = 0;

    payments.forEach(p => {
        const amount = p.amount || 0;
        totalAmount += amount;
        
        // Por método
        const method = (p.paymentMethod || '').toLowerCase();
        if (method.includes('pix')) pix += amount;
        else if (method.includes('card') || method.includes('cartao') || method.includes('cartão')) cartao += amount;
        else if (method.includes('cash') || method.includes('dinheiro')) dinheiro += amount;
        
        // Por tipo (classificação inteligente)
        const tipo = classifyPayment(p);
        if (tipo === 'package') pacote += amount;
        else if (tipo === 'insurance') convenio += amount;
        else particular += amount;
    });

    // Agrupa por dia
    const dailyMap = new Map();
    payments.forEach(p => {
        const date = moment(p.paymentDate).format('YYYY-MM-DD');
        if (!dailyMap.has(date)) {
            dailyMap.set(date, { amount: 0, count: 0 });
        }
        dailyMap.get(date).amount += p.amount || 0;
        dailyMap.get(date).count += 1;
    });

    const dailyBreakdown = Array.from(dailyMap.entries())
        .map(([date, data]) => ({ date, ...data }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));

    return {
        period: {
            start: start.format('YYYY-MM-DD'),
            end: end.format('YYYY-MM-DD'),
            days: end.diff(start, 'days') + 1
        },
        summary: {
            totalEntradas: totalAmount,
            totalTransacoes: payments.length,
            
            porMetodo: {
                pix,
                cartao,
                dinheiro,
                outros: totalAmount - pix - cartao - dinheiro
            },
            
            porTipo: {
                particular,
                pacote,
                convenio,
                outros: 0 // Agora classificamos tudo
            }
        },
        daily: dailyBreakdown
    };
}

/**
 * GET /api/v2/cashflow
 */
router.get('/', auth, async (req, res) => {
    try {
        const { date, startDate, endDate } = req.query;
        const clinicId = req.user?.clinicId || 'default';

        // Modo single day
        if (date && !startDate && !endDate) {
            const data = await getCashFlow(date, date, clinicId);
            
            // Busca comparação com ontem
            const yesterday = moment.tz(date, TIMEZONE).subtract(1, 'day').format('YYYY-MM-DD');
            const yesterdayData = await getCashFlow(yesterday, yesterday, clinicId);
            
            const variation = yesterdayData.summary.totalEntradas > 0
                ? ((data.summary.totalEntradas - yesterdayData.summary.totalEntradas) / yesterdayData.summary.totalEntradas) * 100
                : 0;

            return res.json({
                success: true,
                data: {
                    ...data,
                    comparison: {
                        yesterdayTotal: yesterdayData.summary.totalEntradas,
                        variation: Math.round(variation * 100) / 100,
                        trend: variation >= 0 ? 'up' : 'down'
                    }
                },
                meta: { mode: 'single' }
            });
        }

        // Modo período
        const start = startDate || moment.tz(TIMEZONE).format('YYYY-MM-DD');
        const end = endDate || start;
        
        const data = await getCashFlow(start, end, clinicId);
        
        // Comparação com período anterior
        const periodDays = moment.tz(end, TIMEZONE).diff(moment.tz(start, TIMEZONE), 'days') + 1;
        const prevStart = moment.tz(start, TIMEZONE).subtract(periodDays, 'days').format('YYYY-MM-DD');
        const prevEnd = moment.tz(start, TIMEZONE).subtract(1, 'day').format('YYYY-MM-DD');
        
        const prevData = await getCashFlow(prevStart, prevEnd, clinicId);
        const variation = prevData.summary.totalEntradas > 0
            ? ((data.summary.totalEntradas - prevData.summary.totalEntradas) / prevData.summary.totalEntradas) * 100
            : 0;

        res.json({
            success: true,
            data: {
                ...data,
                comparison: {
                    previousPeriodTotal: prevData.summary.totalEntradas,
                    variation: Math.round(variation * 100) / 100,
                    trend: variation >= 0 ? 'up' : 'down'
                }
            },
            meta: { mode: 'period' }
        });

    } catch (error) {
        console.error('[CashFlowV2] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/v2/cashflow/transactions - Lista detalhada
 */
router.get('/transactions', auth, async (req, res) => {
    try {
        const { date, startDate, endDate, method, type, limit = 100 } = req.query;
        const clinicId = req.user?.clinicId || 'default';

        const matchStage = {
            status: { $in: ['paid', 'completed', 'confirmed'] }
        };

        if (clinicId && clinicId !== 'default') {
            matchStage.clinicId = clinicId;
        }

        // Filtro de data (CORRETO: Date no paymentDate)
        if (date) {
            const dayStart = new Date(date + 'T00:00:00.000Z');
            const dayEnd = new Date(date + 'T23:59:59.999Z');
            matchStage.paymentDate = { $gte: dayStart, $lte: dayEnd };
        } else if (startDate && endDate) {
            const rangeStart = new Date(startDate + 'T00:00:00.000Z');
            const rangeEnd = new Date(endDate + 'T23:59:59.999Z');
            matchStage.paymentDate = { $gte: rangeStart, $lte: rangeEnd };
        }

        if (method) {
            matchStage.paymentMethod = { $regex: method, $options: 'i' };
        }

        const transactions = await Payment.find(matchStage)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .populate('patientId', 'fullName')
            .populate('createdBy', 'fullName')
            .lean();
        
        const formatted = transactions.map(t => {
            const paymentDateStr = t.paymentDate 
                ? moment(t.paymentDate).format('YYYY-MM-DD')
                : moment(t.createdAt).format('YYYY-MM-DD');
            return {
                id: t._id.toString(),
                date: paymentDateStr,
                time: moment(t.createdAt).format('HH:mm'),
                amount: t.amount,
                method: t.paymentMethod || 'unknown',
                type: classifyPayment(t),
                especificacao: getEspecificacao(t),
                description: t.description || t.notes || getDefaultDescription(t),
                patient: t.patientId?.fullName || '—',
                createdBy: t.createdBy?.fullName || '—',
                status: t.status,
                specialty: t.sessionType || null,
                serviceType: t.serviceType || null
            };
        });

        // Filtro de tipo (se especificado)
        const filtered = type 
            ? formatted.filter(t => t.type === type)
            : formatted;

        // Calcula summary
        const summary = {
            total: filtered.reduce((sum, t) => sum + t.amount, 0),
            count: filtered.length,
            
            byType: {
                package: {
                    count: filtered.filter(t => t.type === 'package').length,
                    total: filtered.filter(t => t.type === 'package').reduce((sum, t) => sum + t.amount, 0)
                },
                appointment: {
                    count: filtered.filter(t => t.type === 'appointment').length,
                    total: filtered.filter(t => t.type === 'appointment').reduce((sum, t) => sum + t.amount, 0)
                },
                insurance: {
                    count: filtered.filter(t => t.type === 'insurance').length,
                    total: filtered.filter(t => t.type === 'insurance').reduce((sum, t) => sum + t.amount, 0)
                }
            },
            
            byMethod: {
                pix: filtered.filter(t => /pix/i.test(t.method)).reduce((sum, t) => sum + t.amount, 0),
                cartao: filtered.filter(t => /card|cartao|cartão/i.test(t.method)).reduce((sum, t) => sum + t.amount, 0),
                dinheiro: filtered.filter(t => /cash|dinheiro/i.test(t.method)).reduce((sum, t) => sum + t.amount, 0)
            }
        };

        res.json({
            success: true,
            data: {
                transactions: filtered,
                summary,
                count: filtered.length,
                totalAmount: summary.total
            }
        });

    } catch (error) {
        console.error('[CashFlowV2] Erro nas transações:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

function getDefaultDescription(payment) {
    const desc = (payment.notes || payment.description || '').toLowerCase();
    
    if (desc.includes('pacote') || desc.includes('package')) {
        return '📦 Venda de Pacote';
    }
    if (desc.includes('convênio') || desc.includes('convenio') || desc.includes('insurance')) {
        return '🏥 Convênio';
    }
    if (desc.includes('per-session') || desc.includes('sessão')) {
        return '👤 Sessão';
    }
    if (desc.includes('receita reconhecida')) {
        return '💰 Receita Reconhecida';
    }
    return '👤 Atendimento';
}

export default router;
