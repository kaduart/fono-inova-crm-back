import express from 'express';
import { auth } from '../middleware/auth.js';

const router = express.Router();

// GET /v2/calendar/holidays - Retorna feriados (mock por enquanto)
router.get('/holidays', auth, async (req, res) => {
    const { year } = req.query;
    
    // Feriados brasileiros básicos
    const holidays = [
        { date: `${year}-01-01`, name: 'Confraternização Universal', type: 'national' },
        { date: `${year}-04-21`, name: 'Tiradentes', type: 'national' },
        { date: `${year}-05-01`, name: 'Dia do Trabalho', type: 'national' },
        { date: `${year}-09-07`, name: 'Independência do Brasil', type: 'national' },
        { date: `${year}-10-12`, name: 'Nossa Senhora Aparecida', type: 'national' },
        { date: `${year}-11-02`, name: 'Finados', type: 'national' },
        { date: `${year}-11-15`, name: 'Proclamação da República', type: 'national' },
        { date: `${year}-12-25`, name: 'Natal', type: 'national' },
    ];
    
    res.json({ success: true, data: holidays });
});

export default router;
