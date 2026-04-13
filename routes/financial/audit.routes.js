// routes/financial/audit.routes.js
import express from 'express';
import { auth, authorize } from '../../middleware/auth.js';
import PaymentService from '../../services/paymentService.js';

const router = express.Router();

/**
 * GET /api/financial/audit/payments
 * Audita payments recentes e auto-corrige se necessário
 */
router.get('/payments', auth, authorize(['admin']), async (req, res) => {
    try {
        const { hours = 24 } = req.query;
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);
        
        const resultado = await PaymentService.auditMass(since);
        
        res.json({
            success: true,
            periodo: `${hours}h`,
            ...resultado
        });
    } catch (error) {
        console.error('[Audit] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
