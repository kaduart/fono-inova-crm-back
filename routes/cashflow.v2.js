// routes/cashflow.v2.js - CAIXA REAL SIMPLIFICADO
import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Payment from '../models/Payment.js';

const router = express.Router();

// GET /api/v2/cashflow?date=2026-04-10
router.get('/', auth, async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date || moment.tz('America/Sao_Paulo').format('YYYY-MM-DD');
        
        // Range do dia
        const start = moment.tz(targetDate, 'America/Sao_Paulo').startOf('day').toDate();
        const end = moment.tz(targetDate, 'America/Sao_Paulo').endOf('day').toDate();
        
        // 🎯 Busca PAGAMENTOS DO DIA
        const payments = await Payment.find({
            status: { $in: ['paid', 'completed', 'confirmed'] },
            $or: [
                { createdAt: { $gte: start, $lte: end } },
                { paymentDate: { $gte: start, $lte: end } }
            ]
        }).populate('patient', 'fullName').lean();
        
        // 🎯 Busca ONTEM para comparação
        const yesterdayStart = moment.tz(targetDate, 'America/Sao_Paulo').subtract(1, 'day').startOf('day').toDate();
        const yesterdayEnd = moment.tz(targetDate, 'America/Sao_Paulo').subtract(1, 'day').endOf('day').toDate();
        
        const yesterdayPayments = await Payment.find({
            status: { $in: ['paid', 'completed', 'confirmed'] },
            $or: [
                { createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd } },
                { paymentDate: { $gte: yesterdayStart, $lte: yesterdayEnd } }
            ]
        }).lean();
        
        const yesterdayTotal = yesterdayPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
        
        // Calcula totais do dia
        let total = 0;
        let pix = 0, dinheiro = 0, cartao = 0, outros = 0;
        let particular = 0, pacote = 0, convenio = 0;
        let qtdPix = 0, qtdDinheiro = 0, qtdCartao = 0;
        
        const transacoes = payments.map(p => {
            total += p.amount;
            
            // Por método
            const method = (p.paymentMethod || '').toLowerCase();
            if (method.includes('pix')) { pix += p.amount; qtdPix++; }
            else if (method.includes('card') || method.includes('cartao') || method.includes('crédito') || method.includes('debito')) { cartao += p.amount; qtdCartao++; }
            else if (method.includes('cash') || method.includes('dinheiro')) { dinheiro += p.amount; qtdDinheiro++; }
            else { outros += p.amount; }
            
            // Por tipo
            const notes = (p.notes || '').toLowerCase();
            const desc = (p.description || '').toLowerCase();
            if (notes.includes('pacote') || desc.includes('pacote') || p.type === 'package') pacote += p.amount;
            else if (notes.includes('convênio') || desc.includes('convenio') || p.type === 'insurance') convenio += p.amount;
            else particular += p.amount;
            
            // Determina método de pagamento padronizado
            let metodo = 'Outros';
            if (method.includes('pix')) metodo = 'Pix';
            else if (method.includes('dinheiro') || method.includes('cash')) metodo = 'Dinheiro';
            else if (method.includes('cartão') || method.includes('cartao') || method.includes('card') || method.includes('crédito') || method.includes('debito')) metodo = 'Cartão';
            
            // Determina tipo de serviço
            let tipo = 'Particular';
            let servico = 'Sessão';
            
            if (notes.includes('pacote') || desc.includes('pacote') || p.serviceType === 'package_session') {
                tipo = 'Pacote';
                servico = notes.includes('avaliação') ? 'Avaliação (Pacote)' : 
                         notes.includes('teste') ? 'Teste (Pacote)' : 'Sessão de Pacote';
            } else if (notes.includes('convênio') || desc.includes('convenio') || p.type === 'insurance' || p.billingType === 'convenio') {
                tipo = 'Convênio';
                servico = 'Sessão Convênio';
            } else if (p.serviceType) {
                const serviceMap = {
                    'evaluation': 'Avaliação',
                    'session': 'Sessão',
                    'individual_session': 'Sessão Individual',
                    'tongue_tie_test': 'Teste da Linguinha',
                    'neuropsych_evaluation': 'Avaliação Neuropsicológica',
                    'return': 'Retorno',
                    'meet': 'Meet',
                    'alignment': 'Alinhamento'
                };
                servico = serviceMap[p.serviceType] || 'Sessão';
            }
            
            return {
                id: p._id,
                paciente: p.patient?.fullName || p.patientName || 'Paciente não identificado',
                valor: p.amount,
                metodo: metodo,
                tipo: tipo,
                servico: servico,
                especialidade: p.specialty || p.sessionType || '-',
                hora: moment(p.createdAt).format('HH:mm'),
                data: moment(p.createdAt).format('DD/MM/YYYY')
            };
        });
        
        // Calcula variação vs ontem
        const variacao = yesterdayTotal > 0 
            ? ((total - yesterdayTotal) / yesterdayTotal * 100).toFixed(1)
            : total > 0 ? 100 : 0;
        
        // Ticket médio
        const ticketMedio = payments.length > 0 ? (total / payments.length) : 0;
        
        res.json({
            success: true,
            data: {
                data: targetDate,
                caixa: { 
                    total, 
                    pix, 
                    dinheiro, 
                    cartao,
                    outros,
                    qtdPix,
                    qtdDinheiro,
                    qtdCartao
                },
                porTipo: {
                    particular,
                    pacote,
                    convenio
                },
                estatisticas: {
                    quantidade: payments.length,
                    ticketMedio,
                    variacaoVsOntem: parseFloat(variacao),
                    ontem: yesterdayTotal
                },
                transacoes
            }
        });
        
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
