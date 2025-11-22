import express from 'express';
import {
    createEvaluation,
    deleteEvaluation,
    getEvaluationChartData,
    getEvaluationsByPatient,
    getPatientEvolutionHistory,
    getPatientProgress,
    updateEvaluation
} from '../controllers/evaluationController.js';
import { auth, authorize } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import Evolution from '../models/Evolution.js';
import Metric from '../models/Metric.js';
import { generatePdfFromEvolution } from '../services/generatePDF.js';

const router = express.Router();
router.use(auth);

// ========== ENDPOINTS PRINCIPAIS ==========
router.post("/", authorize(["admin", "doctor"]), createEvaluation);
router.get("/patient/:patientId", authorize(["admin", "doctor"]), getEvaluationsByPatient);
router.get("/chart/:patientId", authorize(["admin", "doctor"]), getEvaluationChartData);
router.delete("/:id", validateId, authorize(["admin", "doctor"]), deleteEvaluation);
router.put('/:id', validateId, authorize(["admin", "doctor"]), updateEvaluation);

// ========== NOVOS ENDPOINTS ==========
router.get("/patient/:patientId/progress", authorize(["admin", "doctor"]), getPatientProgress);
router.get("/patient/:patientId/history", authorize(["admin", "doctor"]), getPatientEvolutionHistory);

// ========== MÉTRICAS ==========
router.get('/metrics', async (req, res) => {
    try {
        const metrics = await Metric.find();
        res.json(metrics);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== PDF GENERATION ==========
router.get('/:id/pdf', validateId, async (req, res) => {
    try {
        const evolution = await Evolution.findById(req.params.id)
            .populate('patient', 'fullName dateOfBirth')
            .populate('doctor', 'fullName specialty');

        if (!evolution) {
            return res.status(404).json({ error: 'Evolução não encontrada' });
        }

        const pdfBuffer = await generatePdfFromEvolution(evolution);
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="evolucao-${evolution._id}.pdf"`
        });
        res.send(pdfBuffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== BUSCA AVANÇADA ==========
router.get('/search', async (req, res) => {
    const { startDate, endDate, type, doctor, protocol } = req.query;
    let filter = {};

    if (startDate) filter.date = { $gte: new Date(startDate) };
    if (endDate) filter.date = { ...filter.date, $lte: new Date(endDate) };
    if (type) filter.type = type;
    if (doctor) filter.doctor = doctor;
    if (protocol) filter.activeProtocols = protocol;

    try {
        const evolutions = await Evolution.find(filter)
            .populate('doctor')
            .sort({ date: -1 });
        res.json(evolutions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;