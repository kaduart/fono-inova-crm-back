// routes/expenses.v2.js - API V2 para Despesas (Otimizada com cache)
import express from 'express';
import moment from 'moment-timezone';
import NodeCache from 'node-cache';
import { auth, authorize } from '../middleware/auth.js';
import Expense from '../models/Expense.js';
import Doctor from '../models/Doctor.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import mongoose from 'mongoose';

const router = express.Router();

// Cache para V2 (TTL: 2 minutos)
const expenseCache = new NodeCache({ stdTTL: 120, checkperiod: 60 });

/**
 * Gera chave de cache baseada nos filtros
 */
function generateCacheKey(filters) {
    const { month, year, doctorId, category, status, page, limit } = filters;
    return `expenses_v2_${month}_${year}_${doctorId || 'all'}_${category || 'all'}_${status || 'all'}_${page}_${limit}`;
}

/**
 * @route   GET /api/v2/expenses
 * @desc    Listar despesas com filtros (V2 - Otimizado com cache)
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
            limit = 50,
            nocache = false
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

        const cacheKey = generateCacheKey({ month, year, doctorId, category, status, page, limit });
        
        // Verifica cache (se não forçar refresh)
        if (!nocache) {
            const cached = expenseCache.get(cacheKey);
            if (cached) {
                console.log('[ExpenseV2] Cache hit:', cacheKey);
                return res.json({
                    success: true,
                    ...cached,
                    cached: true
                });
            }
        }

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
                    totalPending: { $sum: { $cond: [{ $in: ['$status', ['pending', 'scheduled']] }, '$amount', 0] } },
                    countPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
                    countPending: { $sum: { $cond: [{ $in: ['$status', ['pending', 'scheduled']] }, 1, 0] } }
                }
            }
        ]);

        const result = {
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
        };

        // Salva no cache
        expenseCache.set(cacheKey, result);

        res.json({
            success: true,
            ...result,
            cached: false
        });

    } catch (error) {
        console.error('[ExpenseV2] Erro ao listar despesas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao listar despesas',
            error: error.message
        });
    }
});

/**
 * @route   POST /api/v2/expenses
 * @desc    Criar nova despesa (V2)
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

        // Invalida cache
        expenseCache.flushAll();

        // Publica evento
        await publishEvent(EventTypes.EXPENSE_CREATED, {
            expenseId: expense[0]._id,
            amount,
            category,
            status
        }, { aggregateType: 'expense', aggregateId: expense[0]._id.toString() });

        res.status(201).json({
            success: true,
            message: 'Despesa registrada com sucesso 💚',
            data: populated
        });

    } catch (error) {
        await session.abortTransaction();
        console.error('[ExpenseV2] Erro ao criar despesa:', error);
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
 * @route   PATCH /api/v2/expenses/:id
 * @desc    Atualizar despesa (V2)
 * @access  Private (admin/secretary)
 */
router.patch('/:id', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const expense = await Expense.findByIdAndUpdate(
            id,
            { ...updates, updatedAt: new Date() },
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

        // Invalida cache
        expenseCache.flushAll();

        // Publica evento
        await publishEvent(EventTypes.EXPENSE_UPDATED, {
            expenseId: id,
            updates
        }, { aggregateType: 'expense', aggregateId: id });

        res.json({
            success: true,
            message: 'Despesa atualizada com sucesso',
            data: expense
        });

    } catch (error) {
        console.error('[ExpenseV2] Erro ao atualizar despesa:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao atualizar despesa',
            error: error.message
        });
    }
});

/**
 * @route   DELETE /api/v2/expenses/:id
 * @desc    Cancelar/deletar despesa (V2)
 * @access  Private (admin/secretary)
 */
router.delete('/:id', auth, authorize(['admin', 'secretary']), async (req, res) => {
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

        // Invalida cache
        expenseCache.flushAll();

        // Publica evento
        await publishEvent(EventTypes.EXPENSE_CANCELED, {
            expenseId: id
        }, { aggregateType: 'expense', aggregateId: id });

        res.json({
            success: true,
            message: 'Despesa cancelada com sucesso'
        });

    } catch (error) {
        console.error('[ExpenseV2] Erro ao cancelar despesa:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao cancelar despesa',
            error: error.message
        });
    }
});

// Exporta cache para invalidação externa
export { expenseCache };

export default router;
