/**
 * Integração — ensureFixedExpensesForCurrentMonth (cron de despesas fixas), Mongo em memória.
 * Redis/Outbox/Alertas mockados: aqui se prova a lógica do job, não a infraestrutura.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../infrastructure/events/eventPublisher.js', () => ({
    publishEvent: vi.fn().mockResolvedValue({ eventId: 'evt' }),
    EventTypes: {
        EXPENSE_CREATED: 'EXPENSE_CREATED',
        EXPENSE_UPDATED: 'EXPENSE_UPDATED',
        EXPENSE_CANCELED: 'EXPENSE_CANCELED',
        TOTALS_RECALCULATE_REQUESTED: 'TOTALS_RECALCULATE_REQUESTED'
    }
}));
vi.mock('../../routes/expenses.v2.js', () => ({ invalidateExpenseCache: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../utils/redisLock.js', () => ({
    acquireLock: vi.fn(),
    releaseLock: vi.fn()
}));
vi.mock('../../infrastructure/alerts/alertService.js', () => ({ sendAlert: vi.fn().mockResolvedValue({ sent: true }) }));
vi.mock('../../utils/logMetric.js', () => ({ logMetric: vi.fn() }));

let mongoServer;
let Expense, FixedExpense, ensure, acquireLock, releaseLock, sendAlert, generateModule;

const baseModel = (over = {}) => ({
    description: 'Aluguel', category: 'operational', amount: 3000, dueDay: 10,
    paymentMethod: 'boleto', startDate: '2026-01-01', active: true,
    createdBy: new mongoose.Types.ObjectId(), createdByRole: 'admin', ...over
});
// 15/10/2026 12:00 BRT
const OCT = new Date('2026-10-15T15:00:00Z');
const occ = (cm) => Expense.find({ competenceMonth: cm, fixedExpenseId: { $ne: null } }).lean();

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Expense = (await import('../../models/Expense.js')).default;
    FixedExpense = (await import('../../models/FixedExpense.js')).default;
    ({ ensureFixedExpensesForCurrentMonth: ensure } = await import('../../crons/fixedExpenseGeneration.cron.js'));
    generateModule = await import('../../services/fixedExpense.service.js');
    ({ acquireLock, releaseLock } = await import('../../utils/redisLock.js'));
    ({ sendAlert } = await import('../../infrastructure/alerts/alertService.js'));
    await Expense.init();
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
    acquireLock.mockResolvedValue('token-1'); // lock livre por padrão
    releaseLock.mockResolvedValue(true);
});

describe('ensureFixedExpensesForCurrentMonth', () => {
    it('gera o mês corrente como pendente, com ator "system"; segunda execução cria 0', async () => {
        await FixedExpense.create(baseModel());

        const first = await ensure({ now: OCT });
        const second = await ensure({ now: OCT });

        expect(first.status).toBe('generated');
        expect(first.created).toHaveLength(1);
        expect(second.status).toBe('nothing');
        expect(second.created).toHaveLength(0);

        const [e] = await occ('2026-10');
        expect(e).toMatchObject({ status: 'pending', date: '2026-10-10', createdByRole: 'system', createdByName: 'Sistema' });
        expect(String(e.createdBy)).toBe('000000000000000000000000');
    });

    it('modelo cadastrado depois é completado na próxima execução', async () => {
        await FixedExpense.create(baseModel());
        await ensure({ now: OCT });

        await FixedExpense.create(baseModel({ description: 'Água', amount: 247, dueDay: 13 }));
        const next = await ensure({ now: OCT });

        expect(next.created.map(c => c.description)).toEqual(['Água']);
        expect(await occ('2026-10')).toHaveLength(2);
    });

    it('nunca gera meses passados nem futuros', async () => {
        await FixedExpense.create(baseModel());
        await ensure({ now: OCT });
        expect(await occ('2026-09')).toHaveLength(0);
        expect(await occ('2026-11')).toHaveLength(0);
    });

    it('ocorrência cancelada não é recriada', async () => {
        await FixedExpense.create(baseModel());
        await ensure({ now: OCT });
        await Expense.updateOne({ competenceMonth: '2026-10' }, { status: 'canceled' });

        const again = await ensure({ now: OCT });

        expect(again.created).toHaveLength(0);
        const docs = await occ('2026-10');
        expect(docs).toHaveLength(1);
        expect(docs[0].status).toBe('canceled');
    });

    it('fuso: 30/09 23:30 BRT (= 01/10 02:30 UTC) conta como SETEMBRO', async () => {
        await FixedExpense.create(baseModel({ dueDay: 31 })); // 31 em setembro → 30/09
        const res = await ensure({ now: new Date('2026-10-01T02:30:00Z') });

        expect(res.competenceMonth).toBe('2026-09');
        expect((await occ('2026-09'))[0].date).toBe('2026-09-30');
        expect(await occ('2026-10')).toHaveLength(0);
    });

    it('lock ocupado: não gera e não alerta', async () => {
        await FixedExpense.create(baseModel());
        acquireLock.mockResolvedValue(null);

        const res = await ensure({ now: OCT });

        expect(res.status).toBe('locked');
        expect(await occ('2026-10')).toHaveLength(0);
        expect(sendAlert).not.toHaveBeenCalled();
    });

    it('Redis indisponível: gera mesmo assim (idempotente) e não tenta liberar lock', async () => {
        await FixedExpense.create(baseModel());
        acquireLock.mockRejectedValue(new Error('ECONNREFUSED'));

        const res = await ensure({ now: OCT });

        expect(res.status).toBe('generated');
        expect(await occ('2026-10')).toHaveLength(1);
        expect(releaseLock).not.toHaveBeenCalled();
    });

    it('libera o lock ao terminar', async () => {
        await FixedExpense.create(baseModel());
        await ensure({ now: OCT });
        expect(releaseLock).toHaveBeenCalledWith('fixed-expense-generate:2026-10', 'token-1');
    });

    it('sucesso não dispara alerta', async () => {
        await FixedExpense.create(baseModel());
        await ensure({ now: OCT });
        expect(sendAlert).not.toHaveBeenCalled();
    });

    it('exceção na geração → alerta crítico, status error, lock liberado', async () => {
        await FixedExpense.create(baseModel());
        const spy = vi.spyOn(FixedExpense, 'find').mockImplementationOnce(() => { throw new Error('mongo caiu'); });

        const res = await ensure({ now: OCT });
        spy.mockRestore();

        expect(res.status).toBe('error');
        expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({
            level: 'critical', type: 'fixed_expense_generation_failed'
        }));
        expect(releaseLock).toHaveBeenCalled();
    });

    it('item com erro de validação → alerta crítico com o item, sem derrubar os demais', async () => {
        await FixedExpense.create(baseModel());
        // Modelo com categoria inválida inserida direto (fora da validação do mongoose) → falha só ele
        await FixedExpense.collection.insertOne({
            ...baseModel({ description: 'Quebrada' }), category: 'categoria_inexistente', createdAt: new Date(), updatedAt: new Date()
        });

        const res = await ensure({ now: OCT });

        expect(res.status).toBe('error');
        expect(res.created).toHaveLength(1);
        expect(res.errors).toHaveLength(1);
        expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'fixed_expense_generation_failed' }));
        expect(await occ('2026-10')).toHaveLength(1);
    });
});

describe('SYSTEM_ACTOR', () => {
    it('usa o mesmo ObjectId zero do commissionService', () => {
        expect(generateModule.SYSTEM_ACTOR).toEqual({ id: '000000000000000000000000', role: 'system' });
    });
});
