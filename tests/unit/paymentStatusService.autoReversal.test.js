/**
 * 🔄 transitionPaymentStatus() — reversão automática de ledger ao sair de 'paid'
 *
 * Contexto (2026-08-26): investigando o alarme `ledger-exceeds-payments` do
 * reconciliationWorker, achamos 2 Payments reais com R$320 de crédito
 * `payment_received` fantasma no FinancialLedger — o `status` tinha sido
 * revertido de 'paid' pra 'pending' via `PATCH /api/v2/payments/:id`
 * (endpoint genérico, usa este serviço) sem nenhuma reversão do ledger. Um
 * fluxo mais específico (`/register-debit`) já fazia essa reversão
 * corretamente — o gap era o caminho genérico não saber disso.
 *
 * Fix rejeitado (2026-08-26, revisão): a primeira versão usava
 * `correlationId: auto_reversal_..._${Date.now()}` — não determinístico, não
 * protegia contra reversão dupla concorrente do MESMO crédito, e não
 * registrava qual crédito específico estava sendo compensado (bloquearia
 * ciclos novos depois de pagar→reverter→pagar de novo). Redesenho:
 * `reversalOfEntryId` (FinancialLedger._id do crédito exato) + índice único
 * parcial em `models/FinancialLedger.js` — a idempotência é do banco, não de
 * uma leitura prévia.
 *
 * FinancialLedger é imutável por design (docs/DELETE_CASCADE_CONTRACT.md) —
 * a correção nunca apaga o crédito original, sempre lança um débito de
 * reversão que o compensa, vinculado explicitamente a ele.
 *
 * Usa MongoMemoryReplSet (não MongoMemoryServer): transitionPaymentStatus
 * agora abre sua própria transação quando precisa reverter e o chamador não
 * deu uma — transação multi-documento exige replica set.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Payment from '../../models/Payment.js';
import FinancialLedger from '../../models/FinancialLedger.js';
import { transitionPaymentStatus } from '../../services/paymentStatusService.js';
import { recordPaymentReceived } from '../../services/financialLedgerService.js';

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongod.getUri());
    await FinancialLedger.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await Payment.deleteMany({});
    await FinancialLedger.collection.deleteMany({});
    vi.restoreAllMocks();
});

function basePaymentFields(overrides = {}) {
    return {
        patient: new mongoose.Types.ObjectId(),
        amount: 160,
        paymentDate: new Date('2026-08-21T18:00:00Z'),
        paymentMethod: 'pix',
        billingType: 'particular',
        status: 'paid',
        paidAt: new Date('2026-08-21T18:00:00Z'),
        financialDate: new Date('2026-08-21T18:00:00Z'),
        kind: 'session_payment',
        ...overrides,
    };
}

async function netCredit(paymentId) {
    const entries = await FinancialLedger.find({ payment: paymentId, type: { $in: ['payment_received', 'reversal'] } }).lean();
    return entries.reduce((sum, e) => sum + (e.direction === 'credit' ? e.amount : -e.amount), 0);
}

describe('[cenário 3] paid -> pending: Payment e reversão do ledger mudam atomicamente', () => {
    it('lança um débito reversal vinculado ao crédito exato quando um Payment vai de paid -> pending', async () => {
        const payment = await Payment.create(basePaymentFields());
        const credit = await recordPaymentReceived(payment, { correlationId: `create_sync_${payment._id}_1` });

        await transitionPaymentStatus(payment._id.toString(), 'pending', { silent: true, reason: 'admin_manual_patch' });

        const entries = await FinancialLedger.find({ payment: payment._id }).lean();
        const reversal = entries.find(e => e.type === 'reversal');
        expect(reversal).toBeTruthy();
        expect(reversal.direction).toBe('debit');
        expect(reversal.amount).toBe(160);
        expect(reversal.reversalOfEntryId.toString()).toBe(credit._id.toString());

        const reloaded = await Payment.findById(payment._id).lean();
        expect(reloaded.status).toBe('pending');
        expect(await netCredit(payment._id)).toBe(0);
    });

    it('é idempotente — chamar de novo não duplica a reversão', async () => {
        const payment = await Payment.create(basePaymentFields());
        await recordPaymentReceived(payment, { correlationId: `create_sync_${payment._id}_1` });

        await transitionPaymentStatus(payment._id.toString(), 'pending', { silent: true, reason: 'admin_manual_patch' });
        await transitionPaymentStatus(payment._id.toString(), 'canceled', { silent: true, reason: 'admin_manual_patch' });

        const reversals = await FinancialLedger.find({ payment: payment._id, type: 'reversal' }).lean();
        expect(reversals).toHaveLength(1);
    });

    it('NÃO regressão: Payment sem nenhum payment_received não gera reversão ao mudar de paid pra outro status', async () => {
        const payment = await Payment.create(basePaymentFields());

        await transitionPaymentStatus(payment._id.toString(), 'canceled', { silent: true, reason: 'admin_manual_patch' });

        const entries = await FinancialLedger.find({ payment: payment._id }).lean();
        expect(entries).toHaveLength(0);
    });

    it('NÃO regressão: mudar de pending -> paid (o caminho normal) continua sem gerar reversão', async () => {
        const payment = await Payment.create(basePaymentFields({ status: 'pending', paidAt: null, financialDate: null }));

        await transitionPaymentStatus(payment._id.toString(), 'paid', { silent: true, paidAt: new Date('2026-08-22') });

        const reversals = await FinancialLedger.find({ payment: payment._id, type: 'reversal' }).lean();
        expect(reversals).toHaveLength(0);
    });
});

describe('[cenário 4] paid -> pending -> paid: crédito, reversão e novo crédito legítimo', () => {
    it('produz exatamente crédito + reversão + novo crédito, com saldo líquido de UM recebimento', async () => {
        const payment = await Payment.create(basePaymentFields());
        await recordPaymentReceived(payment, { correlationId: `create_sync_${payment._id}_1` });

        // Ciclo 1: paid -> pending (reverte o primeiro crédito)
        await transitionPaymentStatus(payment._id.toString(), 'pending', { silent: true, reason: 'admin_manual_patch' });

        // Ciclo 2: pending -> paid de novo (paciente realmente pagou desta vez)
        await transitionPaymentStatus(payment._id.toString(), 'paid', { silent: true, paidAt: new Date('2026-08-23') });
        const reloadedForCredit = await Payment.findById(payment._id).lean();
        const secondCredit = await recordPaymentReceived(reloadedForCredit, { correlationId: `create_sync_${payment._id}_2` });

        const entries = await FinancialLedger.find({ payment: payment._id }).sort({ createdAt: 1 }).lean();
        expect(entries.map(e => e.type)).toEqual(['payment_received', 'reversal', 'payment_received']);

        // A reversão aponta pro PRIMEIRO crédito, não pro segundo.
        const [firstCredit, reversal, thirdEntry] = entries;
        expect(reversal.reversalOfEntryId.toString()).toBe(firstCredit._id.toString());
        expect(thirdEntry._id.toString()).toBe(secondCredit._id.toString());

        // Saldo líquido = exatamente um recebimento (160), não zero nem 320.
        expect(await netCredit(payment._id)).toBe(160);
    });
});

describe('[cenário 5] dois ou mais ciclos de pagamento/reversão', () => {
    it('cada reversão aponta pro crédito específico; nunca reutiliza reversão antiga; nunca bloqueia um novo recebimento legítimo', async () => {
        const payment = await Payment.create(basePaymentFields());

        // 3 ciclos completos: pagar -> reverter, três vezes.
        const credits = [];
        for (let cycle = 0; cycle < 3; cycle++) {
            const current = await Payment.findById(payment._id).lean();
            const credit = await recordPaymentReceived(current, { correlationId: `cycle_${cycle}_${payment._id}` });
            credits.push(credit);
            await transitionPaymentStatus(payment._id.toString(), 'pending', { silent: true, reason: `cycle_${cycle}_reversal` });
            await transitionPaymentStatus(payment._id.toString(), 'paid', { silent: true, paidAt: new Date(2026, 7, 21 + cycle) });
        }
        // Último ciclo: paga e credita, mas NÃO reverte — fica como recebimento ativo.
        const finalPaymentState = await Payment.findById(payment._id).lean();
        const finalCredit = await recordPaymentReceived(finalPaymentState, { correlationId: `cycle_final_${payment._id}` });

        const allCredits = await FinancialLedger.find({ payment: payment._id, type: 'payment_received' }).sort({ createdAt: 1 }).lean();
        const allReversals = await FinancialLedger.find({ payment: payment._id, type: 'reversal' }).lean();

        expect(allCredits).toHaveLength(4); // 3 ciclos revertidos + 1 ativo
        expect(allReversals).toHaveLength(3);

        // Cada reversão referencia um crédito DIFERENTE — nenhuma reversão
        // reaproveitada, nenhum crédito revertido duas vezes.
        const reversedCreditIds = allReversals.map(r => r.reversalOfEntryId.toString());
        expect(new Set(reversedCreditIds).size).toBe(3);
        for (const credit of credits) {
            expect(reversedCreditIds).toContain(credit._id.toString());
        }
        // O crédito final (nunca revertido) não está entre os compensados.
        expect(reversedCreditIds).not.toContain(finalCredit._id.toString());

        // Saldo líquido = exatamente o último recebimento ativo.
        expect(await netCredit(payment._id)).toBe(160);
    });
});

describe('[cenário 6] falha simulada ao gravar a reversão — atomicidade Payment+Ledger', () => {
    it('se a escrita da reversão falhar, o Payment NÃO fica pending com o crédito antigo ainda ativo (rollback completo)', async () => {
        const payment = await Payment.create(basePaymentFields());
        await recordPaymentReceived(payment, { correlationId: `create_sync_${payment._id}_1` });

        const debitSpy = vi.spyOn(FinancialLedger, 'debit').mockRejectedValueOnce(new Error('falha simulada de rede/disco'));

        await expect(
            transitionPaymentStatus(payment._id.toString(), 'pending', { silent: true, reason: 'admin_manual_patch' })
        ).rejects.toThrow('falha simulada de rede/disco');

        debitSpy.mockRestore();

        // Payment.status e a reversão precisam estar na MESMA transação: como
        // a reversão falhou, o Payment tem que continuar 'paid' — nunca
        // 'pending' com o crédito original intacto (dinheiro fantasma).
        const reloaded = await Payment.findById(payment._id).lean();
        expect(reloaded.status).toBe('paid');

        const reversals = await FinancialLedger.find({ payment: payment._id, type: 'reversal' }).lean();
        expect(reversals).toHaveLength(0);
        expect(await netCredit(payment._id)).toBe(160);
    });
});
