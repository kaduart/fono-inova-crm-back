// routes/expenseRoutes.js
import express from 'express';
import mongoose from 'mongoose';
import { auth, authorize } from '../../middleware/auth.js';
import Doctor from '../../models/Doctor.js';
import Expense from '../../models/Expense.js';
import { publishEvent, EventTypes } from '../../infrastructure/events/eventPublisher.js';
import { getEventStatus } from '../../infrastructure/events/eventStoreService.js';
import EventStore from '../../models/EventStore.js';
import { sendApiError } from '../../errors/buildErrorResponse.js';
import { AppError } from '../../errors/AppError.js';

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
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Campos obrigatórios faltando', {
                status: 400,
              }),
              req
            );
        }

        // Se vinculada a profissional, validar existência
        if (relatedDoctor) {
            const doctorExists = await Doctor.exists({ _id: relatedDoctor }).session(session);
            if (!doctorExists) {
                return sendApiError(
                  res,
                  new AppError('NOT_FOUND', 'Profissional não encontrado', {
                    status: 404,
                  }),
                  req
                );
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
            createdBy: req.user.id,
            createdByRole: req.user.role
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
        console.error('Payload recebido:', req.body);
        console.error('User:', req.user);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', 'Erro ao registrar despesa', {
            status: 500,
            legacyError: error.message,
            details: error.errors ? Object.keys(error.errors).map(k => `${k}: ${error.errors[k].message}`) : null,
          }),
          req
        );
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
                    totalPending: { $sum: { $cond: [{ $in: ['$status', ['pending', 'scheduled']] }, '$amount', 0] } },
                    countPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
                    countPending: { $sum: { $cond: [{ $in: ['$status', ['pending', 'scheduled']] }, 1, 0] } }
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
        sendApiError(res, error, req);
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
        sendApiError(res, error, req);
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
            return sendApiError(res, new AppError('NOT_FOUND', 'Despesa não encontrada', { status: 404 }), req);
        }

        // 🔹 Disparar recálculo de totais (não bloqueante)
        try {
            await publishEvent(
                EventTypes.TOTALS_RECALCULATE_REQUESTED,
                {
                    clinicId: null,
                    date: expense.date || new Date().toISOString().split('T')[0],
                    period: 'month',
                    reason: 'expense_updated',
                    triggeredBy: 'expense_controller',
                    expenseId: expense._id.toString(),
                    expenseStatus: expense.status,
                    expenseAmount: expense.amount
                }
            );
        } catch (err) {
            console.error('[ExpenseController] Erro ao publicar recálculo:', err.message);
        }

        res.json({
            success: true,
            message: 'Despesa atualizada com sucesso 💚',
            data: expense
        });

    } catch (error) {
        console.error('Erro ao atualizar despesa:', error);
        sendApiError(res, error, req);
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
        )
            .populate('relatedDoctor', 'fullName specialty')
            .populate('createdBy', 'fullName');

        if (!expense) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Despesa não encontrada', { status: 404 }), req);
        }

        // 🔹 Disparar recálculo de totais (não bloqueante)
        try {
            await publishEvent(
                EventTypes.TOTALS_RECALCULATE_REQUESTED,
                {
                    clinicId: null,
                    date: expense.date || new Date().toISOString().split('T')[0],
                    period: 'month',
                    reason: 'expense_canceled',
                    triggeredBy: 'expense_controller',
                    expenseId: expense._id.toString(),
                    expenseStatus: 'canceled',
                    expenseAmount: expense.amount
                }
            );
        } catch (err) {
            console.error('[ExpenseController] Erro ao publicar recálculo:', err.message);
        }

        res.json({
            success: true,
            message: 'Despesa cancelada com sucesso',
            data: expense
        });

    } catch (error) {
        console.error('Erro ao cancelar despesa:', error);
        sendApiError(res, error, req);
    }
});

// POST /api/expenses/generate-commissions
router.post('/generate-commissions', auth, async (req, res) => {
    try {
        const { month, year, regenerate } = req.body || {};
        const m = month ? Number(month) : undefined;
        const y = year ? Number(year) : undefined;

        if (!m || !y || m < 1 || m > 12 || y < 2000 || y > 2100) {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Mês e ano são obrigatórios e devem ser válidos', {
                status: 400,
              }),
              req
            );
        }

        const aggregateId = `commission-${y}-${String(m).padStart(2, '0')}`;
        // 🔁 Regenerar precisa de idempotencyKey única (a chave fixa por período nunca
        // seria reprocessada de novo, mesmo com sessões novas desde a última geração —
        // ver back/docs, incidente 2026-07-08). O guard de concorrência abaixo (por
        // aggregateId) continua valendo normalmente.
        const idempotencyKey = regenerate
            ? `commission-generation:${aggregateId}:regen-${Date.now()}`
            : `commission-generation:${aggregateId}`;

        // 🛡️ Evita duas gerações simultâneas para o mesmo período
        const inProgress = await EventStore.findOne({
            eventType: EventTypes.COMMISSION_GENERATION_REQUESTED,
            aggregateId,
            status: { $in: ['pending', 'processing'] }
        }).lean();

        if (inProgress) {
            return res.status(409).json({
                success: true,
                status: 'processing',
                eventId: inProgress.eventId,
                message: 'Geração de comissões já está em andamento para este período.'
            });
        }

        const result = await publishEvent(
            EventTypes.COMMISSION_GENERATION_REQUESTED,
            { month: m, year: y, aggregateId, regenerate: !!regenerate },
            {
                correlationId: req.headers['x-correlation-id'] || `comm_${Date.now()}`,
                idempotencyKey,
                metadata: {
                    source: 'expenseRoutes.generate-commissions',
                    userId: req.user?.id
                }
            }
        );

        return res.status(202).json({
            success: true,
            status: 'processing',
            eventId: result.eventId,
            message: 'Geração de comissões iniciada. Você pode acompanhar o progresso pela tela.'
        });
    } catch (error) {
        console.error('[POST /generate-commissions] Erro:', error);
        return sendApiError(res, error, req);
    }
});

// GET /api/expenses/generate-commissions/status/:eventId
router.get('/generate-commissions/status/:eventId', auth, authorize(['admin']), async (req, res) => {
    try {
        const { eventId } = req.params;
        const status = await getEventStatus(eventId);

        if (!status) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Evento não encontrado', { status: 404 }), req);
        }

        return res.json({
            success: true,
            data: status
        });
    } catch (error) {
        console.error('[GET /generate-commissions/status] Erro:', error);
        return sendApiError(res, error, req);
    }
});

export default router;