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
        
        // 🎯 CORREÇÃO: Usa moment com timezone para criar range correto
        const start = moment.tz(targetDate, 'America/Sao_Paulo').startOf('day').toDate();
        const end = moment.tz(targetDate, 'America/Sao_Paulo').endOf('day').toDate();
        
        console.log(`[CashFlow] Buscando: ${targetDate}`);
        console.log(`[CashFlow] Range: ${start.toISOString()} - ${end.toISOString()}`);
        
        // Busca pagamentos do dia (por createdAt - mais confiável)
        const payments = await Payment.find({
            status: { $in: ['paid', 'completed', 'confirmed'] },
            $or: [
                { createdAt: { $gte: start, $lte: end } },
                { paymentDate: { $gte: start, $lte: end } }
            ]
        }).populate('patient', 'fullName').lean();
        
        console.log(`[CashFlow] Encontrados: ${payments.length} pagamentos`);
        
        // Calcula totais
        let total = 0;
        let pix = 0, dinheiro = 0, cartao = 0;
        
        const transacoes = payments.map(p => {
            total += p.amount;
            
            const method = (p.paymentMethod || '').toLowerCase();
            if (method.includes('pix')) pix += p.amount;
            else if (method.includes('card') || method.includes('cartao')) cartao += p.amount;
            else dinheiro += p.amount;
            
            return {
                id: p._id,
                paciente: p.patient?.fullName || '—',
                valor: p.amount,
                metodo: p.paymentMethod,
                tipo: p.notes?.includes('pacote') ? 'pacote' : 'sessao',
                hora: moment(p.createdAt).format('HH:mm')
            };
        });
        
        console.log(`[CashFlow] Total: R$${total}, Pix: R$${pix}, Dinheiro: R$${dinheiro}, Cartão: R$${cartao}`);
        
        res.json({
            success: true,
            data: {
                data: targetDate,
                caixa: { total, pix, dinheiro, cartao },
                transacoes
            }
        });
        
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
