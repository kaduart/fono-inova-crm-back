/**
 * 🛡️ TESTES DO SETTLE GUARD
 *
 * Valida regras de quitação manual de payments
 */

import { describe, it, expect, vi } from 'vitest';
import settleGuard from '../../services/financialGuard/guards/settle.guard.js';
import FinancialGuardError from '../../services/financialGuard/FinancialGuardError.js';

// Mock do Payment
const mockPaymentFind = vi.fn();
vi.mock('../../models/Payment.js', () => ({
  default: {
    find: (...args) => mockPaymentFind(...args)
  }
}));

// Mock do Appointment
const mockAppointmentFindById = vi.fn();
vi.mock('../../models/Appointment.js', () => ({
  default: {
    findById: (...args) => mockAppointmentFindById(...args)
  }
}));

const mockSession = {};

describe('🛡️ SETTLE GUARD', () => {
  beforeEach(() => {
    mockPaymentFind.mockClear();
  });

  describe('Contexto não suportado', () => {
    it('deve retornar handled=false para contexto desconhecido', async () => {
      const result = await settleGuard.handle({
        context: 'UNKNOWN_CONTEXT',
        payload: {},
        session: mockSession
      });

      expect(result).toEqual({ handled: false, reason: 'CONTEXT_NOT_SUPPORTED' });
    });
  });

  describe('Validação de billingType', () => {
    it('✅ deve permitir particular', async () => {
      const payments = [
        { _id: '1', billingType: 'particular' }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });

      const result = await settleGuard.handle({
        context: 'SETTLE_PAYMENT',
        payload: { paymentIds: ['1'] },
        session: mockSession
      });

      expect(result.handled).toBe(true);
      expect(result.validatedCount).toBe(1);
    });

    it('✅ deve permitir null tratado como particular', async () => {
      const payments = [
        { _id: '1', billingType: null }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });

      const result = await settleGuard.handle({
        context: 'SETTLE_PAYMENT',
        payload: { paymentIds: ['1'] },
        session: mockSession
      });

      expect(result.handled).toBe(true);
      expect(result.validatedCount).toBe(1);
    });

    it('❌ deve bloquear convênio', async () => {
      const payments = [
        { _id: '1', billingType: 'convenio' }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });

      await expect(
        settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1'] },
          session: mockSession
        })
      ).rejects.toThrow(FinancialGuardError);

      try {
        await settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1'] },
          session: mockSession
        });
      } catch (err) {
        expect(err.code).toBe('PAYMENT_FLOW_BLOCKED');
        expect(err.meta.billingType).toBe('convenio');
      }
    });

    it('❌ deve bloquear insurance', async () => {
      const payments = [
        { _id: '1', billingType: 'insurance' }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });

      await expect(
        settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1'] },
          session: mockSession
        })
      ).rejects.toThrow(FinancialGuardError);

      try {
        await settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1'] },
          session: mockSession
        });
      } catch (err) {
        expect(err.code).toBe('PAYMENT_FLOW_BLOCKED');
        expect(err.meta.billingType).toBe('insurance');
      }
    });

    it('❌ deve bloquear liminar', async () => {
      const payments = [
        { _id: '1', billingType: 'liminar' }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });

      await expect(
        settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1'] },
          session: mockSession
        })
      ).rejects.toThrow(FinancialGuardError);

      try {
        await settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1'] },
          session: mockSession
        });
      } catch (err) {
        expect(err.code).toBe('PAYMENT_FLOW_BLOCKED');
        expect(err.meta.billingType).toBe('liminar');
      }
    });
  });

  describe('Validação de múltiplos payments', () => {
    it('✅ deve permitir todos particular', async () => {
      const payments = [
        { _id: '1', billingType: 'particular' },
        { _id: '2', billingType: 'particular' }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });

      const result = await settleGuard.handle({
        context: 'SETTLE_PAYMENT',
        payload: { paymentIds: ['1', '2'] },
        session: mockSession
      });

      expect(result.handled).toBe(true);
      expect(result.validatedCount).toBe(2);
    });

    it('❌ deve bloquear se QUALQUER um for convênio', async () => {
      const payments = [
        { _id: '1', billingType: 'particular' },
        { _id: '2', billingType: 'convenio' }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });

      await expect(
        settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1', '2'] },
          session: mockSession
        })
      ).rejects.toThrow(FinancialGuardError);

      try {
        await settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1', '2'] },
          session: mockSession
        });
      } catch (err) {
        expect(err.code).toBe('PAYMENT_FLOW_BLOCKED');
      }
    });
  });

  describe('Validação de payload', () => {
    it('❌ deve lançar FinancialGuardError se não receber paymentIds nem payment', async () => {
      await expect(
        settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: {},
          session: mockSession
        })
      ).rejects.toThrow(FinancialGuardError);

      try {
        await settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: {},
          session: mockSession
        });
      } catch (err) {
        expect(err.code).toBe('NO_PAYMENT_DATA');
        expect(err.name).toBe('FinancialGuardError');
      }
    });

    it('❌ deve lançar FinancialGuardError se paymentIds retornar vazio do DB', async () => {
      mockPaymentFind.mockReturnValue({ session: () => [] });

      await expect(
        settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1', '2'] },
          session: mockSession
        })
      ).rejects.toThrow(FinancialGuardError);

      try {
        await settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1', '2'] },
          session: mockSession
        });
      } catch (err) {
        expect(err.code).toBe('NO_PAYMENTS_FOUND');
        expect(err.meta.paymentIds).toEqual(['1', '2']);
      }
    });

    it('✅ deve aceitar um único payment direto', async () => {
      const result = await settleGuard.handle({
        context: 'SETTLE_PAYMENT',
        payload: { payment: { _id: '1', billingType: 'particular' } },
        session: mockSession
      });

      expect(result.handled).toBe(true);
      expect(result.validatedCount).toBe(1);
    });
  });

  describe('Validação de vínculo com pacote (packageId)', () => {
    beforeEach(() => {
      mockAppointmentFindById.mockClear();
    });

    it('✅ deve permitir payment vinculado ao pacote correto', async () => {
      const payments = [
        { _id: '1', billingType: 'particular', package: { toString: () => 'pkg1' } }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });

      const result = await settleGuard.handle({
        context: 'SETTLE_PAYMENT',
        payload: { paymentIds: ['1'], packageId: 'pkg1' },
        session: mockSession
      });

      expect(result.handled).toBe(true);
      expect(result.validatedCount).toBe(1);
    });

    it('❌ deve bloquear payment de outro pacote', async () => {
      const payments = [
        { _id: '1', billingType: 'particular', package: { toString: () => 'pkg2' } }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });

      await expect(
        settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1'], packageId: 'pkg1' },
          session: mockSession
        })
      ).rejects.toThrow(FinancialGuardError);

      try {
        await settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1'], packageId: 'pkg1' },
          session: mockSession
        });
      } catch (err) {
        expect(err.code).toBe('PAYMENT_PACKAGE_MISMATCH');
        expect(err.meta.paymentPackageId).toBe('pkg2');
        expect(err.meta.expectedPackageId).toBe('pkg1');
      }
    });

    it('❌ deve bloquear se appointment vinculado a outro pacote', async () => {
      const payments = [
        { _id: '1', billingType: 'particular', package: { toString: () => 'pkg1' }, appointment: 'appt1' }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });
      mockAppointmentFindById.mockReturnValue({
        lean: () => Promise.resolve({ _id: 'appt1', package: { toString: () => 'pkg2' } })
      });

      await expect(
        settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1'], packageId: 'pkg1' },
          session: mockSession
        })
      ).rejects.toThrow(FinancialGuardError);

      try {
        await settleGuard.handle({
          context: 'SETTLE_PAYMENT',
          payload: { paymentIds: ['1'], packageId: 'pkg1' },
          session: mockSession
        });
      } catch (err) {
        expect(err.code).toBe('APPOINTMENT_PACKAGE_MISMATCH');
        expect(err.meta.appointmentPackageId).toBe('pkg2');
        expect(err.meta.expectedPackageId).toBe('pkg1');
      }
    });

    it('✅ deve permitir se não houver packageId (bulk-settle)', async () => {
      const payments = [
        { _id: '1', billingType: 'particular', package: { toString: () => 'pkg2' } }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });

      const result = await settleGuard.handle({
        context: 'SETTLE_PAYMENT',
        payload: { paymentIds: ['1'] },
        session: mockSession
      });

      expect(result.handled).toBe(true);
      expect(result.validatedCount).toBe(1);
    });

    it('✅ deve permitir payment sem vínculo de pacote (package=null)', async () => {
      const payments = [
        { _id: '1', billingType: 'particular', package: null }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });

      const result = await settleGuard.handle({
        context: 'SETTLE_PAYMENT',
        payload: { paymentIds: ['1'], packageId: 'pkg1' },
        session: mockSession
      });

      expect(result.handled).toBe(true);
      expect(result.validatedCount).toBe(1);
    });

    it('✅ deve permitir payment com package mas SEM appointment (appointment=null)', async () => {
      const payments = [
        { _id: '1', billingType: 'particular', package: { toString: () => 'pkg1' }, appointment: null }
      ];
      mockPaymentFind.mockReturnValue({ session: () => payments });
      // Appointment.findById NÃO deve ser chamado quando appointment é null
      mockAppointmentFindById.mockClear();

      const result = await settleGuard.handle({
        context: 'SETTLE_PAYMENT',
        payload: { paymentIds: ['1'], packageId: 'pkg1' },
        session: mockSession
      });

      expect(result.handled).toBe(true);
      expect(result.validatedCount).toBe(1);
      expect(mockAppointmentFindById).not.toHaveBeenCalled();
    });
  });
});
