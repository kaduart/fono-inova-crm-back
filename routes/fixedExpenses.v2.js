// routes/fixedExpenses.v2.js - API V2 de Despesas Fixas (modelos + geração mensal)
import express from 'express';
import mongoose from 'mongoose';
import { auth, authorize } from '../middleware/auth.js';
import FixedExpense from '../models/FixedExpense.js';
import Expense from '../models/Expense.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { invalidateExpenseCache } from './expenses.v2.js';
import { findMissingOccurrences, generateForMonth } from '../services/fixedExpense.service.js';
import { computeDueDate, toCompetenceMonth } from '../utils/fixedExpenseDates.js';

const router = express.Router();
const WRITE_ROLES = ['admin', 'secretary'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Campos do modelo que o cliente pode escrever (nada de createdBy etc.).
const MODEL_FIELDS = ['description', 'category', 'subcategory', 'amount', 'dueDay', 'paymentMethod', 'startDate', 'endDate', 'active', 'notes'];

function pickModelFields(body) {
    const out = {};
    for (const k of MODEL_FIELDS) if (body[k] !== undefined) out[k] = body[k];
    if (out.subcategory === '') out.subcategory = null;
    if (out.endDate === '') out.endDate = null;
    return out;
}

function validateModelFields(f, { partial }) {
    const required = ['description', 'category', 'amount', 'dueDay', 'paymentMethod', 'startDate'];
    if (!partial) {
        const missing = required.filter(k => f[k] === undefined || f[k] === null || f[k] === '');
        if (missing.length) return `Campos obrigatórios: ${missing.join(', ')}`;
    }
    if (f.category === 'commission') return 'Comissão não pode ser despesa fixa (use Gerar Comissões)';
    if (f.dueDay !== undefined && (!Number.isInteger(Number(f.dueDay)) || f.dueDay < 1 || f.dueDay > 31)) return 'dueDay deve ser um inteiro entre 1 e 31';
    if (f.startDate !== undefined && !DATE_RE.test(f.startDate)) return 'startDate inválida (YYYY-MM-DD)';
    if (f.endDate && !DATE_RE.test(f.endDate)) return 'endDate inválida (YYYY-MM-DD)';
    if (f.startDate && f.endDate && f.endDate < f.startDate) return 'endDate não pode ser anterior a startDate';
    return null;
}

function parsePeriod(src) {
    const year = Number(src.year);
    const month = Number(src.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2100) return null;
    return { year, month };
}

const requireUser = (req, res) => {
    if (!req.user?.id || !req.user?.role) {
        res.status(401).json({ success: false, message: 'Usuário não autenticado.' });
        return false;
    }
    return true;
};

// ─── LISTAR MODELOS ─────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
    try {
        const filter = {};
        if (req.query.active === 'true') filter.active = true;
        if (req.query.active === 'false') filter.active = false;

        const models = await FixedExpense.find(filter).sort({ active: -1, dueDay: 1, description: 1 }).lean();

        // Nº de ocorrências por modelo (a UI decide entre "excluir" e "desativar").
        const counts = models.length
            ? await Expense.aggregate([
                { $match: { fixedExpenseId: { $in: models.map(m => m._id) } } },
                { $group: { _id: '$fixedExpenseId', n: { $sum: 1 } } }
            ])
            : [];
        const byId = new Map(counts.map(c => [String(c._id), c.n]));

        res.json({
            success: true,
            data: models.map(m => ({ ...m, occurrences: byId.get(String(m._id)) || 0 }))
        });
    } catch (error) {
        console.error('[FixedExpenseV2] Erro ao listar:', error);
        res.status(500).json({ success: false, message: 'Erro ao listar despesas fixas', error: error.message });
    }
});

// ─── AVISO: modelos ativos sem ocorrência no mês ────────────────────────────
router.get('/pending-generation', auth, async (req, res) => {
    try {
        const period = parsePeriod(req.query);
        if (!period) return res.status(400).json({ success: false, message: 'year e month são obrigatórios e devem ser válidos' });

        const { competenceMonth, missing } = await findMissingOccurrences(period.year, period.month);
        res.json({
            success: true,
            data: {
                competenceMonth,
                count: missing.length,
                total: missing.reduce((s, m) => s + (m.amount || 0), 0),
                items: missing.map(m => ({
                    _id: m._id,
                    description: m.description,
                    amount: m.amount,
                    dueDate: computeDueDate(competenceMonth, m.dueDay)
                }))
            }
        });
    } catch (error) {
        console.error('[FixedExpenseV2] Erro em pending-generation:', error);
        res.status(500).json({ success: false, message: 'Erro ao verificar despesas fixas pendentes', error: error.message });
    }
});

// ─── GERAR OCORRÊNCIAS DO MÊS (idempotente) ─────────────────────────────────
router.post('/generate', auth, authorize(WRITE_ROLES), async (req, res) => {
    try {
        if (!requireUser(req, res)) return;
        const period = parsePeriod(req.body || {});
        if (!period) return res.status(400).json({ success: false, message: 'year e month são obrigatórios e devem ser válidos' });

        const { competenceMonth, created, skipped, errors } = await generateForMonth(period, req.user);
        res.status(errors.length && !created.length ? 207 : 200).json({
            success: errors.length === 0,
            competenceMonth,
            created,
            skipped,
            errors
        });
    } catch (error) {
        console.error('[FixedExpenseV2] Erro ao gerar:', error);
        res.status(500).json({ success: false, message: 'Erro ao gerar despesas fixas', error: error.message });
    }
});

// ─── CRIAR MODELO ───────────────────────────────────────────────────────────
router.post('/', auth, authorize(WRITE_ROLES), async (req, res) => {
    try {
        if (!requireUser(req, res)) return;
        const fields = pickModelFields(req.body || {});
        const invalid = validateModelFields(fields, { partial: false });
        if (invalid) return res.status(400).json({ success: false, message: invalid });

        const model = await FixedExpense.create({
            ...fields,
            amount: Number(fields.amount),
            dueDay: Number(fields.dueDay),
            createdBy: new mongoose.Types.ObjectId(req.user.id),
            createdByRole: req.user.role,
            createdByName: req.user.fullName || req.user.name || 'Sistema'
        });
        res.status(201).json({ success: true, message: 'Despesa fixa criada', data: model });
    } catch (error) {
        const status = error.name === 'ValidationError' ? 400 : 500;
        console.error('[FixedExpenseV2] Erro ao criar:', error);
        res.status(status).json({ success: false, message: 'Erro ao criar despesa fixa', error: error.message });
    }
});

// ─── EDITAR MODELO ──────────────────────────────────────────────────────────
// Só afeta gerações futuras. Com `applyToOccurrence: { year, month }` aplica também
// à ocorrência PENDENTE daquela competência (paga/cancelada nunca é tocada).
router.patch('/:id', auth, authorize(WRITE_ROLES), async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'ID inválido' });

        const fields = pickModelFields(req.body || {});
        const invalid = validateModelFields(fields, { partial: true });
        if (invalid) return res.status(400).json({ success: false, message: invalid });

        const model = await FixedExpense.findByIdAndUpdate(id, fields, { new: true, runValidators: true });
        if (!model) return res.status(404).json({ success: false, message: 'Despesa fixa não encontrada' });

        let occurrenceUpdated = null;
        const apply = req.body?.applyToOccurrence;
        if (apply) {
            const period = parsePeriod(apply);
            if (!period) return res.status(400).json({ success: false, message: 'applyToOccurrence precisa de year e month válidos' });
            const competenceMonth = toCompetenceMonth(period.year, period.month);

            const occ = await Expense.findOneAndUpdate(
                { fixedExpenseId: model._id, competenceMonth, status: 'pending' },
                {
                    description: model.description,
                    category: model.category,
                    subcategory: model.subcategory || null,
                    amount: model.amount,
                    paymentMethod: model.paymentMethod,
                    notes: model.notes || '',
                    date: computeDueDate(competenceMonth, model.dueDay),
                    updatedAt: new Date()
                },
                { new: true, runValidators: true }
            );
            if (occ) {
                occurrenceUpdated = occ._id;
                await publishEvent(EventTypes.EXPENSE_UPDATED, { expenseId: String(occ._id), updates: { source: 'fixed_expense_model' } },
                    { aggregateType: 'expense', aggregateId: String(occ._id) })
                    .catch(err => console.error('[FixedExpenseV2] EXPENSE_UPDATED falhou (não-fatal):', err.message));
            }
        }
        if (occurrenceUpdated) await invalidateExpenseCache();

        res.json({ success: true, message: 'Despesa fixa atualizada', data: model, occurrenceUpdated });
    } catch (error) {
        const status = error.name === 'ValidationError' ? 400 : 500;
        console.error('[FixedExpenseV2] Erro ao atualizar:', error);
        res.status(status).json({ success: false, message: 'Erro ao atualizar despesa fixa', error: error.message });
    }
});

// ─── EXCLUIR MODELO ─────────────────────────────────────────────────────────
// Já gerou alguma ocorrência (inclusive cancelada) → só desativa (soft).
// Nunca gerou nada → exclusão real.
router.delete('/:id', auth, authorize(WRITE_ROLES), async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'ID inválido' });

        const model = await FixedExpense.findById(id);
        if (!model) return res.status(404).json({ success: false, message: 'Despesa fixa não encontrada' });

        const hasOccurrences = await Expense.exists({ fixedExpenseId: model._id });
        if (hasOccurrences) {
            model.active = false;
            await model.save();
            return res.json({ success: true, softDeleted: true, message: 'Despesa fixa desativada (possui ocorrências geradas)', data: model });
        }

        await model.deleteOne();
        res.json({ success: true, softDeleted: false, message: 'Despesa fixa excluída' });
    } catch (error) {
        console.error('[FixedExpenseV2] Erro ao excluir:', error);
        res.status(500).json({ success: false, message: 'Erro ao excluir despesa fixa', error: error.message });
    }
});

export default router;
