/**
 * 🛡️ Testes unitários — cancelAppointmentCommand (executeWithSession)
 *
 * Cobre a integração dos dois bugs corrigidos em 2026-07-22:
 * 1) sessionsDone decrementado sem checar se o appointment tinha sido completed
 *    → agora delega para restorePackageOnCancel (testada isoladamente em
 *      restorePackageOnCancel.test.js); aqui validamos que ela é chamada com
 *      os parâmetros corretos (appointmentStatus, paymentOrigin, sessionValue).
 * 2) $pull: { sessions: appointment._id } comparava Appointment._id com um
 *    array que guarda Session._id → nunca casava. Agora usa appointment.session._id.
 *
 * Também cobre: Payment de pacote (`package_receipt`) nunca é cancelado junto
 * com a sessão, e sessão avulsa (sem package) não aciona nada disso.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import { restorePackageOnCancel } from '../domain/package/restorePackageOnCancel.js';
import { executeWithSession } from '../services/appointment/commands/cancelAppointmentCommand.js';

vi.mock('../models/Appointment.js', () => ({
  default: { findById: vi.fn(), findByIdAndUpdate: vi.fn() },
}));
vi.mock('../models/Payment.js', () => ({
  default: { find: vi.fn(), findById: vi.fn(), findByIdAndUpdate: vi.fn() },
}));
vi.mock('../models/Session.js', () => ({
  default: { findById: vi.fn() },
}));
vi.mock('../models/Package.js', () => ({
  default: { findByIdAndUpdate: vi.fn() },
}));
vi.mock('../infrastructure/outbox/outboxPattern.js', () => ({
  saveToOutbox: vi.fn().mockResolvedValue(true),
}));
vi.mock('../domain/package/restorePackageOnCancel.js', () => ({
  restorePackageOnCancel: vi.fn().mockResolvedValue({ restored: true }),
}));

const fakeMongoSession = {}; // apenas repassado adiante, não usado diretamente pelos mocks

function mockAppointmentFindById(doc) {
  Appointment.findById.mockReturnValue({
    populate: vi.fn().mockReturnValue({
      session: vi.fn().mockResolvedValue(doc),
    }),
  });
}

function mockAppointmentUpdate(doc) {
  Appointment.findByIdAndUpdate.mockReturnValue({
    populate: vi.fn().mockResolvedValue(doc),
  });
}

function makeSessionDoc(overrides = {}) {
  return {
    _id: 'session-1',
    status: 'scheduled',
    paymentStatus: 'unpaid',
    isPaid: false,
    save: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function mockPaymentFind(payments) {
  Payment.find.mockReturnValue({
    session: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(payments)
    })
  });
}

// 🚨 FIX (2026-08-15): faltava mock de Payment.findById — desde a migração pra
// PaymentLifecycleService.cancelPayment (PR C.1, "usa lifecycle centralizado"),
// o cancelamento de Payment não passa mais por Payment.findByIdAndUpdate; ele
// busca via Payment.findById (chamado 1x dentro de cancelPayment, 1x de novo
// dentro de transitionPaymentStatus) e persiste via payment.save(). Sem esse
// mock, `query.session(mongoSession)` estourava "Cannot read properties of
// undefined" porque Payment.findById (vi.fn() sem retorno configurado)
// devolvia undefined.
function mockPaymentFindById(doc) {
  const fullDoc = { canceledAt: null, canceledReason: null, save: vi.fn().mockResolvedValue(true), ...doc };
  const queryLike = {
    session: vi.fn().mockReturnThis(),
    then: (resolve) => resolve(fullDoc),
  };
  Payment.findById.mockReturnValue(queryLike);
  return fullDoc;
}

function makeAppointment(overrides = {}) {
  return {
    _id: 'appt-1',
    operationalStatus: 'scheduled',
    serviceType: 'package_session',
    package: 'pkg-1',
    session: { _id: 'session-1' },
    payment: null,
    paymentOrigin: undefined,
    sessionValue: 100,
    patient: { _id: 'patient-1' },
    doctor: { _id: 'doctor-1' },
    ...overrides,
  };
}

describe('cancelAppointmentCommand.executeWithSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Payment.find.mockReturnValue({ session: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }) });
    Payment.findByIdAndUpdate.mockResolvedValue(true);
    Package.findByIdAndUpdate.mockResolvedValue(true);
    mockAppointmentUpdate(makeAppointment({ operationalStatus: 'canceled' }));
  });

  it('cenário 6 — $pull usa Session._id em `sessions` e Appointment._id em `appointments`', async () => {
    const appt = makeAppointment({ session: { _id: 'session-XYZ' }, _id: 'appt-XYZ' });
    mockAppointmentFindById(appt);
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc({ _id: 'session-XYZ' })) });

    await executeWithSession('appt-XYZ', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    const pullCall = Package.findByIdAndUpdate.mock.calls.find(c => c[1].$pull);
    expect(pullCall).toBeDefined();
    expect(pullCall[1].$pull).toEqual({ sessions: 'session-XYZ', appointments: 'appt-XYZ' });
  });

  it('cenário 1/2 — package_session: chama restorePackageOnCancel com appointmentStatus/paymentOrigin/sessionValue corretos', async () => {
    const appt = makeAppointment({ operationalStatus: 'completed', paymentOrigin: 'package_prepaid', sessionValue: 175 });
    mockAppointmentFindById(appt);
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc()) });

    await executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(restorePackageOnCancel).toHaveBeenCalledWith('pkg-1', expect.objectContaining({
      appointmentStatus: 'completed',
      paymentOrigin: 'package_prepaid',
      sessionValue: 175,
      mongoSession: fakeMongoSession,
    }));
  });

  it('cenário 3 — pacote por sessão: appointmentStatus repassado é o valor PRÉ-cancelamento, não "canceled"', async () => {
    const appt = makeAppointment({ operationalStatus: 'confirmed', paymentOrigin: 'auto_per_session' });
    mockAppointmentFindById(appt);
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc()) });

    await executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(restorePackageOnCancel).toHaveBeenCalledWith('pkg-1', expect.objectContaining({ appointmentStatus: 'confirmed' }));
  });

  it('pacote pré-pago: Payment kind=package_receipt NUNCA é cancelado ao cancelar uma sessão do pacote', async () => {
    const appt = makeAppointment({ payment: 'pay-1' });
    mockAppointmentFindById(appt);
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc()) });
    mockPaymentFind([
      { _id: 'pay-1', status: 'paid', kind: 'package_receipt' }
    ]);

    await executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(Payment.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('sessão avulsa (sem package): não chama restorePackageOnCancel nem mexe em Package', async () => {
    const appt = makeAppointment({ serviceType: 'session', package: null, payment: 'pay-1' });
    mockAppointmentFindById(appt);
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc()) });
    mockPaymentFind([
      { _id: 'pay-1', status: 'paid', kind: 'appointment_payment' }
    ]);
    const paymentDoc = mockPaymentFindById({ _id: 'pay-1', status: 'paid' });

    await executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(restorePackageOnCancel).not.toHaveBeenCalled();
    expect(Package.findByIdAndUpdate).not.toHaveBeenCalled();
    // avulso: Payment não-package_receipt é cancelado normalmente — via
    // PaymentLifecycleService.cancelPayment (não mais Payment.findByIdAndUpdate)
    expect(paymentDoc.status).toBe('canceled');
    expect(paymentDoc.save).toHaveBeenCalled();
  });

  it('cancela TODOS os Payments ativos vinculados à mesma session, não apenas appointment.payment', async () => {
    const appt = makeAppointment({
      serviceType: 'session',
      package: null,
      session: { _id: 'session-duplicada' },
      payment: 'pay-legado'
    });
    mockAppointmentFindById(appt);
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc({ _id: 'session-duplicada' })) });

    // appointment.payment aponta para pay-legado (cancelado), mas a query por
    // Payments ativos da mesma session retorna pay-ativo — que deve ser cancelado.
    mockPaymentFind([
      { _id: 'pay-ativo', status: 'pending', kind: 'session_payment' },
    ]);
    const paymentDoc = mockPaymentFindById({ _id: 'pay-ativo', status: 'pending' });

    await executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    // pay-legado (apontado por appointment.payment) NUNCA aparece na query de
    // Payments ativos (mockPaymentFind só retorna pay-ativo) — só pay-ativo é cancelado.
    expect(paymentDoc._id).toBe('pay-ativo');
    expect(paymentDoc.status).toBe('canceled');
    expect(paymentDoc.save).toHaveBeenCalledTimes(2); // 1x em transitionPaymentStatus, 1x em cancelPayment (canceledAt/canceledReason)
  });

  it('idempotência: appointment já canceled retorna sem tocar em Session/Payment/Package', async () => {
    mockAppointmentFindById(makeAppointment({ operationalStatus: 'canceled' }));

    const result = await executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(result.operationalStatus).toBe('canceled');
    expect(restorePackageOnCancel).not.toHaveBeenCalled();
    expect(Session.findById).not.toHaveBeenCalled();
  });

  // 🚨 Guardas de convênio (2026-08-15, auditoria do fluxo Convênio/card da guia)
  describe('guardas de convênio', () => {
    it('convênio completed: bloqueia com 409 CONVENIO_CANNOT_CANCEL_COMPLETED, zero mutação', async () => {
      const appt = makeAppointment({
        billingType: 'convenio',
        operationalStatus: 'completed',
        serviceType: 'session',
        package: null,
      });
      mockAppointmentFindById(appt);
      mockPaymentFind([]);

      await expect(
        executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession)
      ).rejects.toMatchObject({ code: 'CONVENIO_CANNOT_CANCEL_COMPLETED', status: 409 });

      expect(Session.findById).not.toHaveBeenCalled();
      expect(Appointment.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(Payment.findById).not.toHaveBeenCalled();
    });

    it('convênio com Payment faturado: bloqueia com 409 CONVENIO_CANCEL_BLOCKED_NON_REVERSIBLE_PAYMENT, zero mutação', async () => {
      const appt = makeAppointment({
        billingType: 'convenio',
        operationalStatus: 'scheduled',
        serviceType: 'session',
        package: null,
        payment: 'pay-1',
      });
      mockAppointmentFindById(appt);
      mockPaymentFind([
        { _id: 'pay-1', status: 'pending', insurance: { status: 'billed', billedAt: new Date() } },
      ]);

      await expect(
        executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession)
      ).rejects.toMatchObject({ code: 'CONVENIO_CANCEL_BLOCKED_NON_REVERSIBLE_PAYMENT', status: 409 });

      expect(Session.findById).not.toHaveBeenCalled();
      expect(Appointment.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(Payment.findById).not.toHaveBeenCalled(); // nunca chegou a tentar cancelar o Payment
    });

    it('convênio pendente com Payment reversível: cancela normalmente (guarda não afeta o caminho feliz)', async () => {
      const appt = makeAppointment({
        billingType: 'convenio',
        operationalStatus: 'scheduled',
        serviceType: 'session',
        package: null,
        payment: 'pay-1',
      });
      mockAppointmentFindById(appt);
      Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc()) });
      mockPaymentFind([
        { _id: 'pay-1', status: 'pending', insurance: { status: 'pending' } },
      ]);
      const paymentDoc = mockPaymentFindById({ _id: 'pay-1', status: 'pending' });

      const result = await executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

      expect(result.operationalStatus).toBe('canceled');
      expect(paymentDoc.status).toBe('canceled');
    });

    it('convênio LEGADO sem billingType (identificado só por insuranceGuide): guarda de completed ainda bloqueia — isInsuranceAppointment, não billingType===convenio', async () => {
      // 🚨 FIX (review 2026-08-15, bloqueador 1): billingType==='convenio' sozinho
      // não pegava convênio legado sem esse campo preenchido corretamente —
      // isInsuranceAppointment (utils/appointmentMapper.js) também classifica
      // por paymentMethod/insuranceProvider/insuranceGuide.
      const appt = makeAppointment({
        billingType: undefined,
        paymentMethod: undefined,
        insuranceProvider: undefined,
        insuranceGuide: 'guide-legado-1',
        operationalStatus: 'completed',
        serviceType: 'session',
        package: null,
      });
      mockAppointmentFindById(appt);
      mockPaymentFind([]);

      await expect(
        executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession)
      ).rejects.toMatchObject({ code: 'CONVENIO_CANNOT_CANCEL_COMPLETED', status: 409 });

      expect(Appointment.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('convênio LEGADO identificado só por paymentMethod (sem billingType): guarda de Payment avançado também bloqueia', async () => {
      const appt = makeAppointment({
        billingType: undefined,
        paymentMethod: 'convenio',
        insuranceProvider: undefined,
        insuranceGuide: undefined,
        operationalStatus: 'scheduled',
        serviceType: 'session',
        package: null,
        payment: 'pay-1',
      });
      mockAppointmentFindById(appt);
      mockPaymentFind([
        { _id: 'pay-1', status: 'pending', insurance: { status: 'received', receivedAmount: 80 } },
      ]);

      await expect(
        executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession)
      ).rejects.toMatchObject({ code: 'CONVENIO_CANCEL_BLOCKED_NON_REVERSIBLE_PAYMENT', status: 409 });
    });

    it('particular/pacote completed: NÃO é bloqueado — comportamento intencional preservado (fora de escopo)', async () => {
      const appt = makeAppointment({
        billingType: 'particular',
        operationalStatus: 'completed',
        serviceType: 'package_session',
      });
      mockAppointmentFindById(appt);
      Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc()) });

      const result = await executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

      expect(result.operationalStatus).toBe('canceled');
    });
  });
});
