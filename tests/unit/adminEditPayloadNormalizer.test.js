/**
 * 🧪 Testes unitários - Normalização de payload do admin-edit
 *
 * Garante que a Agenda Externa pode enviar campos no seu formato natural
 * e a rota PATCH /api/v2/appointments/:id/admin-edit os converte para
 * o formato esperado por updateAppointmentCommand.
 */

import { describe, it, expect } from 'vitest';
import { normalizeAdminEditPayload } from '../../utils/adminEditPayloadNormalizer.js';

describe('normalizeAdminEditPayload', () => {
  it('mapeia patientId → patient', () => {
    const result = normalizeAdminEditPayload({ patientId: '507f1f77bcf86cd799439011' });
    expect(result.patient).toBe('507f1f77bcf86cd799439011');
    expect(result.patientId).toBeUndefined();
  });

  it('mapeia professionalId → doctorId', () => {
    const result = normalizeAdminEditPayload({ professionalId: 'doc123' });
    expect(result.doctorId).toBe('doc123');
    expect(result.professionalId).toBeUndefined();
  });

  it('preserva doctorId se já existir', () => {
    const result = normalizeAdminEditPayload({ doctorId: 'doc456', professionalId: 'doc123' });
    expect(result.doctorId).toBe('doc456');
  });

  it('mapeia specialtyKey → specialty', () => {
    const result = normalizeAdminEditPayload({ specialtyKey: 'psicologia' });
    expect(result.specialty).toBe('psicologia');
    expect(result.specialtyKey).toBeUndefined();
  });

  it('preserva specialty se já existir', () => {
    const result = normalizeAdminEditPayload({ specialty: 'fonoaudiologia', specialtyKey: 'psicologia' });
    expect(result.specialty).toBe('fonoaudiologia');
  });

  it('agrupa dados do paciente em patientInfo', () => {
    const result = normalizeAdminEditPayload({
      patientName: 'João Silva',
      phone: '11999998888',
      birthDate: '1990-05-15',
      email: 'joao@email.com',
    });

    expect(result.patientInfo).toEqual({
      fullName: 'João Silva',
      phone: '11999998888',
      birthDate: '1990-05-15',
      email: 'joao@email.com',
    });
  });

  it('mapeia observations → notes', () => {
    const result = normalizeAdminEditPayload({ observations: 'observação de teste' });
    expect(result.notes).toBe('observação de teste');
    expect(result.observations).toBeUndefined();
  });

  it('preserva notes se já existir', () => {
    const result = normalizeAdminEditPayload({ notes: 'nota original', observations: 'observação nova' });
    expect(result.notes).toBe('observação nova');
  });

  it('mantém adminReason e outros campos', () => {
    const result = normalizeAdminEditPayload({
      adminReason: 'Edição via modal',
      date: '2026-07-10',
      time: '14:00',
      operationalStatus: 'completed',
    });

    expect(result.adminReason).toBe('Edição via modal');
    expect(result.date).toBe('2026-07-10');
    expect(result.time).toBe('14:00');
    expect(result.operationalStatus).toBe('completed');
  });

  it('não inclui patientInfo quando não há dados de paciente', () => {
    const result = normalizeAdminEditPayload({ date: '2026-07-10' });
    expect(result.patientInfo).toBeUndefined();
  });

  it('ignora corpo nulo/undefined', () => {
    expect(normalizeAdminEditPayload(null)).toEqual({});
    expect(normalizeAdminEditPayload(undefined)).toEqual({});
  });
});
