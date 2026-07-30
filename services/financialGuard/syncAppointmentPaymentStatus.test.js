/**
 * 🛡️ Testes unitários — syncAppointmentPaymentStatus
 *
 * Cobre a sincronização de appointment.paymentStatus / isPaid quando um Payment
 * é cancelado/refundado (PR E):
 * - Atualiza scheduled/confirmed para pending.
 * - Atualiza canceled para canceled.
 * - Não altera completed (revisão manual).
 * - Protege liminar, pacote ativo, outro payment pago e convênio ativo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncAppointmentPaymentStatus } from './syncAppointmentPaymentStatus.js';

vi.mock('../../models/Appointment.js', () => ({
  default: {
    findById: vi.fn().mockReturnValue({ lean: vi.fn() }),
    findByIdAndUpdate: vi.fn()
  }
}));
vi.mock('../../models/Payment.js', () => ({
  default: {
    findOne: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn() })
    })
  }
}));
vi.mock('../../models/Package.js', () => ({
  default: {
    findById: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn() })
    })
  }
}));

import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Package from '../../models/Package.js';

function makePayment(overrides = {}) {
  return {
    _id: 'payment-1',
    appointment: 'appt-1',
    appointmentId: null,
    ...overrides
  };
}

function makeAppointment(overrides = {}) {
  return {
    _id: 'appt-1',
    billingType: 'particular',
    paymentMethod: 'pix',
    paymentOrigin: null,
    liminarContract: null,
    package: null,
    operationalStatus: 'scheduled',
    paymentStatus: 'paid',
    isPaid: true,
    ...overrides
  };
}

function mockAppointmentFindById(appointment) {
  const leanFn = vi.fn().mockResolvedValue(appointment);
  Appointment.findById.mockReturnValue({ lean: leanFn });
  return leanFn;
}

function mockPaymentFindOne(resultOrResults) {
  const results = Array.isArray(resultOrResults) ? resultOrResults : [resultOrResults];
  Payment.findOne.mockReset();
  for (const result of results) {
    Payment.findOne.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(result) })
    });
  }
}

function mockPackageFindById(result) {
  Package.findById.mockReturnValue({
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(result) })
  });
}

describe('syncAppointmentPaymentStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deve sincronizar scheduled → pending', async () => {
    mockAppointmentFindById(makeAppointment({ operationalStatus: 'scheduled' }));
    mockPaymentFindOne([null, null]); // sem outro payment ativo, sem convênio ativo
    mockPackageFindById(null);

    const result = await syncAppointmentPaymentStatus(makePayment());

    expect(result.synced).toBe(true);
    expect(result.newPaymentStatus).toBe('pending');
    expect(result.newIsPaid).toBe(false);
    expect(Appointment.findByIdAndUpdate).toHaveBeenCalledWith(
      'appt-1',
      expect.objectContaining({
        $set: expect.objectContaining({ paymentStatus: 'pending', isPaid: false })
      })
    );
  });

  it('deve sincronizar canceled → canceled', async () => {
    mockAppointmentFindById(makeAppointment({ operationalStatus: 'canceled' }));
    mockPaymentFindOne([null, null]);
    mockPackageFindById(null);

    const result = await syncAppointmentPaymentStatus(makePayment());

    expect(result.synced).toBe(true);
    expect(result.newPaymentStatus).toBe('canceled');
    expect(Appointment.findByIdAndUpdate).toHaveBeenCalled();
  });

  it('deve ignorar completed (revisão manual)', async () => {
    mockAppointmentFindById(makeAppointment({ operationalStatus: 'completed' }));
    mockPaymentFindOne([null, null]);
    mockPackageFindById(null);

    const result = await syncAppointmentPaymentStatus(makePayment());

    expect(result.synced).toBe(false);
    expect(result.reason).toBe('REQUIRES_MANUAL_REVIEW');
    expect(Appointment.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('deve proteger appointments liminar', async () => {
    mockAppointmentFindById(makeAppointment({ billingType: 'liminar' }));

    const result = await syncAppointmentPaymentStatus(makePayment());

    expect(result.synced).toBe(false);
    expect(result.reason).toBe('LIMINAR_PROTECTED');
    expect(Appointment.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('deve proteger appointments com pacote ativo', async () => {
    mockAppointmentFindById(makeAppointment({ package: 'pkg-1' }));
    mockPackageFindById({ _id: 'pkg-1', status: 'active' });

    const result = await syncAppointmentPaymentStatus(makePayment());

    expect(result.synced).toBe(false);
    expect(result.reason).toBe('PACKAGE_PROTECTED');
    expect(Appointment.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('deve proteger se existir outro payment pago', async () => {
    mockAppointmentFindById(makeAppointment());
    mockPaymentFindOne({ _id: 'payment-2' });

    const result = await syncAppointmentPaymentStatus(makePayment());

    expect(result.synced).toBe(false);
    expect(result.reason).toBe('OTHER_PAID_PAYMENT_EXISTS');
    expect(Appointment.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('deve proteger se existir recebível de convênio ativo', async () => {
    mockAppointmentFindById(makeAppointment());
    mockPaymentFindOne([null, { _id: 'payment-convenio' }]);

    const result = await syncAppointmentPaymentStatus(makePayment());

    expect(result.synced).toBe(false);
    expect(result.reason).toBe('ACTIVE_CONVENIO_RECEIVABLE');
    expect(Appointment.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('deve tratar payment sem vínculo com appointment', async () => {
    const result = await syncAppointmentPaymentStatus(makePayment({ appointment: null, appointmentId: null }));

    expect(result.synced).toBe(false);
    expect(result.reason).toBe('NO_APPOINTMENT_LINK');
  });
});
