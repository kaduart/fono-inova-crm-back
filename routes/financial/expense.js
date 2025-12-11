// routes/expenseRoutes.js
import express from 'express';
import mongoose from 'mongoose';
import { auth, authorize } from '../../middleware/auth.js';
import Doctor from '../../models/Doctor.js';
import Expense from '../../models/Expense.js';

const router = express.Router();

/**
 * @route   POST /api/expenses
 * @desc    Criar nova despesa
 * @access  Private (admin/secretary)
 */
router.post('/', auth, authorize(['admin', 'secretary']), async (req, res) => {
    const session = await mongoose.startSession();

    try {
        await session.startTransaction();

        const {
            description,
            category,
            subcategory,
            amount,
            date,
            relatedDoctor,
            workPeriod,
            paymentMethod,
            status = 'pending',
            isRecurring,
            recurrence,
            notes
        } = req.body;

        // Validação
        if (!description || !category || !amount || !date || !paymentMethod) {
            return res.status(400).json({
                success: false,
                message: 'Campos obrigatórios faltando'
            });
        }

        // Se vinculada a profissional, validar existência
        if (relatedDoctor) {
            const doctorExists = await Doctor.exists({ _id: relatedDoctor }).session(session);
            if (!doctorExists) {
                return res.status(404).json({
                    success: false,
                    message: 'Profissional não encontrado'
                });
            }
        }

        const expense = await Expense.create([{
            description,
            category,
            subcategory,
            amount,
            date,
            relatedDoctor: relatedDoctor || null,
            workPeriod,
            paymentMethod,
            status,
            isRecurring,
            recurrence,
            notes,
            createdBy: req.user.id
        }], { session });

        await session.commitTransaction();

        const populated = await Expense.findById(expense[0]._id)
            .populate('relatedDoctor', 'fullName specialty')
            .populate('createdBy', 'fullName');

        res.status(201).json({
            success: true,
            message: 'Despesa registrada com sucesso 💚',
            data: populated
        });

    } catch (error) {
        await session.abortTransaction();
        console.error('Erro ao criar despesa:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao registrar despesa',
            error: error.message
        });
    } finally {
        session.endSession();
    }
});

/**
 * @route   GET /api/expenses
 * @desc    Listar despesas com filtros
 * @query   ?month=11&year=2024&doctorId=...&category=...&status=...
 * @access  Private
 */
router.get('/', auth, async (req, res) => {
    try {
        const {
            month,
            year,
            doctorId,
            category,
            subcategory,
            status,
            startDate,
            endDate,
            page = 1,
            limit = 50
        } = req.query;

        const filters = {};

        // Filtro de data
        if (month && year) {
            const start = `${year}-${String(month).padStart(2, '0')}-01`;
            const lastDay = new Date(year, month, 0).getDate();
            const end = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
            filters.date = { $gte: start, $lte: end };
        } else if (startDate && endDate) {
            filters.date = { $gte: startDate, $lte: endDate };
        }

        if (doctorId) filters.relatedDoctor = doctorId;
        if (category) filters.category = category;
        if (subcategory) filters.subcategory = subcategory;
        if (status) filters.status = status;

        const skip = (page - 1) * limit;

        const [expenses, total] = await Promise.all([
            Expense.find(filters)
                .populate('relatedDoctor', 'fullName specialty')
                .populate('createdBy', 'fullName')
                .sort({ date: -1, createdAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),

            Expense.countDocuments(filters)
        ]);

        // Totais
        const totals = await Expense.aggregate([
            { $match: filters },
            {
                $group: {
                    _id: null,
                    totalPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
                    totalPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amount', 0] } },
                    countPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
                    countPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } }
                }
            }
        ]);

        res.json({
            success: true,
            data: expenses,
            pagination: {
                page: Number(page),
                limit: Number(limit),
                total,
                pages: Math.ceil(total / limit)
            },
            totals: totals[0] || {
                totalPaid: 0,
                totalPending: 0,
                countPaid: 0,
                countPending: 0
            }
        });

    } catch (error) {
        console.error('Erro ao listar despesas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao listar despesas',
            error: error.message
        });
    }
});

/**
 * @route   GET /api/expenses/by-doctor/:doctorId
 * @desc    Despesas de um profissional específico
 * @access  Private
 */
router.get('/by-doctor/:doctorId', auth, async (req, res) => {
    try {
        const { doctorId } = req.params;
        const { month, year } = req.query;

        const filters = { relatedDoctor: doctorId };

        if (month && year) {
            const start = `${year}-${String(month).padStart(2, '0')}-01`;
            const lastDay = new Date(year, month, 0).getDate();
            const end = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
            filters.date = { $gte: start, $lte: end };
        }

        const [expenses, summary] = await Promise.all([
            Expense.find(filters)
                .populate('createdBy', 'fullName')
                .sort({ date: -1 })
                .lean(),

            Expense.aggregate([
                { $match: filters },
                {
                    $group: {
                        _id: '$category',
                        total: { $sum: '$amount' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { total: -1 } }
            ])
        ]);

        const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);

        res.json({
            success: true,
            data: {
                expenses,
                summary,
                totalExpenses,
                avgMonthly: month && year ? totalExpenses : null
            }
        });

    } catch (error) {
        console.error('Erro ao buscar despesas do profissional:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar despesas',
            error: error.message
        });
    }
});

/**
 * @route   PATCH /api/expenses/:id
 * @desc    Atualizar despesa
 * @access  Private (admin/secretary)
 */
router.patch('/:id', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = { ...req.body, updatedAt: new Date() };

        // Remove campos que não podem ser atualizados diretamente
        delete updateData.createdBy;
        delete updateData.createdAt;

        const expense = await Expense.findByIdAndUpdate(
            id,
            updateData,
            { new: true, runValidators: true }
        )
            .populate('relatedDoctor', 'fullName specialty')
            .populate('createdBy', 'fullName');

        if (!expense) {
            return res.status(404).json({
                success: false,
                message: 'Despesa não encontrada'
            });
        }

        res.json({
            success: true,
            message: 'Despesa atualizada com sucesso 💚',
            data: expense
        });

    } catch (error) {
        console.error('Erro ao atualizar despesa:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao atualizar despesa',
            error: error.message
        });
    }
});

/**
 * @route   DELETE /api/expenses/:id
 * @desc    Cancelar despesa (soft delete)
 * @access  Private (admin)
 */
router.delete('/:id', auth, authorize(['admin']), async (req, res) => {
    try {
        const { id } = req.params;

        const expense = await Expense.findByIdAndUpdate(
            id,
            { status: 'canceled', updatedAt: new Date() },
            { new: true }
        );

        if (!expense) {
            return res.status(404).json({
                success: false,
                message: 'Despesa não encontrada'
            });
        }

        res.json({
            success: true,
            message: 'Despesa cancelada com sucesso',
            data: expense
        });

    } catch (error) {
        console.error('Erro ao cancelar despesa:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao cancelar despesa',
            error: error.message
        });
    }
});

export default router;