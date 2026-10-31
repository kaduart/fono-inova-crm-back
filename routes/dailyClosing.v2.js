// routes/dailyClosing.v2.js - DEPRECATED: Use /api/v2/cashflow
import express from 'express';
import { auth, authorize } from '../middleware/auth.js';

// Só a gestão (admin/secretária): terapeuta não lê caixa nem dados da clínica.
// Auditoria do Dashboard admin, 31/10/2026 (B2).
const staff = [auth, authorize(['admin', 'secretary'])];

const router = express.Router();

router.get('/', ...staff, async (req, res) => {
    res.json({
        success: false,
        error: 'Endpoint deprecated. Use /api/v2/cashflow',
        newEndpoint: '/api/v2/cashflow?date=YYYY-MM-DD'
    });
});

export default router;
