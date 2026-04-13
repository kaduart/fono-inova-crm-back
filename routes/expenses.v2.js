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
 * @desc    Criar nova despesa (V2 - Otimizado, sem transaction)
 * @access  Private (admin/secretary)
 */
router.post('/', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
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

        // 🛡️ VALIDAÇÃO (fail fast)
        if (!description || !category || !amount || !date || !paymentMethod) {
            return res.status(400).json({
                success: false,
                message: 'Campos obrigatórios: description, category, amount, date, paymentMethod'
            });
        }

        // 🛡️ VALIDAÇÃO: Usuário autenticado
        if (!req.user?.id || !req.user?.role) {
            return res.status(401).json({
                success: false,
                message: 'Usuário não autenticado. Token inválido ou expirado.'
            });
        }

        // Se vinculada a profissional, validar existência (sem session)
        if (relatedDoctor) {
            const doctorExists = await Doctor.exists({ _id: relatedDoctor });
            if (!doctorExists) {
                return res.status(404).json({
                    success: false,
                    message: 'Profissional não encontrado'
                });
            }
        }

        // 🧊 BUSCA NOME DO USUÁRIO (snapshot imutável para auditoria)
        let creatorName = 'Sistema';
        try {
            const userModel = mongoose.model(
                req.user.role === 'admin' ? 'Admin' :
                req.user.role === 'secretary' ? 'Secretary' : 'Doctor'
            );
            const user = await userModel.findById(req.user.id).select('fullName').lean();
            if (user?.fullName) {
                creatorName = user.fullName;
            }
        } catch (err) {
            console.warn('[ExpenseV2] Não foi possível buscar nome do criador:', err.message);
        }

        // 🚀 CRIA DESPESA (sem transaction - otimizado)
        const expense = new Expense({
            description,
            category,
            subcategory,
            amount: Number(amount),
            date,
            relatedDoctor: relatedDoctor || null,
            workPeriod,
            paymentMethod,
            status,
            isRecurring,
            recurrence,
            notes,
            createdBy: new mongoose.Types.ObjectId(req.user.id),
            createdByRole: req.user.role,
            createdByName: creatorName
        });

        await expense.save();

        // 🔄 PARALLEL: Popula dados + Invalida cache + Publica evento
        const [populated] = await Promise.all([
            Expense.findById(expense._id)
                .populate('relatedDoctor', 'fullName specialty'),
            
            // Invalida cache (não bloqueia resposta)
            Promise.resolve().then(() => expenseCache.flushAll()),
            
            // Publica evento (background)
            publishEvent(EventTypes.EXPENSE_CREATED, {
                expenseId: expense._id.toString(),
                amount: Number(amount),
                category,
                status,
                date
            }, { 
                aggregateType: 'expense', 
                aggregateId: expense._id.toString(),
                metadata: { source: 'expense_v2_api' }
            }).catch(err => console.error('[ExpenseV2] Evento falhou (não-fatal):', err.message))
        ]);

        console.log(`[ExpenseV2] Criada: ${expense._id} | R$${amount} | ${category}`);

        res.status(201).json({
            success: true,
            message: 'Despesa registrada com sucesso 💚',
            data: populated
        });

    } catch (error) {
        console.error('[ExpenseV2] Erro ao criar despesa:', error);
        
        // 🛡️ Trata erro de duplicidade (idempotência)
        if (error.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'Despesa duplicada detectada',
                error: 'DUPLICATE_EXPENSE'
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Erro ao registrar despesa',
            error: error.message
        });
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
            .populate('relatedDoctor', 'fullName specialty');

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
