// backend/routes/analytics/financial.routes.js
import express from 'express';
import analytics from '../../services/financial/financialAnalytics.service.js';
import { auth } from '../../middleware/auth.js';

const router = express.Router();

// Todas as rotas de analytics exigem autenticação
router.use(auth);

/**
 * GET /api/analytics/specialties
 * Query: from (YYYY-MM-DD), to (YYYY-MM-DD), doctorId (opcional)
 */
router.get('/specialties', async (req, res) => {
    try {
        const { from, to, doctorId } = req.query;
        if (!from || !to) {
            return res.status(400).json({ success: false, error: 'Datas (from/to) são obrigatórias' });
        }

        const data = await analytics.getRevenueBySpecialty({ from, to, doctorId });
        res.json({ success: true, data });
    } catch (err) {
        console.error('Analytics specialties error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/analytics/doctors
 * Query: from, to, sessionType (opcional)
 */
router.get('/doctors', async (req, res) => {
    try {
        const { from, to, sessionType } = req.query;
        if (!from || !to) {
            return res.status(400).json({ success: false, error: 'Datas (from/to) são obrigatórias' });
        }

        const data = await analytics.getRevenueByDoctor({ from, to, sessionType });
        res.json({ success: true, data });
    } catch (err) {
        console.error('Analytics doctors error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/analytics/patients/:id/360
 */
router.get('/patients/:id/360', async (req, res) => {
    try {
        const data = await analytics.getPatient360(req.params.id);
        res.json({ success: true, data });
    } catch (err) {
        console.error('Patient 360 error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/analytics/patients/list
 * Query: page, limit, sortBy, order
 */
router.get('/patients/list', async (req, res) => {
    try {
        const data = await analytics.getPatientsFinancialList(req.query);
        res.json({ success: true, ...data });
    } catch (err) {
        console.error('Patients list error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/analytics/alerts/today
 */
router.get('/alerts/today', async (req, res) => {
    try {
        const data = await analytics.getAlertsForToday();
        res.json({ success: true, data });
    } catch (err) {
        console.error('Analytics alerts error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
