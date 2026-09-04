/**
 * Testes puros (sem banco) dos guards de domínio de sinal+saldo.
 * Ver back/domain/payment/depositBalance.js.
 */
import { describe, it, expect } from 'vitest';
import {
    assertNewTotalCoversPaidDeposit,
    assertNotDepositPayment,
    DepositExceedsTotalError,
    DepositPaymentProtectedError,
    PAYMENT_ROLE,
} from '../../domain/payment/depositBalance.js';

describe('assertNewTotalCoversPaidDeposit', () => {
    it('não lança quando o novo total é maior que o sinal pago', () => {
        expect(() => assertNewTotalCoversPaidDeposit(600, 50)).not.toThrow();
    });

    it('não lança quando o novo total é igual ao sinal pago (saldo zero)', () => {
        expect(() => assertNewTotalCoversPaidDeposit(50, 50)).not.toThrow();
    });

    it('lança DepositExceedsTotalError quando o novo total é menor que o sinal pago', () => {
        expect(() => assertNewTotalCoversPaidDeposit(40, 50)).toThrow(DepositExceedsTotalError);
        try {
            assertNewTotalCoversPaidDeposit(40, 50);
        } catch (err) {
            expect(err.code).toBe('DEPOSIT_EXCEEDS_NEW_TOTAL');
            expect(err.status).toBe(409);
        }
    });

    it('não lança quando não há sinal pago (depositPaidAmount=0)', () => {
        expect(() => assertNewTotalCoversPaidDeposit(10, 0)).not.toThrow();
    });
});

describe('assertNotDepositPayment', () => {
    it('não lança para payment nulo/ausente', () => {
        expect(() => assertNotDepositPayment(null)).not.toThrow();
        expect(() => assertNotDepositPayment(undefined)).not.toThrow();
    });

    it('não lança para paymentRole standard ou balance', () => {
        expect(() => assertNotDepositPayment({ _id: 'a', paymentRole: PAYMENT_ROLE.STANDARD })).not.toThrow();
        expect(() => assertNotDepositPayment({ _id: 'b', paymentRole: PAYMENT_ROLE.BALANCE })).not.toThrow();
    });

    it('lança DepositPaymentProtectedError para paymentRole=deposit', () => {
        expect(() => assertNotDepositPayment({ _id: 'c', paymentRole: PAYMENT_ROLE.DEPOSIT })).toThrow(DepositPaymentProtectedError);
    });
});
