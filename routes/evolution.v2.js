/**
 * 🧬 Evolution Routes — V2
 *
 * Princípio: Writes via eventos (EVOLUTION_*_REQUESTED), reads diretos no MongoDB.
 * Endpoints drop-in replacement para /api/evolutions (V1).
 */

import express from 'express';
import mongoose from 'mongoose';
import Evolution from '../models/Evolution.js';
import Metric from '../models/Metric.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { generatePdfFromEvolution } from '../services/generatePDF.js';

const router = express.Router();

// ========== WRITES (via eventos) ==========

router.post('/', flexibleAuth, async (req, res) => {
    try {
        const payload = req.body;
        const correlationId = `evo_create_${Date.now()}`;

        await publishEvent(EventTypes.EVOLUTION_CREATE_REQUESTED, {
            patientId: payload.patient,
            doctorId: payload.doctor,
            date: payload.date,
            time: payload.time,
            valuePaid: payload.valuePaid,
            sessionType: payload.sessionType,
            paymentType: payload.paymentType,
            appointmentId: payload.appointmentId,
            plan: payload.plan,
            evaluationTypes: payload.evaluationTypes,
            metrics: payload.metrics,
            evaluationAreas: payload.evaluationAreas,
            notes: payload.notes
        }, { correlationId });

        res.status(202).json({
            success: true,
            message: 'Evolução em processamento',
            correlationId
        });
    } catch (error) {
        console.error('[EvolutionV2] Erro ao criar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/:id', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const correlationId = `evo_update_${id}_${Date.now()}`;

        await publishEvent(EventTypes.EVOLUTION_UPDATE_REQUESTED, {
            evolutionId: id,
            ...req.body
        }, { correlationId });

        res.status(202).json({
            success: true,
            message: 'Atualização em processamento',
            correlationId
        });
    } catch (error) {
        console.error('[EvolutionV2] Erro ao atualizar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/:id', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const correlationId = `evo_delete_${id}_${Date.now()}`;

        await publishEvent(EventTypes.EVOLUTION_DELETE_REQUESTED, {
            evolutionId: id
        }, { correlationId });

        res.status(202).json({
            success: true,
            message: 'Exclusão em processamento',
            correlationId
        });
    } catch (error) {
        console.error('[EvolutionV2] Erro ao deletar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== READS (diretos no MongoDB) ==========

router.get('/patient/:patientId', flexibleAuth, async (req, res) => {
    try {
        const { patientId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const evolutions = await Evolution.find({ patient: patientId })
            .populate('doctor', 'fullName specialty')
            .populate('patient', 'fullName dateOfBirth')
            .sort({ date: -1 });

        res.json({ success: true, data: evolutions });
    } catch (error) {
        console.error('[EvolutionV2] Erro ao listar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/chart/:patientId', flexibleAuth, async (req, res) => {
    try {
        const { patientId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const evolutions = await Evolution.find({ patient: patientId })
            .select('date metrics evaluationAreas')
            .sort({ date: 1 });

        // Formata dados para gráfico
        const chartData = evolutions.map(evo => ({
            date: evo.date,
            metrics: evo.metrics || [],
            evaluationAreas: evo.evaluationAreas || []
        }));

        res.json({ success: true, data: chartData });
    } catch (error) {
        console.error('[EvolutionV2] Erro no chart:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/patient/:patientId/progress', flexibleAuth, async (req, res) => {
    try {
        const { patientId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const evolutions = await Evolution.find({ patient: patientId })
            .select('date metrics plan')
            .sort({ date: 1 });

        // Calcula progresso simples: média de scores das métricas ao longo do tempo
        const progress = evolutions.map(evo => {
            const metrics = evo.metrics || [];
            const avgScore = metrics.length
                ? metrics.reduce((sum, m) => sum + (m.value || 0), 0) / metrics.length
                : 0;
            return {
                date: evo.date,
                avgScore: Math.round(avgScore * 100) / 100,
                metricCount: metrics.length
            };
        });

        res.json({ success: true, data: progress });
    } catch (error) {
        console.error('[EvolutionV2] Erro no progress:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/patient/:patientId/history', flexibleAuth, async (req, res) => {
    try {
        const { patientId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const evolutions = await Evolution.find({ patient: patientId })
            .populate('doctor', 'fullName specialty')
            .select('date time sessionType plan notes createdAt')
            .sort({ date: -1 });

        res.json({ success: true, data: evolutions });
    } catch (error) {
        console.error('[EvolutionV2] Erro no history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/search', flexibleAuth, async (req, res) => {
    try {
        const { startDate, endDate, type, doctor, protocol } = req.query;
        let filter = {};

        if (startDate) filter.date = { $gte: new Date(startDate) };
        if (endDate) filter.date = { ...filter.date, $lte: new Date(endDate) };
        if (type) filter.sessionType = type;
        if (doctor) filter.doctor = doctor;
        if (protocol) filter.plan = protocol;

        const evolutions = await Evolution.find(filter)
            .populate('doctor', 'fullName specialty')
            .populate('patient', 'fullName')
            .sort({ date: -1 });

        res.json({ success: true, data: evolutions });
    } catch (error) {
        console.error('[EvolutionV2] Erro na busca:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== MÉTRICAS ==========

router.get('/metrics', flexibleAuth, async (req, res) => {
    try {
        const metrics = await Metric.find();
        res.json({ success: true, data: metrics });
    } catch (error) {
        console.error('[EvolutionV2] Erro ao buscar métricas:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== PDF (síncrono) ==========

router.get('/:id/pdf', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const evolution = await Evolution.findById(id)
            .populate('patient', 'fullName dateOfBirth')
            .populate('doctor', 'fullName specialty');

        if (!evolution) {
            return res.status(404).json({ success: false, error: 'Evolução não encontrada' });
        }

        const pdfBuffer = await generatePdfFromEvolution(evolution);
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="evolucao-${evolution._id}.pdf"`
        });
        res.send(pdfBuffer);
    } catch (error) {
        console.error('[EvolutionV2] Erro ao gerar PDF:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
