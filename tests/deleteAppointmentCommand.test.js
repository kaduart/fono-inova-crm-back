/**
 * 🛡️ Testes unitários — deleteAppointmentCommand
 *
 * Cobre a guarda de integridade com InsuranceBatch (PR D.1):
 * - Deleção bloqueada quando Session ou Payment está em lote ativo.
 * - Deleção permitida quando não há vínculo ativo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import { execute } from '../services/appointment/commands/deleteAppointmentCommand.js';

vi.mock('../models/Appointment.js', () => ({
  default: { findById: vi.fn(), findByIdAndDelete: vi.fn() },
}));
vi.mock('../models/Session.js', () => ({
  default: { findByIdAndUpdate: vi.fn() },
}));
vi.mock('../models/Payment.js', () => ({
  default: { findById: vi.fn(), findByIdAndDelete: vi.fn() },
}));
vi.mock('../models/Patient.js', () => ({
  default: { findByIdAndUpdate: vi.fn() },
}));
vi.mock('../models/InsuranceBatch.js', () => ({
  default: { findOne: vi.fn() },
}));
vi.mock('../infrastructure/outbox/outboxPattern.js', () => ({
  saveToOutbox: vi.fn().mockResolvedValue(true),
}));
vi.mock('../utils/appointmentUpdater.js', () => ({
  updatePatientAppointments: vi.fn().mockResolvedValue(true),
}));
vi.mock('../services/auditLogService.js', () => ({
  recordAudit: vi.fn().mockResolvedValue(true),
}));
vi.mock('../utils/transactionRetry.js', () => ({
  runTransactionWithRetry: vi.fn(async (operation) => operation({})),
}));

function makeAppointment(overrides = {}) {
  return {
    _id: 'appt-1',
    patient: { _id: 'patient-1' },
    session: { _id: 'session-1' },
    payment: { _id: 'payment-1', kind: 'session_payment' },
    package: null,
    doctor: { _id: 'doctor-1' },
    date: new Date(),
    time: '10:00',
    toObject: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

function mockInsuranceBatchFindOne(result) {
  InsuranceBatch.findOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(result),
  });
}

describe('deleteAppointmentCommand.execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Appointment.findById.mockReturnValue({
      populate: vi.fn().mockResolvedValue(null),
    });
    Appointment.findByIdAndDelete.mockResolvedValue(true);
    Session.findByIdAndUpdate.mockResolvedValue(true);
    Payment.findById.mockResolvedValue(null);
    Payment.findByIdAndDelete.mockResolvedValue(true);
    Patient.findByIdAndUpdate.mockResolvedValue(true);
  });

  it('deve bloquear deleção quando Session está em lote ativo', async () => {
    const appt = makeAppointment();
    Appointment.findById.mockReturnValue({
      populate: vi.fn().mockResolvedValue(appt),
    });
    mockInsuranceBatchFindOne({ _id: 'batch-1', batchNumber: 'LOT-TEST-001' });

    await expect(execute('appt-1', { _id: 'user-1' }))
      .rejects
      .toThrow(/LOT-TEST-001/);

    expect(Appointment.findByIdAndDelete).not.toHaveBeenCalled();
    expect(Payment.findByIdAndDelete).not.toHaveBeenCalled();
  });

  it('deve bloquear deleção quando Payment está em lote ativo', async () => {
    const appt = makeAppointment({ session: null });
    Appointment.findById.mockReturnValue({
      populate: vi.fn().mockResolvedValue(appt),
    });
    mockInsuranceBatchFindOne({ _id: 'batch-2', batchNumber: 'LOT-TEST-002' });

    await expect(execute('appt-1', { _id: 'user-1' }))
      .rejects
      .toThrow(/LOT-TEST-002/);

    expect(Appointment.findByIdAndDelete).not.toHaveBeenCalled();
  });

  it('deve permitir deleção quando não há lote ativo', async () => {
    const appt = makeAppointment();
    Appointment.findById.mockReturnValue({
      populate: vi.fn().mockResolvedValue(appt),
    });
    mockInsuranceBatchFindOne(null);

    await execute('appt-1', { _id: 'user-1' });

    expect(Appointment.findByIdAndDelete).toHaveBeenCalled();
    expect(Payment.findByIdAndDelete).toHaveBeenCalled();
  });

  it('deve permitir deleção quando batch está em estado building (não protegido)', async () => {
    const appt = makeAppointment();
    Appointment.findById.mockReturnValue({
      populate: vi.fn().mockResolvedValue(appt),
    });
    mockInsuranceBatchFindOne(null);

    await execute('appt-1', { _id: 'user-1' });

    expect(Appointment.findByIdAndDelete).toHaveBeenCalled();
  });
});
