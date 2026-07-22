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
  default: { findById: vi.fn(), findByIdAndUpdate: vi.fn() },
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
    Payment.findById.mockReturnValue({
      session: vi.fn().mockResolvedValue({ _id: 'pay-1', status: 'paid', kind: 'package_receipt' }),
    });

    await executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(Payment.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('sessão avulsa (sem package): não chama restorePackageOnCancel nem mexe em Package', async () => {
    const appt = makeAppointment({ serviceType: 'session', package: null, payment: 'pay-1' });
    mockAppointmentFindById(appt);
    Session.findById.mockReturnValue({ session: vi.fn().mockResolvedValue(makeSessionDoc()) });
    Payment.findById.mockReturnValue({
      session: vi.fn().mockResolvedValue({ _id: 'pay-1', status: 'paid', kind: 'appointment_payment' }),
    });

    await executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(restorePackageOnCancel).not.toHaveBeenCalled();
    expect(Package.findByIdAndUpdate).not.toHaveBeenCalled();
    // avulso: Payment não-package_receipt é cancelado normalmente
    expect(Payment.findByIdAndUpdate).toHaveBeenCalled();
  });

  it('idempotência: appointment já canceled retorna sem tocar em Session/Payment/Package', async () => {
    mockAppointmentFindById(makeAppointment({ operationalStatus: 'canceled' }));

    const result = await executeWithSession('appt-1', { reason: 'teste' }, { _id: 'user-1' }, fakeMongoSession);

    expect(result.operationalStatus).toBe('canceled');
    expect(restorePackageOnCancel).not.toHaveBeenCalled();
    expect(Session.findById).not.toHaveBeenCalled();
  });
});
