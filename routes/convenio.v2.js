import express from 'express';
import { auth } from '../middleware/auth.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import InsuranceBatch from '../models/InsuranceBatch.js';

const router = express.Router();

// GET /v2/convenio/metrics - Métricas de convênios
router.get('/metrics', auth, async (req, res) => {
    try {
        const { month, year } = req.query;
        
        // Busca guias do período
        const guides = await InsuranceGuide.find({
            ...(month && year && {
                createdAt: {
                    $gte: new Date(year, month - 1, 1),
                    $lt: new Date(year, month, 1)
                }
            })
        }).lean();
        
        const metrics = {
            total: guides.length,
            faturado: guides.filter(g => g.status === 'faturado').length,
            aReceber: guides.filter(g => g.status === 'a_receber').length,
            recebido: guides.filter(g => g.status === 'recebido').length,
            valorTotal: guides.reduce((sum, g) => sum + (g.valor || 0), 0)
        };
        
        res.json({ success: true, data: metrics });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /v2/convenio/faturamentos - Lista de faturamentos
router.get('/faturamentos', auth, async (req, res) => {
    try {
        const { month, year } = req.query;
        
        const batches = await InsuranceBatch.find({
            type: 'faturamento',
            ...(month && year && {
                createdAt: {
                    $gte: new Date(year, month - 1, 1),
                    $lt: new Date(year, month, 1)
                }
            })
        }).populate('guides').lean();
        
        res.json({ success: true, data: batches });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /v2/convenio/receivable-detail - Detalhe de recebíveis
router.get('/receivable-detail', auth, async (req, res) => {
    try {
        const receivables = await InsuranceGuide.find({
            status: { $in: ['a_receber', 'faturado'] }
        }).populate('patient', 'fullName').lean();
        
        res.json({ 
            success: true, 
            data: receivables,
            total: receivables.reduce((sum, r) => sum + (r.valor || 0), 0)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
