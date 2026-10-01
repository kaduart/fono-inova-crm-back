// services/fixedExpense.service.js
// Geração mensal das ocorrências de despesa fixa. Idempotente e reutilizável
// por rota manual hoje e por job (dia 1º) depois: generateForMonth({ year, month }, actor).
import mongoose from 'mongoose';
import FixedExpense from '../models/FixedExpense.js';
import Expense from '../models/Expense.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { invalidateExpenseCache } from '../routes/expenses.v2.js';
import {
    toCompetenceMonth,
    computeDueDate,
    isEligibleForMonth,
    monthBounds
} from '../utils/fixedExpenseDates.js';

const TAG = '[FixedExpense]';

/** Modelos ativos e elegíveis na competência que ainda NÃO têm ocorrência (nem cancelada). */
export async function findMissingOccurrences(year, month) {
    const competenceMonth = toCompetenceMonth(year, month);
    const models = (await FixedExpense.find({ active: true }).lean())
        .filter(m => isEligibleForMonth(m, competenceMonth));
    if (models.length === 0) return { competenceMonth, missing: [], eligible: 0 };

    const existing = await Expense.find({
        fixedExpenseId: { $in: models.map(m => m._id) },
        competenceMonth
    }).select('fixedExpenseId').lean();
    const have = new Set(existing.map(e => String(e.fixedExpenseId)));

    return {
        competenceMonth,
        eligible: models.length,
        missing: models.filter(m => !have.has(String(m._id)))
    };
}

/**
 * Ator das gerações automáticas (cron). Mesma convenção do commissionService
 * (createdBy = ObjectId zero, createdByRole = 'system').
 */
export const SYSTEM_ACTOR = Object.freeze({ id: '000000000000000000000000', role: 'system' });

async function resolveActor(actor) {
    let createdByName = 'Sistema';
    if (actor.role === 'system') return createdByName; // não há usuário a consultar
    try {
        const modelName = actor.role === 'admin' ? 'Admin' : actor.role === 'secretary' ? 'Secretary' : 'Doctor';
        const user = await mongoose.model(modelName).findById(actor.id).select('fullName').lean();
        if (user?.fullName) createdByName = user.fullName;
    } catch (err) {
        console.warn(`${TAG} não foi possível buscar nome do criador:`, err.message);
    }
    return createdByName;
}

/**
 * Gera as ocorrências do mês. Idempotente: roda N vezes, cria só o que falta.
 * @returns {{ created: object[], skipped: object[], errors: object[] }}
 */
export async function generateForMonth({ year, month }, actor) {
    const { competenceMonth, missing } = await findMissingOccurrences(year, month);
    const created = [];
    const skipped = [];
    const errors = [];

    // Quem já tinha ocorrência (ou está fora de vigência) simplesmente não entra em `missing`.
    console.log(`${TAG} ${competenceMonth}: ${missing.length} modelo(s) a gerar`);

    if (missing.length === 0) {
        return { competenceMonth, created, skipped, errors };
    }

    const createdByName = await resolveActor(actor);
    const createdBy = new mongoose.Types.ObjectId(actor.id);

    // Monta e valida os docs antes (erro de validação vira `errors`, não derruba o lote).
    // Em insertMany os hooks post('save') NÃO disparam — o evento é publicado uma vez no fim.
    const toInsert = [];
    for (const m of missing) {
        const doc = new Expense({
            description: m.description,
            category: m.category,
            subcategory: m.subcategory || undefined,
            amount: m.amount,
            date: computeDueDate(competenceMonth, m.dueDay),
            paymentMethod: m.paymentMethod,
            status: 'pending',
            isRecurring: true,
            recurrence: { frequency: 'monthly' },
            notes: m.notes || '',
            fixedExpenseId: m._id,
            competenceMonth,
            createdBy,
            createdByRole: actor.role,
            createdByName
        });
        const invalid = doc.validateSync();
        if (invalid) {
            errors.push({ fixedExpenseId: String(m._id), description: m.description, reason: invalid.message });
            console.error(`${TAG} ERRO ${competenceMonth} "${m.description}": ${invalid.message}`);
        } else {
            toInsert.push(doc);
        }
    }

    if (toInsert.length > 0) {
        let insertError = null;
        try {
            await Expense.insertMany(toInsert, { ordered: false });
        } catch (err) {
            insertError = err; // ordered:false — parte pode ter entrado; verificamos abaixo
        }

        // Fonte da verdade = o banco (independe de como o driver reporta falha parcial).
        const insertedIds = new Set(
            (await Expense.find({ _id: { $in: toInsert.map(d => d._id) } }).select('_id').lean())
                .map(e => String(e._id))
        );

        for (const doc of toInsert) {
            const base = { fixedExpenseId: String(doc.fixedExpenseId), description: doc.description };
            if (insertedIds.has(String(doc._id))) {
                created.push({ ...base, expenseId: String(doc._id), date: doc.date, amount: doc.amount, category: doc.category });
                console.log(`${TAG} CRIADA ${competenceMonth} "${doc.description}" R$${doc.amount} venc ${doc.date}`);
                continue;
            }
            // Não entrou: E11000 (outra geração concorrente criou) = "já existe"; resto = erro.
            const raceWinner = await Expense.exists({ fixedExpenseId: doc.fixedExpenseId, competenceMonth });
            if (raceWinner) {
                skipped.push({ ...base, reason: 'already_exists' });
                console.log(`${TAG} JÁ EXISTE ${competenceMonth} "${doc.description}" (E11000/concorrência)`);
            } else {
                errors.push({ ...base, reason: insertError?.message || 'falha ao inserir' });
                console.error(`${TAG} ERRO ${competenceMonth} "${doc.description}": ${insertError?.message}`);
            }
        }
    }

    if (created.length > 0) {
        // Projeção de despesa (snapshot) — 1 evento por ocorrência criada, como o POST v2.
        await Promise.all(created.map(c =>
            publishEvent(EventTypes.EXPENSE_CREATED, {
                expenseId: c.expenseId,
                amount: c.amount,
                category: c.category,
                status: 'pending',
                date: c.date
            }, {
                aggregateType: 'expense',
                aggregateId: c.expenseId,
                idempotencyKey: `expense-created:${c.expenseId}`,
                metadata: { source: 'fixed_expense_generate' }
            }).catch(err => console.error(`${TAG} EXPENSE_CREATED falhou (não-fatal):`, err.message))
        ));

        // Recálculo de totais: UM único evento para o lote inteiro.
        await publishEvent(EventTypes.TOTALS_RECALCULATE_REQUESTED, {
            clinicId: null,
            date: monthBounds(competenceMonth).end,
            period: 'month',
            reason: 'fixed_expenses_generated',
            triggeredBy: 'fixed_expense_service'
        }, {
            idempotencyKey: `totals-recalc:fixed-expenses:${competenceMonth}:${Date.now()}`,
            metadata: { source: 'fixed_expense_generate' }
        }).catch(err => console.error(`${TAG} recálculo de totais falhou (não-fatal):`, err.message));
    }

    // Cache Redis das listagens (contador de versão invalida o mês e demais).
    await invalidateExpenseCache().catch(err => console.error(`${TAG} invalidar cache falhou:`, err.message));

    console.log(`${TAG} ${competenceMonth} concluído: created=${created.length} skipped=${skipped.length} errors=${errors.length}`);
    return { competenceMonth, created, skipped, errors };
}
