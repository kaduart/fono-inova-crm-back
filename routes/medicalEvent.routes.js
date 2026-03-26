import express from 'express';
import MedicalEvent from '../models/MedicalEvent.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

/**
 * 📋 Timeline completo do paciente (auditoria)
 * GET /api/medical-events/patient/:patientId/timeline
 */
router.get('/patient/:patientId/timeline', auth, async (req, res) => {
    try {
        const { patientId } = req.params;
        const { startDate, endDate, type, limit = 50 } = req.query;

        const filters = { patient: patientId };

        if (startDate || endDate) {
            filters.date = {};
            if (startDate) filters.date.$gte = new Date(startDate);
            if (endDate) filters.date.$lte = new Date(endDate);
        }

        if (type) {
            filters.type = type; // 'session', 'appointment', 'payment', etc
        }

        const events = await MedicalEvent.find(filters)
            .sort({ date: -1, createdAt: -1 })
            .limit(parseInt(limit))
            .lean();

        // Agrupa por data para facilitar exibição no front
        const grouped = events.reduce((acc, event) => {
            const dateKey = new Date(event.date).toISOString().split('T')[0];
            if (!acc[dateKey]) acc[dateKey] = [];
            acc[dateKey].push(event);
            return acc;
        }, {});

        res.json({
            success: true,
            patientId,
            total: events.length,
            timeline: grouped,
            events: events // lista flat também
        });

    } catch (error) {
        console.error('❌ Erro ao buscar timeline:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * 📊 Resumo financeiro do paciente (baseado em MedicalEvent)
 * GET /api/medical-events/patient/:patientId/financial-summary
 */
router.get('/patient/:patientId/financial-summary', auth, async (req, res) => {
    try {
        const { patientId } = req.params;
        const { startDate, endDate } = req.query;

        const matchStage = { 
            patient: patientId,
            type: { $in: ['session', 'payment'] }
        };

        if (startDate || endDate) {
            matchStage.date = {};
            if (startDate) matchStage.date.$gte = new Date(startDate);
            if (endDate) matchStage.date.$lte = new Date(endDate);
        }

        const summary = await MedicalEvent.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: '$operationalStatus',
                    count: { $sum: 1 },
                    totalValue: { $sum: '$value' }
                }
            }
        ]);

        const result = {
            paid: { count: 0, total: 0 },
            pending: { count: 0, total: 0 },
            completed: { count: 0, total: 0 },
            canceled: { count: 0, total: 0 }
        };

        summary.forEach(item => {
            if (result[item._id]) {
                result[item._id].count = item.count;
                result[item._id].total = item.totalValue;
            }
        });

        res.json({
            success: true,
            patientId,
            summary: result
        });

    } catch (error) {
        console.error('❌ Erro ao buscar resumo financeiro:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * 🔍 Buscar evento específico
 * GET /api/medical-events/:eventId
 */
router.get('/:eventId', auth, async (req, res) => {
    try {
        const event = await MedicalEvent.findById(req.params.eventId).lean();
        
        if (!event) {
            return res.status(404).json({ success: false, message: 'Evento não encontrado' });
        }

        res.json({ success: true, event });

    } catch (error) {
        console.error('❌ Erro ao buscar evento:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

export default router;
