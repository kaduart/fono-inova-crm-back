import express from 'express';
import { createEvaluation, getEvaluationsByPatient } from '../controllers/evaluationController.js';
import { auth, authorize } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import Evolution from '../models/Evolution.js';
import Metric from '../models/Metric.js';
import { generatePdfFromEvolution } from '../services/generatePDF.js';
import SaveEvolutionHistory from '../services/historyService.js';

const router = express.Router();
router.use(auth);

// Obter todas as métricas disponíveis
router.get('/metrics', async (req, res) => {
    try {
        const metrics = await Metric.find();
        res.json(metrics);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Criar nova evolução
router.post('/', authorize(['admin', 'professional']), async (req, res) => {
    try {
        // Adiciona especialidade automaticamente baseada no profissional
        const specialty = req.user.specialty;

        const evolutionData = {
            ...req.body,
            specialty,
            therapist: req.user.id
        };

        const evolution = new Evolution(evolutionData);
        await evolution.save();

        // Processamento especializado para neuropediatria
        if (specialty === 'neuroped') {
            await createNeuropedAssessment(evolution);
        }

        res.status(201).json(evolution);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// routes/evolutions.js
router.put('/:id', authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { id } = req.params;
        const update = req.body;

        const evolution = await Evolution.findById(id);
        if (!evolution) return res.status(404).json({ error: 'Avaliação não encontrada' });

        /* if (evolution.type !== 'avaliação') {
          return res.status(403).json({ error: 'Apenas avaliações podem ser editadas nesta rota.' });
        } */

        Object.assign(evolution, update);
        await evolution.save();

        res.status(200).json({ message: 'Avaliação atualizada com sucesso', evolution });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});


// Obter evoluções de um paciente
router.get('/patient/:patientId', async (req, res) => {
    try {
        const evolutions = await Evolution.find({ patientId: req.params.patientId })
            .sort({ date: 1 })
            .populate('doctorId', 'fullName specialty');

        res.json(evolutions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Obter uma evolução específica
router.get('/:id', validateId, auth, async (req, res) => {
    try {
        const evolution = await Evolution.findById(req.params.id)
            .populate('patientId', 'fullName')
            .populate('doctorId', 'fullName specialty');

        if (!evolution) {
            return res.status(404).json({ error: 'Evolução não encontrada' });
        }

        res.json(evolution);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Excluir evolução
router.delete('/:id', validateId, auth, async (req, res) => {
    try {
        const evolution = await Evolution.findByIdAndDelete(req.params.id);

        if (!evolution) {
            return res.status(404).json({ error: 'Evolução não encontrada' });
        }

        res.json({ message: 'Evolução excluída com sucesso' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/:id/pdf', validateId, auth, async (req, res) => {
    try {
        const evolution = await Evolution.findById(req.params.id)
            .populate('patientId', 'fullName dateOfBirth')
            .populate('doctorId', 'fullName specialty');

        if (!evolution) return res.status(404).json({ error: 'Evolução não encontrada' });

        // Lógica de geração do PDF (usando html-pdf ou puppeteer)
        // Aqui apenas uma simulação:
        const pdfBuffer = await generatePdfFromEvolution(evolution); // implementar isso

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="evolucao-${evolution._id}.pdf"`
        });
        res.send(pdfBuffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const checkEditPermission = (userId, evolution) => {
    if (evolution.createdBy.toString() === userId.toString()) return true;
    return userId.role === 'admin';
};


router.put('/:id', validateId, auth, async (req, res) => {
    const { id } = req.params;
    const updatedData = req.body;
    const userId = req.user.id;  // ID do profissional logado

    const evolution = await Evolution.findById(id);
    if (!evolution) return res.status(404).json({ error: 'Evolução não encontrada' });

    if (!checkEditPermission(userId, evolution)) {
        return res.status(403).json({ error: 'Você não tem permissão para editar esta evolução' });
    }
    // Salvar dados anteriores para histórico
    const previousData = evolution;

    // Atualizar evolução com novos dados
    Object.assign(evolution, updatedData);
    await evolution.save();

    // Registrar no histórico
    await SaveEvolutionHistory(id, userId, 'UPDATE', previousData);

    res.status(200).json({ message: 'Evolução atualizada' });
});


router.get('/evolutions/search', async (req, res) => {
    const { startDate, endDate, type, professional } = req.query;

    let filter = {};
    if (startDate) filter.createdAt = { $gte: new Date(startDate) };
    if (endDate) filter.createdAt = { ...filter.createdAt, $lte: new Date(endDate) };
    if (type) filter.type = type;
    if (professional) filter.professional = professional;

    const evolutions = await Evolution.find(filter).populate('professional');
    res.json(evolutions);
});


const handleSearch = async () => {
    const response = await axios.get('/evolutions/search', { params: filters });
    setEvolutions(response.data);
};

// POST /api/evaluations
router.post("/availables", authorize(["admin", "professional"]), createEvaluation);

// GET /api/evaluations/:patientId
router.get("/patient/:patientId", authorize(["admin", "professional"]), getEvaluationsByPatient);



export default router;