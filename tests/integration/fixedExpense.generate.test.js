/**
 * Integração — generateForMonth (despesas fixas) com MongoDB em memória.
 *
 * Cobre: idempotência (2ª geração = 0 novas), cancelar+regenerar não recria,
 * dia 31 em setembro, vigência (início/fim), modelo inativo, corrida de gerações
 * concorrentes (índice único parcial + tratamento de E11000) e eventos publicados.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Efeitos externos (Redis/Outbox) fora do escopo: mock do publisher e da invalidação de cache.
vi.mock('../../infrastructure/events/eventPublisher.js', () => ({
    publishEvent: vi.fn().mockResolvedValue({ eventId: 'evt' }),
    EventTypes: {
        EXPENSE_CREATED: 'EXPENSE_CREATED',
        EXPENSE_UPDATED: 'EXPENSE_UPDATED',
        EXPENSE_CANCELED: 'EXPENSE_CANCELED',
        TOTALS_RECALCULATE_REQUESTED: 'TOTALS_RECALCULATE_REQUESTED'
    }
}));
vi.mock('../../routes/expenses.v2.js', () => ({
    invalidateExpenseCache: vi.fn().mockResolvedValue(undefined)
}));

let mongoServer;
let Expense, FixedExpense, generateForMonth, publishEvent, invalidateExpenseCache;
const actor = { id: new mongoose.Types.ObjectId().toString(), role: 'admin' };

const baseModel = (over = {}) => ({
    description: 'Aluguel',
    category: 'operational',
    amount: 3000,
    dueDay: 10,
    paymentMethod: 'boleto',
    startDate: '2026-01-01',
    active: true,
    createdBy: new mongoose.Types.ObjectId(),
    createdByRole: 'admin',
    ...over
});

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Expense = (await import('../../models/Expense.js')).default;
    FixedExpense = (await import('../../models/FixedExpense.js')).default;
    ({ generateForMonth } = await import('../../services/fixedExpense.service.js'));
    ({ publishEvent } = await import('../../infrastructure/events/eventPublisher.js'));
    ({ invalidateExpenseCache } = await import('../../routes/expenses.v2.js'));
    await Expense.init();      // garante o índice único parcial
    await FixedExpense.init();
}, 300000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
});

beforeEach(async () => {
    await Expense.deleteMany({});
    await FixedExpense.deleteMany({});
    vi.clearAllMocks();
});

const occurrences = (competenceMonth) => Expense.find({ competenceMonth, fixedExpenseId: { $ne: null } }).lean();

describe('generateForMonth', () => {
    it('gera a ocorrência pendente com vencimento, origem e recorrência', async () => {
        const m = await FixedExpense.create(baseModel());
        const res = await generateForMonth({ year: 2026, month: 10 }, actor);

        expect(res.created).toHaveLength(1);
        expect(res.errors).toHaveLength(0);
        const [e] = await occurrences('2026-10');
        expect(e).toMatchObject({
            description: 'Aluguel', amount: 3000, status: 'pending', date: '2026-10-10',
            competenceMonth: '2026-10', isRecurring: true
        });
        expect(String(e.fixedExpenseId)).toBe(String(m._id));
    });

    it('gerar 2x: a segunda não cria nada', async () => {
        await FixedExpense.create(baseModel());
        await FixedExpense.create(baseModel({ description: 'Internet', amount: 200, dueDay: 5 }));

        const first = await generateForMonth({ year: 2026, month: 10 }, actor);
        const second = await generateForMonth({ year: 2026, month: 10 }, actor);

        expect(first.created).toHaveLength(2);
        expect(second.created).toHaveLength(0);
        expect(second.errors).toHaveLength(0);
        expect(await occurrences('2026-10')).toHaveLength(2);
    });

    it('cancelar e regenerar não recria (o doc cancelado permanece)', async () => {
        await FixedExpense.create(baseModel());
        await generateForMonth({ year: 2026, month: 10 }, actor);

        await Expense.updateOne({ competenceMonth: '2026-10' }, { status: 'canceled' });
        const again = await generateForMonth({ year: 2026, month: 10 }, actor);

        expect(again.created).toHaveLength(0);
        const docs = await occurrences('2026-10');
        expect(docs).toHaveLength(1);
        expect(docs[0].status).toBe('canceled');
    });

    it('dia 31 em setembro vira 30/09', async () => {
        await FixedExpense.create(baseModel({ description: 'Contador', dueDay: 31 }));
        await generateForMonth({ year: 2026, month: 9 }, actor);
        const [e] = await occurrences('2026-09');
        expect(e.date).toBe('2026-09-30');
    });

    it('modelo fora da vigência não gera (antes do início e depois do fim)', async () => {
        await FixedExpense.create(baseModel({ description: 'Começa em novembro', startDate: '2026-11-01' }));
        await FixedExpense.create(baseModel({ description: 'Acabou em setembro', startDate: '2026-01-01', endDate: '2026-09-30' }));

        const res = await generateForMonth({ year: 2026, month: 10 }, actor);

        expect(res.created).toHaveLength(0);
        expect(await occurrences('2026-10')).toHaveLength(0);
    });

    it('modelo inativo não gera', async () => {
        await FixedExpense.create(baseModel({ active: false }));
        const res = await generateForMonth({ year: 2026, month: 10 }, actor);
        expect(res.created).toHaveLength(0);
        expect(await occurrences('2026-10')).toHaveLength(0);
    });

    it('duas gerações concorrentes: 1 ocorrência por modelo, sem erro (E11000 vira "já existe")', async () => {
        await FixedExpense.create(baseModel());
        await FixedExpense.create(baseModel({ description: 'Internet', amount: 200, dueDay: 5 }));

        const [a, b] = await Promise.all([
            generateForMonth({ year: 2026, month: 10 }, actor),
            generateForMonth({ year: 2026, month: 10 }, actor)
        ]);

        expect(await occurrences('2026-10')).toHaveLength(2);
        expect(a.errors).toHaveLength(0);
        expect(b.errors).toHaveLength(0);
        expect(a.created.length + b.created.length).toBe(2);
    });

    it('publica 1 recálculo de totais + 1 EXPENSE_CREATED por criada, e invalida o cache', async () => {
        await FixedExpense.create(baseModel());
        await FixedExpense.create(baseModel({ description: 'Internet', amount: 200, dueDay: 5 }));
        await generateForMonth({ year: 2026, month: 10 }, actor);

        const types = publishEvent.mock.calls.map(c => c[0]);
        expect(types.filter(t => t === 'TOTALS_RECALCULATE_REQUESTED')).toHaveLength(1);
        expect(types.filter(t => t === 'EXPENSE_CREATED')).toHaveLength(2);
        expect(invalidateExpenseCache).toHaveBeenCalled();
    });

    it('sem nada a gerar não dispara recálculo de totais', async () => {
        await FixedExpense.create(baseModel());
        await generateForMonth({ year: 2026, month: 10 }, actor);
        vi.clearAllMocks();

        await generateForMonth({ year: 2026, month: 10 }, actor);
        expect(publishEvent).not.toHaveBeenCalled();
    });
});

describe('índice único parcial de Expense', () => {
    it('rejeita o mesmo modelo+mês duas vezes', async () => {
        const m = await FixedExpense.create(baseModel());
        const doc = () => ({
            description: 'x', category: 'operational', amount: 1, date: '2026-10-10', paymentMethod: 'pix',
            fixedExpenseId: m._id, competenceMonth: '2026-10',
            createdBy: new mongoose.Types.ObjectId(), createdByRole: 'admin'
        });
        await Expense.collection.insertOne(doc());
        await expect(Expense.collection.insertOne(doc())).rejects.toMatchObject({ code: 11000 });
    });

    it('não restringe despesas avulsas (sem fixedExpenseId)', async () => {
        const doc = () => ({
            description: 'avulsa', category: 'other', amount: 1, date: '2026-10-10', paymentMethod: 'pix',
            createdBy: new mongoose.Types.ObjectId(), createdByRole: 'admin'
        });
        await Expense.collection.insertOne(doc());
        await expect(Expense.collection.insertOne(doc())).resolves.toBeTruthy();
    });
});
