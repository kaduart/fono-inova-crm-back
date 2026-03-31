// routes/dailyClosing.v2.js
import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import DailyClosingSnapshot from '../models/DailyClosingSnapshot.js';
import { calculateDailyClosing } from '../services/dailyClosing/index.js';

const router = express.Router();

// GET - Lê snapshot (ou calcula se não existe)
router.get('/', auth, async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date 
            ? moment.tz(date, "America/Sao_Paulo").format("YYYY-MM-DD")
            : moment.tz(new Date(), "America/Sao_Paulo").format("YYYY-MM-DD");

        // Busca snapshot
        const snapshot = await DailyClosingSnapshot.findOne({
            date: targetDate,
            clinicId: req.user?.clinicId || 'default'
        }).lean();

        if (snapshot) {
            return res.json({
                success: true,
                data: snapshot.report,
                meta: { source: 'snapshot', calculatedAt: snapshot.calculatedAt }
            });
        }

        // Fallback: calcula síncrono
        console.log(`[DailyClosingV2] Calculando síncrono: ${targetDate}`);
        const report = await calculateDailyClosing(targetDate, req.user?.clinicId);
        
        // Salva para próximas requisições
        await DailyClosingSnapshot.create({
            date: targetDate,
            clinicId: req.user?.clinicId || 'default',
            report,
            calculatedAt: new Date()
        });

        res.json({
            success: true,
            data: report,
            meta: { source: 'sync_fallback' }
        });

    } catch (error) {
        console.error('[DailyClosingV2] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST - Calcula e salva snapshot síncrono
router.post('/run', auth, async (req, res) => {
    try {
        const { date } = req.body;
        const targetDate = date
            ? moment.tz(date, "America/Sao_Paulo").format("YYYY-MM-DD")
            : moment.tz(new Date(), "America/Sao_Paulo").format("YYYY-MM-DD");

        const report = await calculateDailyClosing(targetDate, req.user?.clinicId);

        await DailyClosingSnapshot.findOneAndUpdate(
            { date: targetDate, clinicId: req.user?.clinicId || 'default' },
            { date: targetDate, clinicId: req.user?.clinicId || 'default', report, calculatedAt: new Date() },
            { upsert: true }
        );

        res.status(202).json({
            success: true,
            message: 'Fechamento calculado',
            data: { date: targetDate, status: 'processed' }
        });

    } catch (error) {
        console.error('[DailyClosingV2] Erro:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
