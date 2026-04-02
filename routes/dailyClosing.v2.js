// routes/dailyClosing.v2.js
import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import DailyClosingSnapshot from '../models/DailyClosingSnapshot.js';
import { calculateDailyClosing } from '../services/dailyClosing/index.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';

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

// ======================================================
// GET /v2/daily-closing/details/payments - Detalhes de pagamentos
// ======================================================
router.get('/details/payments', auth, async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date 
            ? moment.tz(date, "America/Sao_Paulo").format("YYYY-MM-DD")
            : moment.tz(new Date(), "America/Sao_Paulo").format("YYYY-MM-DD");
        
        const startOfDay = moment.tz(targetDate, "America/Sao_Paulo").startOf('day').toDate();
        const endOfDay = moment.tz(targetDate, "America/Sao_Paulo").endOf('day').toDate();
        
        const payments = await Payment.find({
            paymentDate: { $gte: startOfDay, $lte: endOfDay },
            status: 'paid'
        }).populate('patient', 'fullName').lean();
        
        res.json({
            success: true,
            data: payments
        });
    } catch (error) {
        console.error('[DailyClosingV2] Erro ao buscar pagamentos:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ======================================================
// GET /v2/daily-closing/details/scheduled - Sessões agendadas
// ======================================================
router.get('/details/scheduled', auth, async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date 
            ? moment.tz(date, "America/Sao_Paulo").format("YYYY-MM-DD")
            : moment.tz(new Date(), "America/Sao_Paulo").format("YYYY-MM-DD");
        
        const appointments = await Appointment.find({
            date: targetDate,
            status: { $in: ['agendado', 'confirmado'] }
        }).populate('patient', 'fullName').populate('doctor', 'fullName specialty').lean();
        
        res.json({
            success: true,
            data: appointments
        });
    } catch (error) {
        console.error('[DailyClosingV2] Erro ao buscar agendamentos:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ======================================================
// GET /v2/daily-closing/details/completed - Sessões realizadas
// ======================================================
router.get('/details/completed', auth, async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date 
            ? moment.tz(date, "America/Sao_Paulo").format("YYYY-MM-DD")
            : moment.tz(new Date(), "America/Sao_Paulo").format("YYYY-MM-DD");
        
        const appointments = await Appointment.find({
            date: targetDate,
            status: 'completed'
        }).populate('patient', 'fullName').populate('doctor', 'fullName specialty').lean();
        
        res.json({
            success: true,
            data: appointments
        });
    } catch (error) {
        console.error('[DailyClosingV2] Erro ao buscar realizadas:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ======================================================
// GET /v2/daily-closing/details/absences - Faltas
// ======================================================
router.get('/details/absences', auth, async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date 
            ? moment.tz(date, "America/Sao_Paulo").format("YYYY-MM-DD")
            : moment.tz(new Date(), "America/Sao_Paulo").format("YYYY-MM-DD");
        
        const appointments = await Appointment.find({
            date: targetDate,
            status: 'faltou'
        }).populate('patient', 'fullName').populate('doctor', 'fullName specialty').lean();
        
        res.json({
            success: true,
            data: appointments
        });
    } catch (error) {
        console.error('[DailyClosingV2] Erro ao buscar faltas:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
