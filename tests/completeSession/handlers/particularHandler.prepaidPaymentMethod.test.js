import { describe, it, expect } from 'vitest';
import { ParticularHandler } from '../../../services/completeSession/handlers/particularHandler.js';

// 🐛 FIX (2026-09-22): buildSessionUpdate, branch isPrepaid, gravava sessionUpdate.paymentMethod =
// 'package_prepaid' — valor fora do enum de Session.paymentMethod (models/Session.js). Como a escrita
// passa por findOneAndUpdate/updateOne (sem runValidators), entrava no banco sem erro e só estourava
// (ValidationError engolida em silêncio) quando outra coisa chamava .save() no mesmo documento depois —
// o hook post('findOneAndUpdate') de provisionamento é um desses casos, e o provisionamento pós-complete
// falhava sem avisar ninguém. Este arquivo prova que paymentMethod nunca mais recebe esse valor.
const SESSION_PAYMENT_METHOD_ENUM = [
    'dinheiro', 'pix', 'cartão', 'convenio', 'liminar_credit',
    'credito', 'debito', 'cartao_credito', 'cartao_debito', 'transferencia', 'transferencia_bancaria'
];

const basePrepaidPkg = { model: 'prepaid', paymentType: undefined };

describe('ParticularHandler.buildSessionUpdate — pacote pré-pago (isPrepaid)', () => {
    it('paymentMethod nunca é "package_prepaid" — sempre um valor do enum de Session.paymentMethod', () => {
        const sessionUpdate = {};
        ParticularHandler.buildSessionUpdate(sessionUpdate, {
            appointment: { paymentMethod: 'pix' },
            packageData: basePrepaidPkg,
            isBalanceOrigin: false,
            splitMethods: null,
            paymentMethod: undefined,
        });
        expect(sessionUpdate.paymentMethod).not.toBe('package_prepaid');
        expect(SESSION_PAYMENT_METHOD_ENUM).toContain(sessionUpdate.paymentMethod);
    });

    it('paymentOrigin continua "package_prepaid" (não afetado pelo fix)', () => {
        const sessionUpdate = {};
        ParticularHandler.buildSessionUpdate(sessionUpdate, {
            appointment: { paymentMethod: 'pix' }, packageData: basePrepaidPkg, isBalanceOrigin: false,
        });
        expect(sessionUpdate.paymentOrigin).toBe('package_prepaid');
    });

    it('paymentMethod explícito da conclusão tem prioridade máxima', () => {
        const sessionUpdate = {};
        ParticularHandler.buildSessionUpdate(sessionUpdate, {
            appointment: { paymentMethod: 'pix' },
            packageData: { ...basePrepaidPkg, paymentMethod: 'dinheiro' },
            isBalanceOrigin: false,
            splitMethods: [{ method: 'cartão' }],
            paymentMethod: 'transferencia',
        });
        expect(sessionUpdate.paymentMethod).toBe('transferencia');
    });

    it('sem escolha explícita, usa a 1ª forma do split', () => {
        const sessionUpdate = {};
        ParticularHandler.buildSessionUpdate(sessionUpdate, {
            appointment: { paymentMethod: 'pix' }, packageData: basePrepaidPkg, isBalanceOrigin: false,
            splitMethods: [{ method: 'cartão' }], paymentMethod: undefined,
        });
        expect(sessionUpdate.paymentMethod).toBe('cartão');
    });

    it('sem split, usa o paymentMethod salvo no appointment', () => {
        const sessionUpdate = {};
        ParticularHandler.buildSessionUpdate(sessionUpdate, {
            appointment: { paymentMethod: 'dinheiro' }, packageData: basePrepaidPkg, isBalanceOrigin: false,
        });
        expect(sessionUpdate.paymentMethod).toBe('dinheiro');
    });

    it('sem appointment nem split, usa o paymentMethod do pacote', () => {
        const sessionUpdate = {};
        ParticularHandler.buildSessionUpdate(sessionUpdate, {
            appointment: {}, packageData: { ...basePrepaidPkg, paymentMethod: 'debito' }, isBalanceOrigin: false,
        });
        expect(sessionUpdate.paymentMethod).toBe('debito');
    });

    it('sem nenhuma fonte, cai no default "pix"', () => {
        const sessionUpdate = {};
        ParticularHandler.buildSessionUpdate(sessionUpdate, {
            appointment: {}, packageData: basePrepaidPkg, isBalanceOrigin: false,
        });
        expect(sessionUpdate.paymentMethod).toBe('pix');
    });

    it('paymentType=full (sem model=prepaid) também entra na branch isPrepaid e não hardcodeia o valor', () => {
        const sessionUpdate = {};
        ParticularHandler.buildSessionUpdate(sessionUpdate, {
            appointment: { paymentMethod: 'cartao_credito' }, packageData: { paymentType: 'full' }, isBalanceOrigin: false,
        });
        expect(sessionUpdate.paymentMethod).toBe('cartao_credito');
        expect(sessionUpdate.paymentOrigin).toBe('package_prepaid');
    });

    it('demais campos financeiros da branch isPrepaid continuam corretos', () => {
        const sessionUpdate = {};
        ParticularHandler.buildSessionUpdate(sessionUpdate, {
            appointment: { paymentMethod: 'pix' }, packageData: basePrepaidPkg, isBalanceOrigin: false,
        });
        expect(sessionUpdate.isPaid).toBe(true);
        expect(sessionUpdate.paymentStatus).toBe('package_paid');
        expect(sessionUpdate.paidAt).toBeInstanceOf(Date);
    });
});
