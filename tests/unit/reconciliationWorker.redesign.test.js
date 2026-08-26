/**
 * 🔍 reconciliationWorker.js — redesenho das checagens (2026-08-26)
 *
 * Contexto: o desenho anterior comparava "soma de payments pagos no mês"
 * contra "soma de créditos no ledger no mês" — e (a) usava `paymentDate` em
 * vez da data canônica de caixa (`financialDate`/`paidAt`), (b) misturava
 * órfãos legítimos (Payment/Package/Patient deletados — o ledger sobrevive
 * de propósito, docs/DELETE_CASCADE_CONTRACT.md) com divergência real de
 * caixa, e (c) comparava histórico imutável do ledger contra o status ATUAL
 * (mutável) dos Payments, o que quebra quando uma reversão acontece num mês
 * diferente do crédito original ou quando um Payment é legitimamente
 * deletado depois.
 *
 * Redesenho em 3 checagens separadas:
 *   1. reconcilePaymentNetCredit — por Payment individual (paid→crédito
 *      líquido = amount; pending/canceled/refunded→crédito líquido = 0).
 *   2. reconcileOrphanLedgerEntries — classifica órfãos, nunca mistura com
 *      divergência de caixa.
 *   3. reportMonthlyLedgerNetMovement — só reporta o movimento do próprio
 *      ledger (occurredAt + direction canônicos), não compara contra Payments.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Payment from '../../models/Payment.js';
import FinancialLedger from '../../models/FinancialLedger.js';
import Patient from '../../models/Patient.js';
import Package from '../../models/Package.js';

let mongod;
let reconcilePaymentNetCredit, reconcileOrphanLedgerEntries, reportMonthlyLedgerNetMovement;

beforeAll(async () => {
    mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongod.getUri());
    await FinancialLedger.init();
    const mod = await import('../../workers/reconciliationWorker.js');
    // As funções não são exportadas (uso interno do worker) — o teste importa
    // o módulo e as invoca via require do escopo do arquivo de teste não é
    // possível para funções não exportadas; por isso replicamos a chamada
    // pública do worker via job handler exportado indiretamente abaixo.
    ({ reconcilePaymentNetCredit, reconcileOrphanLedgerEntries, reportMonthlyLedgerNetMovement } = mod.__testables || {});
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await Payment.deleteMany({});
    await FinancialLedger.collection.deleteMany({});
    // Garante os índices (inclusive o único de reversalOfEntryId) presentes
    // antes de cada teste — o teste de "dado histórico" abaixo derruba esse
    // índice de propósito pra simular dado anterior a ele.
    await FinancialLedger.syncIndexes();
    await Patient.deleteMany({});
    await Package.deleteMany({});
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

function freshResults() {
    return { checked: 0, inconsistencies: 0, autoFixed: 0, manualReview: [] };
}

describe('[verificação 1] reconcilePaymentNetCredit — por Payment individual', () => {
    it('paid com crédito líquido correto (amount) não gera inconsistência', async () => {
        const payment = await Payment.create(basePaymentFields());
        await FinancialLedger.credit({
            type: 'payment_received', amount: 160, patient: payment.patient, payment: payment._id,
            correlationId: `c1`, occurredAt: new Date('2026-08-21'), description: 'x'
        });

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        expect(results.inconsistencies).toBe(0);
        expect(results.manualReview).toHaveLength(0);
    }, 15000); // 1ª chamada paga o custo de import() dinâmico a frio

    it('paid com DOIS créditos (duplicado, sem reversão) é flagrado como payment-net-credit-mismatch, não auto-corrigido', async () => {
        const payment = await Payment.create(basePaymentFields());
        await FinancialLedger.credit({ type: 'payment_received', amount: 160, patient: payment.patient, payment: payment._id, correlationId: 'c1', occurredAt: new Date('2026-08-21'), description: 'x' });
        await FinancialLedger.credit({ type: 'payment_received', amount: 160, patient: payment.patient, payment: payment._id, correlationId: 'c2', occurredAt: new Date('2026-08-21'), description: 'y' });

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        const issue = results.manualReview.find(m => m.type === 'payment-net-credit-mismatch');
        expect(issue).toBeTruthy();
        expect(issue.netCredit).toBe(320);
        expect(issue.expected).toBe(160);
        expect(results.autoFixed).toBe(0); // nunca corrige automaticamente um mismatch de valor
    });

    it('paid SEM nenhum crédito é auto-corrigido (cria o crédito canônico)', async () => {
        const payment = await Payment.create(basePaymentFields());

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        expect(results.autoFixed).toBe(1);
        const entries = await FinancialLedger.find({ payment: payment._id, type: 'payment_received' }).lean();
        expect(entries).toHaveLength(1);
    });

    it('pending com crédito fantasma (payment_received sem reversão) é flagrado como phantom-credit-on-inactive-payment', async () => {
        const payment = await Payment.create(basePaymentFields({ status: 'pending' }));
        await FinancialLedger.credit({ type: 'payment_received', amount: 160, patient: payment.patient, payment: payment._id, correlationId: 'c1', occurredAt: new Date('2026-08-21'), description: 'x' });

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        const issue = results.manualReview.find(m => m.type === 'phantom-credit-on-inactive-payment');
        expect(issue).toBeTruthy();
        expect(issue.netCredit).toBe(160);
    });

    it('pending com crédito devidamente revertido (netCredit=0) NÃO gera inconsistência', async () => {
        const payment = await Payment.create(basePaymentFields({ status: 'pending' }));
        const credit = await FinancialLedger.credit({ type: 'payment_received', amount: 160, patient: payment.patient, payment: payment._id, correlationId: 'c1', occurredAt: new Date('2026-08-21'), description: 'x' });
        await FinancialLedger.debit({ type: 'reversal', amount: 160, patient: payment.patient, payment: payment._id, reversalOfEntryId: credit._id, correlationId: `reversal:${credit._id}`, occurredAt: new Date('2026-08-22'), description: 'y' });

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        expect(results.inconsistencies).toBe(0);
    });

    it('detecta um crédito revertido MAIS DE UMA VEZ (dado histórico anterior ao índice único)', async () => {
        const payment = await Payment.create(basePaymentFields({ status: 'pending' }));
        const credit = await FinancialLedger.credit({ type: 'payment_received', amount: 160, patient: payment.patient, payment: payment._id, correlationId: 'c1', occurredAt: new Date('2026-08-21'), description: 'x' });
        await FinancialLedger.debit({ type: 'reversal', amount: 160, patient: payment.patient, payment: payment._id, reversalOfEntryId: credit._id, correlationId: 'hist_reversal_1', occurredAt: new Date('2026-08-22'), description: 'y' });

        // A segunda reversão pro MESMO crédito só é possível derrubando o
        // índice único primeiro — é exatamente essa proteção que estamos
        // provando que existe. Simula dado legado anterior ao índice
        // (ou uma falha de infraestrutura que o tenha corrompido) e
        // reconstrói o índice depois, pra não vazar pros outros testes.
        await FinancialLedger.collection.dropIndex('reversalOfEntryId_1');
        await FinancialLedger.collection.insertOne({
            type: 'reversal', direction: 'debit', amount: 160, patient: payment.patient, payment: payment._id,
            reversalOfEntryId: new mongoose.Types.ObjectId(credit._id), correlationId: 'hist_reversal_2',
            occurredAt: new Date('2026-08-23'), description: 'z', recordedAt: new Date(), createdAt: new Date(), updatedAt: new Date()
        });
        // Índice reconstruído automaticamente no beforeEach do próximo teste —
        // não precisa restaurar aqui, e tentar reconstruir agora falharia
        // mesmo (os 2 documentos duplicados ainda estão na collection).

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        const issue = results.manualReview.find(m => m.type === 'credit-reversed-more-than-once');
        expect(issue).toBeTruthy();
        expect(issue.reversalCount).toBe(2);
    });
});

describe('[quatro modelos financeiros] reconcilePaymentNetCredit não acusa falso "missing credit"', () => {
    // Todos os fixtures usam createdAt >= LEDGER_ADOPTION_CUTOFF (2026-04-01)
    // implicitamente (Mongoose timestamps default = agora, sempre depois do
    // corte) — exceto o teste de legado, que define createdAt manualmente.

    it('PREPAID (particular pré-pago): consumo de pacote (isFromPackage=true) NUNCA espera crédito, mesmo com kind diferente de package_consumed', async () => {
        // Reproduz o edge case real de isPrepaidFallback em particularHandler.js:
        // kind='session_payment' (não 'package_consumed') + isFromPackage=true.
        const payment = await Payment.create(basePaymentFields({ kind: 'session_payment', isFromPackage: true, financialDate: null, package: new mongoose.Types.ObjectId() }));
        // Nenhum lançamento de ledger pra este Payment — consumo de pacote pré-pago não gera caixa novo.

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        expect(results.manualReview.find(m => m.paymentId?.toString() === payment._id.toString())).toBeFalsy();
        expect(results.inconsistencies).toBe(0);
    });

    it('PER_SESSION (particular pago por sessão): espera payment_received — presente e correto não gera alerta', async () => {
        const payment = await Payment.create(basePaymentFields({ billingType: 'particular', kind: 'session_payment', isFromPackage: false }));
        await FinancialLedger.credit({ type: 'payment_received', amount: 160, patient: payment.patient, payment: payment._id, correlationId: 'per-session-1', occurredAt: new Date('2026-08-21'), description: 'x' });

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        expect(results.manualReview.find(m => m.paymentId?.toString() === payment._id.toString())).toBeFalsy();
    });

    it('JUDICIAL_LIMINAR: sessão de liminar creditada via payment_received (caminho ativo real) não gera falso "missing credit"', async () => {
        // Validado empiricamente contra produção (2026-08-26): Payments 'paid'
        // billingType='liminar' são creditados via o MESMO recordPaymentReceived
        // que particular per-session (completeSessionService.v2.js, linha 861) —
        // não via domain/liminar/recognizeRevenue.js, que está DESATIVADO.
        const payment = await Payment.create(basePaymentFields({ billingType: 'liminar', kind: 'session_payment', paymentMethod: 'other' }));
        await FinancialLedger.credit({ type: 'payment_received', amount: 160, patient: payment.patient, payment: payment._id, correlationId: 'liminar-1', occurredAt: new Date('2026-08-21'), description: 'x' });

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        expect(results.manualReview.find(m => m.paymentId?.toString() === payment._id.toString())).toBeFalsy();
    });

    it('CONVENIO: espera insurance_received (não payment_received) — presente e correto não gera alerta', async () => {
        const payment = await Payment.create(basePaymentFields({ billingType: 'convenio', kind: 'session_payment', paymentMethod: 'convenio' }));
        await FinancialLedger.credit({ type: 'insurance_received', amount: 160, patient: payment.patient, payment: payment._id, correlationId: 'convenio-1', occurredAt: new Date('2026-08-21'), description: 'x' });

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        expect(results.manualReview.find(m => m.paymentId?.toString() === payment._id.toString())).toBeFalsy();
    });

    it('CONVENIO ainda billed (aguardando NF): fora do universo por status, não gera falso "missing credit"', async () => {
        const payment = await Payment.create(basePaymentFields({ billingType: 'convenio', kind: 'session_payment', paymentMethod: 'convenio', status: 'billed' }));
        // Nenhum insurance_received ainda — a NF não foi recebida, isso é normal.

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        expect(results.manualReview.find(m => m.paymentId?.toString() === payment._id.toString())).toBeFalsy();
    });

    it('LEGADO (criado antes de 2026-04-01): "paid" sem nenhum crédito é categoria separada, NUNCA inconsistência', async () => {
        const legacyPayment = await Payment.create(basePaymentFields({ createdAt: new Date('2025-09-15T12:00:00Z') }));
        // Força createdAt pra antes do corte — timestamps do Mongoose sobrescrevem
        // no create(), então ajusta direto na collection depois.
        await Payment.collection.updateOne({ _id: legacyPayment._id }, { $set: { createdAt: new Date('2025-09-15T12:00:00Z') } });
        // Nenhum lançamento no ledger — o mecanismo nem existia em set/2025.

        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        expect(results.manualReview.find(m => m.paymentId?.toString() === legacyPayment._id.toString())).toBeFalsy();
        expect(results.inconsistencies).toBe(0);
        expect(results.legacyPreLedgerCount).toBeGreaterThanOrEqual(1);
    });

    it('NÃO regressão: um payment RECENTE (pós-corte) sem nenhum crédito CONTINUA sendo auto-corrigido (não vira legado por engano)', async () => {
        const payment = await Payment.create(basePaymentFields());
        const results = freshResults();
        await reconcilePaymentNetCredit(results, { limit: 10 });

        expect(results.autoFixed).toBe(1);
        expect(results.legacyPreLedgerCount || 0).toBe(0);
    });
});

describe('[verificação 2] reconcileOrphanLedgerEntries — classificação, nunca misturado com caixa', () => {
    it('classifica como legitimate_patient_deletion quando o Patient não existe mais — NÃO gera inconsistência', async () => {
        const ghostPaymentId = new mongoose.Types.ObjectId();
        const ghostPatientId = new mongoose.Types.ObjectId(); // nunca criado
        await FinancialLedger.credit({ type: 'payment_received', amount: 200, patient: ghostPatientId, payment: ghostPaymentId, correlationId: 'orphan1', occurredAt: new Date('2026-08-10'), description: 'x' });

        const results = freshResults();
        await reconcileOrphanLedgerEntries(results, { limit: 50 });

        expect(results.manualReview.find(m => m.paymentId?.toString() === ghostPaymentId.toString())).toBeFalsy();
        expect(results.inconsistencies).toBe(0);
    });

    it('classifica como legitimate_package_deletion quando o Package não existe mais mas o Patient existe', async () => {
        const patient = await Patient.create({ fullName: 'Paciente Real', phone: '62999998888' });
        const ghostPaymentId = new mongoose.Types.ObjectId();
        const ghostPackageId = new mongoose.Types.ObjectId(); // nunca criado
        await FinancialLedger.credit({ type: 'package_purchase', amount: 1200, patient: patient._id, package: ghostPackageId, payment: ghostPaymentId, correlationId: 'orphan2', occurredAt: new Date('2026-08-10'), description: 'x' });

        const results = freshResults();
        await reconcileOrphanLedgerEntries(results, { limit: 50 });

        expect(results.manualReview.find(m => m.paymentId?.toString() === ghostPaymentId.toString())).toBeFalsy();
        expect(results.inconsistencies).toBe(0);
    });

    it('classifica como unexplained_orphan quando NÃO há trilha de exclusão (Patient/Package existem, valor não é de teste) — gera inconsistência de revisão manual', async () => {
        const patient = await Patient.create({ fullName: 'Paciente Real 2', phone: '62999997777' });
        const ghostPaymentId = new mongoose.Types.ObjectId();
        await FinancialLedger.credit({ type: 'payment_received', amount: 500, patient: patient._id, payment: ghostPaymentId, correlationId: 'orphan3', occurredAt: new Date('2026-08-10'), description: 'x' });

        const results = freshResults();
        await reconcileOrphanLedgerEntries(results, { limit: 50 });

        const issue = results.manualReview.find(m => m.paymentId?.toString() === ghostPaymentId.toString());
        expect(issue).toBeTruthy();
        expect(issue.classification).toBe('unexplained_orphan');
        expect(issue.type).toBe('orphan-ledger-entry');
    });

    it('não confunde um Payment que EXISTE com órfão', async () => {
        const payment = await Payment.create(basePaymentFields());
        await FinancialLedger.credit({ type: 'payment_received', amount: 160, patient: payment.patient, payment: payment._id, correlationId: 'notorphan', occurredAt: new Date('2026-08-10'), description: 'x' });

        const results = freshResults();
        await reconcileOrphanLedgerEntries(results, { limit: 50 });

        expect(results.manualReview.find(m => m.paymentId?.toString() === payment._id.toString())).toBeFalsy();
    });
});

describe('[verificação 3] reportMonthlyLedgerNetMovement — só o próprio ledger, sem comparar Payments', () => {
    it('reporta o movimento líquido correto usando direction (não presume sinal pelo nome do type)', async () => {
        const patient = new mongoose.Types.ObjectId();
        const paymentA = new mongoose.Types.ObjectId();
        const paymentB = new mongoose.Types.ObjectId();
        await FinancialLedger.credit({ type: 'payment_received', amount: 500, patient, payment: paymentA, correlationId: 'm1', occurredAt: new Date('2026-08-05'), description: 'x' });
        await FinancialLedger.credit({ type: 'package_purchase', amount: 1000, patient, payment: paymentB, correlationId: 'm2', occurredAt: new Date('2026-08-10'), description: 'y' });
        const creditForReversal = await FinancialLedger.credit({ type: 'payment_received', amount: 300, patient, payment: paymentA, correlationId: 'm3', occurredAt: new Date('2026-08-12'), description: 'z' });
        await FinancialLedger.debit({ type: 'reversal', amount: 300, patient, payment: paymentA, reversalOfEntryId: creditForReversal._id, correlationId: `reversal:${creditForReversal._id}`, occurredAt: new Date('2026-08-15'), description: 'w' });

        const results = freshResults();
        await reportMonthlyLedgerNetMovement(results, '2026-08');

        // 500 + 1000 + 300 (crédito) - 300 (reversão) = 1500
        expect(results.monthlyNetLedgerMovement.netMovement).toBe(1500);
    });

    it('NÃO conta payment_pending nem insurance_billed como caixa (são contas a receber, não dinheiro)', async () => {
        const patient = new mongoose.Types.ObjectId();
        await FinancialLedger.credit({ type: 'payment_pending', amount: 999, patient, payment: new mongoose.Types.ObjectId(), correlationId: 'pending1', occurredAt: new Date('2026-08-05'), description: 'x' });
        await FinancialLedger.credit({ type: 'insurance_billed', amount: 999, patient, payment: new mongoose.Types.ObjectId(), correlationId: 'billed1', occurredAt: new Date('2026-08-05'), description: 'y' });

        const results = freshResults();
        await reportMonthlyLedgerNetMovement(results, '2026-08');

        expect(results.monthlyNetLedgerMovement.netMovement).toBe(0);
    });

    it('não gera manualReview nem inconsistência — é só uma métrica informativa', async () => {
        const results = freshResults();
        await reportMonthlyLedgerNetMovement(results, '2026-08');

        expect(results.inconsistencies).toBe(0);
        expect(results.manualReview).toHaveLength(0);
    });
});
