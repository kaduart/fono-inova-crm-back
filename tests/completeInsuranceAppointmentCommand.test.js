/**
 * 🛡️ Testes unitários — completeInsuranceAppointmentCommand
 *
 * Validam o orquestrador de fluxo composto de convênio:
 * - FSM: scheduled → confirmed → completed
 * - recuperação de cancelamento
 * - idempotência
 * - rejeição de agendamentos não-convênio
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { completeSessionV2 } from '../services/completeSessionService.v2.js';
import { recordAudit } from '../services/auditLogService.js';
import Appointment from '../models/Appointment.js';
import { execute } from '../services/appointment/commands/completeInsuranceAppointmentCommand.js';

vi.mock('../models/Appointment.js', () => ({
  default: {
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../services/completeSessionService.v2.js', () => ({
  completeSessionV2: vi.fn(),
}));

vi.mock('../services/auditLogService.js', () => ({
  recordAudit: vi.fn(),
}));

function makeAppointment(overrides = {}) {
  return {
    _id: 'appt-123',
    operationalStatus: 'scheduled',
    clinicalStatus: 'pending',
    billingType: 'convenio',
    paymentMethod: 'convenio',
    insuranceProvider: 'Unimed',
    ...overrides,
  };
}

function mockFindById(returnValue) {
  Appointment.findById.mockReturnValue({
    lean: vi.fn().mockResolvedValue(returnValue),
  });
}

describe('completeInsuranceAppointmentCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retorna idempotente quando appointment já está completed', async () => {
    mockFindById(makeAppointment({ operationalStatus: 'completed' }));

    const result = await execute('appt-123', { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.idempotent).toBe(true);
    expect(Appointment.findOneAndUpdate).not.toHaveBeenCalled();
    expect(completeSessionV2).not.toHaveBeenCalled();
  });

  it('executa scheduled → confirmed → completed', async () => {
    mockFindById(makeAppointment({ operationalStatus: 'scheduled' }));
    Appointment.findOneAndUpdate.mockResolvedValue(makeAppointment({ operationalStatus: 'confirmed' }));
    completeSessionV2.mockResolvedValue({
      success: true,
      billingType: 'convenio',
      paymentId: 'pay-1',
      sessionId: 'sess-1',
    });

    const result = await execute('appt-123', { userId: 'user-1' });

    expect(Appointment.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(Appointment.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'appt-123', operationalStatus: 'scheduled' }),
      expect.objectContaining({
        $set: expect.objectContaining({ operationalStatus: 'confirmed' }),
      }),
      { new: true }
    );
    expect(completeSessionV2).toHaveBeenCalledWith(
      'appt-123',
      expect.objectContaining({ userId: 'user-1' })
    );
    expect(result.transitions).toHaveLength(2);
    expect(result.transitions[0]).toMatchObject({ from: 'scheduled', to: 'confirmed' });
    expect(result.transitions[1]).toMatchObject({ from: 'confirmed', to: 'completed' });
    expect(result.success).toBe(true);
  });

  it('recupera canceled → scheduled → confirmed → completed', async () => {
    mockFindById(makeAppointment({ operationalStatus: 'canceled' }));
    Appointment.findOneAndUpdate
      .mockResolvedValueOnce(makeAppointment({ operationalStatus: 'scheduled' }))
      .mockResolvedValueOnce(makeAppointment({ operationalStatus: 'confirmed' }));
    completeSessionV2.mockResolvedValue({
      success: true,
      billingType: 'convenio',
      paymentId: 'pay-1',
      sessionId: 'sess-1',
    });

    const result = await execute('appt-123', { userId: 'user-1' });

    expect(Appointment.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(result.transitions).toHaveLength(3);
    expect(result.transitions[0]).toMatchObject({ from: 'canceled', to: 'scheduled' });
    expect(result.transitions[1]).toMatchObject({ from: 'scheduled', to: 'confirmed' });
    expect(result.transitions[2]).toMatchObject({ from: 'confirmed', to: 'completed' });
    expect(completeSessionV2).toHaveBeenCalled();
  });

  it('rejeita agendamento que não é de convênio', async () => {
    mockFindById(makeAppointment({ billingType: 'particular', paymentMethod: 'pix', insuranceProvider: null }));

    await expect(execute('appt-123', { userId: 'user-1' })).rejects.toMatchObject({ code: 'NOT_INSURANCE_APPOINTMENT' });
    expect(completeSessionV2).not.toHaveBeenCalled();
  });

  it('rejeita estado não recuperável (ex: missed)', async () => {
    mockFindById(makeAppointment({ operationalStatus: 'missed' }));

    await expect(execute('appt-123', { userId: 'user-1' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(completeSessionV2).not.toHaveBeenCalled();
  });

  it('pula confirmação quando appointment já está confirmed', async () => {
    mockFindById(makeAppointment({ operationalStatus: 'confirmed' }));
    completeSessionV2.mockResolvedValue({
      success: true,
      billingType: 'convenio',
      paymentId: 'pay-1',
      sessionId: 'sess-1',
    });

    const result = await execute('appt-123', { userId: 'user-1' });

    expect(Appointment.findOneAndUpdate).not.toHaveBeenCalled();
    expect(completeSessionV2).toHaveBeenCalled();
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]).toMatchObject({ from: 'confirmed', to: 'completed' });
  });
});
