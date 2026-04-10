// routes/dailyClosing.v2.js - DEPRECATED: Use /api/v2/cashflow
import express from 'express';
import { auth } from '../middleware/auth.js';

const router = express.Router();

router.get('/', auth, async (req, res) => {
    res.json({
        success: false,
        error: 'Endpoint deprecated. Use /api/v2/cashflow',
        newEndpoint: '/api/v2/cashflow?date=YYYY-MM-DD'
    });
});

export default router;
