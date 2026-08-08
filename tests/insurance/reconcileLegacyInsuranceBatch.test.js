// tests/insurance/reconcileLegacyInsuranceBatch.test.js
/**
 * Reconciliação de envio legado de convênio.
 *
 * O que estes testes protegem é dinheiro histórico: uma NF antiga agrupava várias
 * guias, e registrá-la errado significa faturar duas vezes, apagar um recebimento
 * ou carimbar data de hoje num lançamento imutável.
 *
 * Cobrem as funções puras. O caminho de escrita depende de banco e é exercido
 * pela prévia real (dryRun) contra produção.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import '../../models/index.js';
import {
    resolveCanonicalPayment,
    resolveItemValue,
    classifyReconciliation,
    TERMINAL_PAYMENT_STATUSES,
    BLOCKING
} from '../../services/insuranceGuide/reconcileLegacyInsuranceBatch.js';

const pay = (id, status, insStatus, gross, amount) => ({
    _id: id, status, amount, insurance: { status: insStatus, grossAmount: gross }
});

describe('🧾 resolveCanonicalPayment() — o cancelado é histórico, não o vigente', () => {
    it('caso real jan/fev: 1 cancelado a R$100 + 1 ativo a R$80 → vence o ativo', () => {
        const { payment, conflict } = resolveCanonicalPayment([
            pay('hist', 'canceled', 'pending_billing', 100),
            pay('vig', 'pending', 'pending_billing', 80)
        ]);
        assert.strictEqual(conflict, null);
        assert.strictEqual(payment._id, 'vig');
        assert.strictEqual(payment.insurance.grossAmount, 80);
    });

    it('REGRESSÃO: a ordem da lista não muda o resultado', () => {
        const a = [pay('hist', 'canceled', 'pending_billing', 100), pay('vig', 'pending', 'pending_billing', 80)];
        const b = [pay('vig', 'pending', 'pending_billing', 80), pay('hist', 'canceled', 'pending_billing', 100)];
        assert.strictEqual(resolveCanonicalPayment(a).payment._id, resolveCanonicalPayment(b).payment._id);
    });

    it('todos os status terminais são descartados', () => {
        for (const t of TERMINAL_PAYMENT_STATUSES) {
            const { conflict } = resolveCanonicalPayment([pay('x', t, 'pending_billing', 100)]);
            assert.strictEqual(conflict, BLOCKING.NO_ACTIVE_PAYMENT, `${t} deveria ser terminal`);
        }
    });

    it('zero ativos → conflito, nunca escolha silenciosa', () => {
        assert.strictEqual(resolveCanonicalPayment([]).conflict, BLOCKING.NO_ACTIVE_PAYMENT);
    });

    it('mais de um ativo → conflito crítico, nunca precedência silenciosa', () => {
        const { payment, conflict, actives } = resolveCanonicalPayment([
            pay('a', 'pending', 'pending_billing', 80),
            pay('b', 'pending', 'received', 80)
        ]);
        assert.strictEqual(conflict, BLOCKING.MULTIPLE_ACTIVE_PAYMENTS);
        assert.strictEqual(payment, null, 'não pode devolver o "mais avançado"');
        assert.strictEqual(actives.length, 2);
    });
});

describe('💵 resolveItemValue() — o documento vence, a divergência fica registrada', () => {
    it('valor documentado vence o Payment e grava a diferença', () => {
        const r = resolveItemValue({ documentedValue: 80, payment: pay('p', 'pending', 'pending_billing', 100) });
        assert.strictEqual(r.grossAmount, 80);
        assert.strictEqual(r.valueSource, 'legacy_document');
        assert.strictEqual(r.originalPaymentAmount, 100);
        assert.strictEqual(r.reconciliationDifference, -20);
    });

    it('sem valor documentado, usa o Payment canônico', () => {
        const r = resolveItemValue({ documentedValue: undefined, payment: pay('p', 'pending', 'pending_billing', 80) });
        assert.strictEqual(r.grossAmount, 80);
        assert.strictEqual(r.valueSource, 'canonical_payment');
        assert.strictEqual(r.reconciliationDifference, 0);
    });

    it('sem grossAmount, cai para Payment.amount e marca a procedência', () => {
        const r = resolveItemValue({ payment: pay('p', 'pending', 'pending_billing', 0, 140) });
        assert.strictEqual(r.grossAmount, 140);
        assert.strictEqual(r.valueSource, 'payment_amount');
    });

    it('sem documento e sem Payment → null, para virar conflito (nunca zero silencioso)', () => {
        const r = resolveItemValue({ payment: pay('p', 'pending', 'pending_billing', 0, 0) });
        assert.strictEqual(r.grossAmount, null);
        assert.strictEqual(r.valueSource, null);
    });

    it('NÃO usa Session.sessionValue — no legado ele está zerado', () => {
        // a assinatura sequer aceita sessionValue; se aceitasse, jan/fev daria 0
        const r = resolveItemValue({ documentedValue: 80, payment: null });
        assert.strictEqual(r.grossAmount, 80);
        assert.strictEqual(r.originalPaymentAmount, null);
    });
});

describe('📋 classifyReconciliation() — divergir não bloqueia', () => {
    it('NF de janeiro: 18 × R$80 = R$1.440 documentado → matched', () => {
        const r = classifyReconciliation({ expectedGross: 1440, documentedGross: 1440 });
        assert.strictEqual(r.status, 'matched');
        assert.strictEqual(r.difference, 0);
    });

    it('soma dos itens difere do documento → divergent com a diferença, sem bloquear', () => {
        const r = classifyReconciliation({ expectedGross: 1800, documentedGross: 1440 });
        assert.strictEqual(r.status, 'divergent');
        assert.strictEqual(r.difference, -360);
        assert.ok(r.reason.includes('1440'));
    });

    it('bruto não documentado → divergent, nunca deduzido do rótulo da nota', () => {
        const r = classifyReconciliation({ expectedGross: 960, documentedGross: null });
        assert.strictEqual(r.status, 'divergent');
        assert.strictEqual(r.difference, null);
        assert.ok(/não documentado/.test(r.reason));
    });

    it('override manual é rotulado como tal, não como conferido', () => {
        const r = classifyReconciliation({ expectedGross: 1500, documentedGross: 1168.92, manualOverride: true });
        assert.strictEqual(r.status, 'manual_override');
        assert.strictEqual(r.difference, -331.08);
    });

    it('centavos não viram ruído de ponto flutuante', () => {
        const r = classifyReconciliation({ expectedGross: 960, documentedGross: 940.70 });
        assert.strictEqual(r.difference, -19.3);
    });
});
