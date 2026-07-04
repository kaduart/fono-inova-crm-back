import { describe, it, expect } from 'vitest';
import { resolveVisualFlag } from '../shared/resolveVisualFlag.js';

describe('resolveVisualFlag', () => {
    it('retorna pending para sessao fiada/addToBalance', () => {
        expect(resolveVisualFlag({ paymentStatus: 'unpaid', isPaid: false }, true)).toBe('pending');
        expect(resolveVisualFlag({ paymentStatus: 'paid', isPaid: true }, true)).toBe('pending');
    });

    it('retorna ok para sessao paga no ato (avulso/per-session/liminar)', () => {
        expect(resolveVisualFlag({ paymentStatus: 'paid', isPaid: true }, false)).toBe('ok');
    });

    it('retorna ok para pacote pre-pago', () => {
        expect(resolveVisualFlag({ paymentStatus: 'package_paid', isPaid: true }, false)).toBe('ok');
    });

    it('retorna pending para convenio (pending_receipt)', () => {
        expect(resolveVisualFlag({ paymentStatus: 'pending_receipt', isPaid: false }, false)).toBe('pending');
    });

    it('retorna partial para pagamento parcial', () => {
        expect(resolveVisualFlag({ paymentStatus: 'partial', isPaid: false }, false)).toBe('partial');
    });

    it('retorna pending como fallback seguro', () => {
        expect(resolveVisualFlag({ paymentStatus: 'unknown', isPaid: false }, false)).toBe('pending');
        expect(resolveVisualFlag(null, false)).toBe('pending');
    });
});
