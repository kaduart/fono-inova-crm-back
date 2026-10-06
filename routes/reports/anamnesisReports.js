import express from "express";
import { sendApiError } from '../../errors/buildErrorResponse.js';
import { AppError } from '../../errors/AppError.js';
import AnamnesisReport from "../../models/AnamnesisReport.js"; // Modelo específico para anamnese

const router = express.Router();

// GET /api/anamnesis-reports/patient/:patientId - Buscar anamneses por paciente
router.get('/patient/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;
        const { page = 1, limit = 10 } = req.query;

        const skip = (page - 1) * limit;

        const reports = await AnamnesisReport.find({ patientId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .exec();

        const total = await AnamnesisReport.countDocuments({ patientId });

        res.json({
            success: true,
            reports,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit)
        });

    } catch (error) {
        console.error('Erro ao buscar anamneses:', error);
        sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro interno do servidor', { status: 500 }), req);
    }
});

// GET /api/anamnesis-reports/:id - Buscar anamnese por ID
router.get('/:id', async (req, res) => {
    try {
        const report = await AnamnesisReport.findById(req.params.id)
            .populate('patientId')
            .exec();

        if (!report) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Anamnese não encontrada', { status: 404 }), req);
        }

        res.json({
            success: true,
            report
        });

    } catch (error) {
        console.error('Erro ao buscar anamnese:', error);
        sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro interno do servidor', { status: 500 }), req);
    }
});

// POST /api/anamnesis-reports - Criar nova anamnese
router.post('/', async (req, res) => {
    try {
        const anamnesisData = {
            ...req.body,
            type: 'anamnesis',
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const newAnamnesis = new AnamnesisReport(anamnesisData);
        const savedAnamnesis = await newAnamnesis.save();

        await savedAnamnesis.populate('patientId');

        res.status(201).json({
            success: true,
            report: savedAnamnesis
        });

    } catch (error) {
        console.error('Erro ao criar anamnese:', error);
        sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro interno do servidor', { status: 500 }), req);
    }
});

// PUT /api/anamnesis-reports/:id - Atualizar anamnese
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const updatedAnamnesis = await AnamnesisReport.findByIdAndUpdate(
            id,
            {
                ...req.body,
                updatedAt: new Date()
            },
            { new: true, runValidators: true }
        ).populate('patientId');

        if (!updatedAnamnesis) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Anamnese não encontrada', { status: 404 }), req);
        }

        res.json({
            success: true,
            report: updatedAnamnesis
        });

    } catch (error) {
        console.error('Erro ao atualizar anamnese:', error);
        sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro interno do servidor', { status: 500 }), req);
    }
});

export default router;