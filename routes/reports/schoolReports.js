// routes/reports/schoolReports.js
import express from "express";

import SchoolReport from "../../models/SchoolReport.js"; // Modelo específico para relatório escolar

const router = express.Router();

// GET /api/school-reports/patient/:patientId - Buscar relatórios escolares por paciente
router.get('/patient/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;
        const { page = 1, limit = 10 } = req.query;

        const skip = (page - 1) * limit;

        const reports = await SchoolReport.find({ patientId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .exec();

        const total = await SchoolReport.countDocuments({ patientId });

        res.json({
            success: true,
            reports,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit)
        });

    } catch (error) {
        console.error('Erro ao buscar relatórios escolares:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

// GET /api/school-reports/:id - Buscar relatório escolar por ID
router.get('/:id', async (req, res) => {
    try {
        const report = await SchoolReport.findById(req.params.id)
            .populate('patientId')
            .exec();

        if (!report) {
            return res.status(404).json({
                success: false,
                error: 'Relatório escolar não encontrado'
            });
        }

        res.json({
            success: true,
            report
        });

    } catch (error) {
        console.error('Erro ao buscar relatório escolar:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

// POST /api/school-reports - Criar novo relatório escolar
router.post('/', async (req, res) => {
    try {
        const schoolReportData = {
            ...req.body,
            type: 'school',
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const newSchoolReport = new SchoolReport(schoolReportData);
        const savedSchoolReport = await newSchoolReport.save();

        await savedSchoolReport.populate('patientId');

        res.status(201).json({
            success: true,
            report: savedSchoolReport
        });

    } catch (error) {
        console.error('Erro ao criar relatório escolar:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

// PUT /api/school-reports/:id - Atualizar relatório escolar
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const updatedSchoolReport = await SchoolReport.findByIdAndUpdate(
            id,
            {
                ...req.body,
                updatedAt: new Date()
            },
            { new: true, runValidators: true }
        ).populate('patientId');

        if (!updatedSchoolReport) {
            return res.status(404).json({
                success: false,
                error: 'Relatório escolar não encontrado'
            });
        }

        res.json({
            success: true,
            report: updatedSchoolReport
        });

    } catch (error) {
        console.error('Erro ao atualizar relatório escolar:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

export default router;