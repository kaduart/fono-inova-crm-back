// routes/reports/medicalReports.js
import express from "express";
import MedicalReport from "../../models/MedicalReport.js"; // Você precisará criar este modelo

const router = express.Router();

// GET /api/medical-reports - Listar relatórios médicos com filtros
router.get('/', async (req, res) => {
    try {
        const {
            type,
            patientId,
            patientName,
            page = 1,
            limit = 10,
            startDate,
            endDate
        } = req.query;

        // Construir filtros
        let filter = {};

        if (type && type !== 'all') {
            filter.type = type;
        }

        if (patientId) {
            filter.patientId = patientId;
        }

        if (patientName) {
            filter.patientName = { $regex: patientName, $options: 'i' };
        }

        if (startDate && endDate) {
            filter.date = {
                $gte: new Date(startDate),
                $lte: new Date(endDate)
            };
        }

        const skip = (page - 1) * limit;

        // Buscar relatórios com populate se necessário
        const reports = await MedicalReport.find(filter)
            .sort({ date: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .populate('patientId', 'fullName age phone email') // Populate com dados do paciente
            .exec();

        const total = await MedicalReport.countDocuments(filter);

        res.json({
            success: true,
            reports,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit)
        });

    } catch (error) {
        console.error('Erro ao buscar relatórios médicos:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

// GET /api/medical-reports/patient/:patientId - Buscar relatórios por paciente
router.get('/patient/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;
        const { type, page = 1, limit = 10 } = req.query;

        let filter = { patientId };

        if (type && type !== 'all') {
            filter.type = type;
        }

        const skip = (page - 1) * limit;

        const reports = await MedicalReport.find(filter)
            .sort({ date: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .exec();

        const total = await MedicalReport.countDocuments(filter);

        res.json({
            success: true,
            reports,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / limit)
        });

    } catch (error) {
        console.error('Erro ao buscar relatórios do paciente:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

// GET /api/medical-reports/:id - Buscar relatório por ID
router.get('/:id', async (req, res) => {
    try {
        const report = await MedicalReport.findById(req.params.id)
            .populate('patientId', 'fullName age phone email healthPlan')
            .exec();

        if (!report) {
            return res.status(404).json({
                success: false,
                error: 'Relatório não encontrado'
            });
        }

        res.json({
            success: true,
            report
        });

    } catch (error) {
        console.error('Erro ao buscar relatório:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

// POST /api/medical-reports - Criar novo relatório
router.post('/', async (req, res) => {
    try {
        const {
            type,
            patientId,
            patientName,
            patientAge,
            date,
            content,
            createdBy,
            status = 'completed'
        } = req.body;

        // Validação básica
        if (!type || !patientId || !patientName || !date) {
            return res.status(400).json({
                success: false,
                error: 'Campos obrigatórios faltando: type, patientId, patientName, date'
            });
        }

        const newReport = new MedicalReport({
            type,
            patientId,
            patientName,
            patientAge: patientAge ? parseInt(patientAge) : undefined,
            date,
            content: content || {},
            createdBy: createdBy || 'Sistema',
            status,
            createdAt: new Date(),
            updatedAt: new Date()
        });

        const savedReport = await newReport.save();

        // Populate para retornar dados completos
        await savedReport.populate('patientId', 'fullName age phone email');

        res.status(201).json({
            success: true,
            report: savedReport
        });

    } catch (error) {
        console.error('Erro ao criar relatório:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

// PUT /api/medical-reports/:id - Atualizar relatório
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const updatedReport = await MedicalReport.findByIdAndUpdate(
            id,
            {
                ...req.body,
                updatedAt: new Date()
            },
            { new: true, runValidators: true }
        ).populate('patientId', 'fullName age phone email');

        if (!updatedReport) {
            return res.status(404).json({
                success: false,
                error: 'Relatório não encontrado'
            });
        }

        res.json({
            success: true,
            report: updatedReport
        });

    } catch (error) {
        console.error('Erro ao atualizar relatório:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

// DELETE /api/medical-reports/:id - Deletar relatório
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const deletedReport = await MedicalReport.findByIdAndDelete(id);

        if (!deletedReport) {
            return res.status(404).json({
                success: false,
                error: 'Relatório não encontrado'
            });
        }

        res.json({
            success: true,
            message: 'Relatório deletado com sucesso',
            report: deletedReport
        });

    } catch (error) {
        console.error('Erro ao deletar relatório:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

// GET /api/medical-reports/stats/patient/:patientId - Estatísticas do paciente
router.get('/stats/patient/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;

        const stats = await MedicalReport.aggregate([
            { $match: { patientId: patientId } },
            {
                $group: {
                    _id: '$type',
                    count: { $sum: 1 },
                    lastReport: { $max: '$date' }
                }
            }
        ]);

        const totalReports = await MedicalReport.countDocuments({ patientId });

        res.json({
            success: true,
            stats: {
                byType: stats,
                total: totalReports
            }
        });

    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno do servidor'
        });
    }
});

export default router;