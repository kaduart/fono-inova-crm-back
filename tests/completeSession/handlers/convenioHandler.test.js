/**
 * 🛡️ Testes unitários — ConvenioHandler
 *
 * Validam a resolução defensiva de Payment no fluxo de convênio:
 * - nunca ressuscita Payment cancelado apontado por appointment.payment
 * - sempre prioriza Payment ativo vinculado à session
 * - cria novo apenas quando não existe nenhum ativo
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConvenioHandler } from '../../../services/completeSession/index.js';

vi.mock('../../../models/InsuranceGuide.js', () => ({
  default: {
    findById: vi.fn(),
    findValid: vi.fn()
  }
}));
vi.mock('../../../services/guideLifecycle/GuideLifecycleService.js', () => ({
  GuideLifecycleService: { evaluate: vi.fn() }
}));
vi.mock('../../../services/financialGuard/FinanceWriteGuard.js', () => ({
  default: { setSessionPaid: vi.fn(), setSessionPaymentStatus: vi.fn() }
}));
vi.mock('../../../models/Payment.js', () => ({
  default: {
    findOne: vi.fn(),
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    create: vi.fn()
  }
}));
vi.mock('../../../models/Session.js', () => ({
  default: {
    findByIdAndUpdate: vi.fn(),
    findById: vi.fn()
  }
}));

import Payment from '../../../models/Payment.js';
import InsuranceGuide from '../../../models/InsuranceGuide.js';
import Session from '../../../models/Session.js';
import { GuideLifecycleService } from '../../../services/guideLifecycle/GuideLifecycleService.js';

function makeGuide() {
  return {
    _id: 'guide-1',
    insurance: 'unimed',
    number: '123',
    consumeSession: vi.fn().mockResolvedValue(true)
  };
}

function makeContext(overrides = {}) {
  return {
    appointment: {
      _id: 'appt-1',
      patient: { _id: 'patient-1' },
      doctor: { _id: 'doctor-1' },
      specialty: 'fonoaudiologia',
      insuranceGuide: 'guide-1',
      payment: 'pay-cancelado',
      ...overrides.appointment
    },
    sessionId: 'session-1',
    sessionValue: 100,
    appointmentId: 'appt-1',
    mongoSession: {},
    userId: 'user-1',
    ...overrides
  };
}

function chainPaymentFindById(result) {
  return {
    session: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(result)
    })
  };
}

function chainPaymentFindOne(result) {
  return {
    session: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(result)
    })
  };
}

describe('ConvenioHandler.buildPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    InsuranceGuide.findById.mockReturnValue({
      session: vi.fn().mockResolvedValue(makeGuide())
    });
    InsuranceGuide.findValid.mockResolvedValue(makeGuide());
    GuideLifecycleService.evaluate.mockResolvedValue({ eligibility: { canBill: true } });

    Session.findById.mockReturnValue({
      select: vi.fn().mockReturnValue({
        session: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ guideConsumed: false, insuranceGuide: 'guide-1' })
        })
      })
    });

    Payment.findById.mockResolvedValue(null);
    Payment.findOne.mockReturnValue(chainPaymentFindOne(null));
    Payment.findByIdAndUpdate.mockResolvedValue({
      _id: 'pay-ativo',
      session: 'session-1',
      status: 'pending',
      kind: 'session_payment'
    });
    Payment.create.mockResolvedValue([{
      _id: 'pay-novo',
      session: 'session-1',
      status: 'pending',
      kind: 'session_payment'
    }]);
  });

  it('não ressuscita Payment cancelado apontado por appointment.payment', async () => {
    // appointment.payment aponta para um Payment cancelado
    Payment.findById.mockReturnValue(chainPaymentFindById({
      _id: 'pay-cancelado',
      status: 'canceled',
      kind: 'convenio_receivable',
      session: 'session-1',
      billingType: 'convenio'
    }));

    // Mas existe um Payment ativo vinculado à mesma session
    Payment.findOne.mockReturnValue(chainPaymentFindOne({
      _id: 'pay-ativo',
      status: 'pending',
      kind: 'session_payment',
      session: 'session-1',
      billingType: 'convenio'
    }));

    const appointmentUpdate = { $set: {} };
    const ctx = makeContext();
    await ConvenioHandler.buildPayment(appointmentUpdate, ctx);

    // Deve atualizar o Payment ativo, nunca o cancelado
    expect(Payment.findByIdAndUpdate).toHaveBeenCalledWith(
      'pay-ativo',
      expect.any(Object),
      expect.objectContaining({ session: ctx.mongoSession, new: true })
    );
    const updatedIds = Payment.findByIdAndUpdate.mock.calls.map(c => c[0]);
    expect(updatedIds).not.toContain('pay-cancelado');
    expect(appointmentUpdate.$set.payment.toString()).toBe('pay-ativo');
  });

  it('usa Payment ativo por appointment quando session não tem payment', async () => {
    Payment.findById.mockReturnValue(chainPaymentFindById({
      _id: 'pay-ativo',
      status: 'pending',
      kind: 'session_payment',
      session: null,
      billingType: 'convenio'
    }));

    Payment.findOne.mockReturnValue(chainPaymentFindOne(null));

    const appointmentUpdate = { $set: {} };
    const ctx = makeContext({ appointment: { payment: 'pay-ativo' } });
    await ConvenioHandler.buildPayment(appointmentUpdate, ctx);

    expect(Payment.findByIdAndUpdate).toHaveBeenCalledWith(
      'pay-ativo',
      expect.any(Object),
      expect.objectContaining({ session: ctx.mongoSession, new: true })
    );
    // Se appointment já apontava para o Payment ativo, não precisa re-escrever o link
    const linkedPayment = appointmentUpdate.$set.payment?.toString?.() || ctx.appointment.payment;
    expect(linkedPayment).toBe('pay-ativo');
  });

  it('cria novo Payment quando nenhum ativo existe', async () => {
    Payment.findById.mockResolvedValue(null);
    Payment.findOne.mockReturnValue(chainPaymentFindOne(null));

    const appointmentUpdate = { $set: {} };
    const ctx = makeContext({ appointment: { payment: null } });
    await ConvenioHandler.buildPayment(appointmentUpdate, ctx);

    expect(Payment.create).toHaveBeenCalled();
    expect(appointmentUpdate.$set.payment.toString()).toBe('pay-novo');
  });

  it('adota orphan ativo por session quando appointment.payment é nulo', async () => {
    Payment.findOne.mockReturnValue(chainPaymentFindOne({
      _id: 'pay-orphan',
      status: 'pending',
      kind: 'convenio_receivable',
      session: 'session-1',
      billingType: 'convenio'
    }));

    Payment.findByIdAndUpdate.mockResolvedValue({
      _id: 'pay-orphan',
      session: 'session-1',
      status: 'pending',
      kind: 'session_payment'
    });

    const appointmentUpdate = { $set: {} };
    const ctx = makeContext({ appointment: { payment: null } });
    await ConvenioHandler.buildPayment(appointmentUpdate, ctx);

    expect(Payment.create).not.toHaveBeenCalled();
    expect(Payment.findByIdAndUpdate).toHaveBeenCalledWith(
      'pay-orphan',
      expect.any(Object),
      expect.objectContaining({ session: ctx.mongoSession, new: true })
    );
    expect(appointmentUpdate.$set.payment.toString()).toBe('pay-orphan');
  });
});
