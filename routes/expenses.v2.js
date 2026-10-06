// routes/expenses.v2.js - API V2 para Despesas (Otimizada com cache)
import express from 'express';
import moment from 'moment-timezone';
import { auth, authorize } from '../middleware/auth.js';
import Expense from '../models/Expense.js';
import Doctor from '../models/Doctor.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { safeRedis } from '../config/redisConnection.js';
import mongoose from 'mongoose';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = express.Router();

// Cache V2 (TTL: 2 minutos) — Redis compartilhado, não em memória do processo.
// Um NodeCache local funciona sozinho, mas a produção roda mais de uma
// instância do backend: cada uma teria seu próprio cache isolado, e invalidar
// numa instância (ex: worker de comissão) não afeta as outras — quem cair
// numa instância diferente via load balancer via dado desatualizado por até
// stdTTL, mesmo depois de outra máquina já ver o dado novo (achado 2026-09-01).
// A "invalidação" usa um contador de versão em vez de flush por padrão de
// chave, porque o wrapper safeRedis não expõe SCAN/KEYS.
const CACHE_TTL_SECONDS = 120;
const CACHE_VERSION_KEY = 'expenses_v2:cache_version';

async function getCacheVersion() {
    const raw = await safeRedis.get(CACHE_VERSION_KEY);
    return raw ? Number(raw) || 0 : 0;
}

export async function invalidateExpenseCache() {
    const current = await getCacheVersion();
    await safeRedis.set(CACHE_VERSION_KEY, String(current + 1));
}

/**
 * Gera chave de cache baseada nos filtros
 */
function generateCacheKey(filters, version) {
    const { month, year, doctorId, category, status, origin, page, limit } = filters;
    return `expenses_v2:${version}:${month}_${year}_${doctorId || 'all'}_${category || 'all'}_${status || 'all'}_${origin || 'all'}_${page}_${limit}`;
}

// Origem da despesa: 'fixed' (ocorrência de despesa fixa), 'commission' ou 'manual' (avulsa).
const ORIGIN_CONDITIONS = {
    fixed: { fixedExpenseId: { $ne: null } },
    commission: { fixedExpenseId: null, category: 'commission' },
    manual: { fixedExpenseId: null, category: { $ne: 'commission' } }
};

// Ordem de listagem determinística: sem critério de desempate, a ordem de
// despesas do mesmo dia dependia da ordem em que o banco devolvia os médicos na
// geração de comissões (aparentava aleatória). Collation pt strength 1 ignora
// acento e caixa ("Álvaro" ordena junto de "Alvaro").
export const EXPENSE_LIST_COLLATION = { collation: { locale: 'pt', strength: 1 } };

/**
 * Pipeline da listagem: mais recente primeiro; no mesmo dia, profissional em
 * ordem alfabética (despesas sem profissional vêm depois, por descrição);
 * createdAt e _id fecham o desempate. Ordena ANTES do skip/limit para a
 * paginação ser estável. Devolve `relatedDoctor` no mesmo formato do populate
 * anterior ({ _id, fullName, specialty } ou null).
 *
 * `$match` de aggregate não faz cast de string → ObjectId (find fazia), então
 * `relatedDoctor` é convertido aqui.
 */
export function buildExpenseListPipeline({ filters, skip, limit }) {
    const match = { ...filters };
    if (typeof match.relatedDoctor === 'string' && mongoose.isValidObjectId(match.relatedDoctor)) {
        match.relatedDoctor = new mongoose.Types.ObjectId(match.relatedDoctor);
    }

    return [
        { $match: match },
        {
            $lookup: {
                from: Doctor.collection.collectionName,
                localField: 'relatedDoctor',
                foreignField: '_id',
                pipeline: [{ $project: { fullName: 1, specialty: 1 } }],
                as: '_doctor'
            }
        },
        {
            $addFields: {
                relatedDoctor: { $ifNull: [{ $arrayElemAt: ['$_doctor', 0] }, null] },
                _noDoctor: { $cond: [{ $gt: [{ $size: '$_doctor' }, 0] }, 0, 1] },
                _sortName: {
                    $ifNull: [{ $arrayElemAt: ['$_doctor.fullName', 0] }, { $ifNull: ['$description', ''] }]
                }
            }
        },
        { $sort: { date: -1, _noDoctor: 1, _sortName: 1, createdAt: -1, _id: 1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: { _doctor: 0, _noDoctor: 0, _sortName: 0 } }
    ];
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
            origin,
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

        // Totais por origem ignoram o filtro `origin` (os cards mostram o quadro completo
        // mesmo com uma origem selecionada), mas respeitam os demais filtros.
        const baseFilters = { ...filters };
        if (origin && ORIGIN_CONDITIONS[origin]) {
            // $and: não colide com `category` já usado no filtro.
            filters.$and = [ORIGIN_CONDITIONS[origin]];
        }

        const cacheVersion = await getCacheVersion();
        const cacheKey = generateCacheKey({ month, year, doctorId, category, status, origin, page, limit }, cacheVersion);

        // Verifica cache (se não forçar refresh)
        if (!nocache) {
            const cachedRaw = await safeRedis.get(cacheKey);
            if (cachedRaw) {
                console.log('[ExpenseV2] Cache hit:', cacheKey);
                return res.json({
                    success: true,
                    ...JSON.parse(cachedRaw),
                    cached: true
                });
            }
        }

        const skip = (page - 1) * limit;

        const [expenses, total] = await Promise.all([
            Expense.aggregate(
                buildExpenseListPipeline({ filters, skip, limit: Number(limit) }),
                EXPENSE_LIST_COLLATION
            ),

            Expense.countDocuments(filters)
        ]);

        // Totais (pago/pendente) + quebra por origem (fixa/comissão/avulsa)
        const [totals, originRows] = await Promise.all([
            Expense.aggregate([
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
            ]),
            Expense.aggregate([
                { $match: { ...baseFilters, status: baseFilters.status || { $in: ['paid', 'pending', 'scheduled'] } } },
                {
                    $group: {
                        _id: {
                            $cond: [
                                { $ne: [{ $ifNull: ['$fixedExpenseId', null] }, null] }, 'fixed',
                                { $cond: [{ $eq: ['$category', 'commission'] }, 'commission', 'manual'] }
                            ]
                        },
                        total: { $sum: '$amount' },
                        count: { $sum: 1 }
                    }
                }
            ])
        ]);

        const byOrigin = { fixed: { total: 0, count: 0 }, commission: { total: 0, count: 0 }, manual: { total: 0, count: 0 } };
        for (const r of originRows) if (byOrigin[r._id]) byOrigin[r._id] = { total: r.total, count: r.count };

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
            },
            byOrigin
        };

        // Salva no cache
        await safeRedis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(result));

        res.json({
            success: true,
            ...result,
            cached: false
        });

    } catch (error) {
        console.error('[ExpenseV2] Erro ao listar despesas:', error);
        sendApiError(res, error, req);
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
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Campos obrigatórios: description, category, amount, date, paymentMethod', {
                status: 400,
              }),
              req
            );
        }

        // 🛡️ VALIDAÇÃO: Usuário autenticado
        if (!req.user?.id || !req.user?.role) {
            return sendApiError(
              res,
              new AppError('UNAUTHORIZED', 'Usuário não autenticado. Token inválido ou expirado.', {
                status: 401,
              }),
              req
            );
        }

        // Se vinculada a profissional, validar existência (sem session)
        if (relatedDoctor) {
            const doctorExists = await Doctor.exists({ _id: relatedDoctor });
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
            invalidateExpenseCache(),
            
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
            return sendApiError(
              res,
              new AppError('CONFLICT', 'Despesa duplicada detectada', {
                status: 409,
                legacyError: 'DUPLICATE_EXPENSE',
              }),
              req
            );
        }
        
        sendApiError(res, error, req);
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
            return sendApiError(res, new AppError('NOT_FOUND', 'Despesa não encontrada', { status: 404 }), req);
        }

        // Invalida cache
        await invalidateExpenseCache();

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
        sendApiError(res, error, req);
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

        // 🗑️ Exclusão real (?permanent=true): só despesa AVULSA ainda pendente.
        // Fixa gerada (fixedExpenseId) e comissão nunca somem — cancelar mantém o doc,
        // senão "Gerar fixas"/"Gerar comissões" recriaria; paga mantém histórico.
        if (req.query.permanent === 'true') {
            const target = await Expense.findById(id).select('status category fixedExpenseId').lean();
            if (!target) {
                return sendApiError(res, new AppError('NOT_FOUND', 'Despesa não encontrada', { status: 404 }), req);
            }
            const isManual = !target.fixedExpenseId && target.category !== 'commission';
            if (!isManual || !['pending', 'scheduled'].includes(target.status)) {
                return sendApiError(
                  res,
                  new AppError('CONFLICT', 'Exclusão definitiva só é permitida para despesas avulsas pendentes. Use cancelar.', {
                    status: 409,
                  }),
                  req
                );
            }
            await Expense.deleteOne({ _id: id, status: { $in: ['pending', 'scheduled'] } });
            await invalidateExpenseCache();
            await publishEvent(EventTypes.EXPENSE_CANCELED, { expenseId: id, deleted: true },
                { aggregateType: 'expense', aggregateId: id })
                .catch(err => console.error('[ExpenseV2] Evento falhou (não-fatal):', err.message));
            return res.json({ success: true, message: 'Despesa excluída' });
        }

        const expense = await Expense.findByIdAndUpdate(
            id,
            { status: 'canceled', updatedAt: new Date() },
            { new: true }
        );

        if (!expense) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Despesa não encontrada', { status: 404 }), req);
        }

        // Invalida cache
        await invalidateExpenseCache();

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
        sendApiError(res, error, req);
    }
});

export default router;
