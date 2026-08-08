import { describe, expect, it } from 'vitest';
import { buildInsuranceAppointmentDocument } from '../../services/billing/insuranceBilling.js';

const guide = {
  insurance: 'unimed-oficial',
  number: 'GUIA-OFICIAL',
};

function input(overrides = {}) {
  return {
    patientId: '507f1f77bcf86cd799439011',
    doctorId: '507f191e810c19729de860ea',
    specialty: 'fonoaudiologia',
    date: '2026-08-10',
    time: '14:00',
    operationalStatus: 'pre_agendado',
    clientFields: {
      responsible: 'Raquel',
      preferredPeriod: 'tarde',
      sessionType: 'fonoaudiologia',
      insuranceProvider: 'valor-forjado-pelo-cliente',
      insuranceValue: 999,
      authorizationCode: 'AUT-FORJADA',
      paymentStatus: 'paid',
      __allowFinancialConversion: true,
    },
    ...overrides,
  };
}

describe('criação de Appointment de convênio', () => {
  it('persiste campos simples, mas preserva dados financeiros autoritativos da guia', () => {
    const document = buildInsuranceAppointmentDocument(input(), guide, 'session-id');

    expect(document).toMatchObject({
      responsible: 'Raquel',
      preferredPeriod: 'tarde',
      sessionType: 'fonoaudiologia',
      operationalStatus: 'pre_agendado',
      billingType: 'convenio',
      paymentStatus: 'pending',
      insuranceProvider: 'unimed-oficial',
      insuranceValue: 0,
      authorizationCode: 'GUIA-OFICIAL',
    });
    expect(document).not.toHaveProperty('__allowFinancialConversion');
  });

  it('mantém scheduled solicitado pelo CRM e descarta sessionType inválido', () => {
    const document = buildInsuranceAppointmentDocument(input({
      operationalStatus: 'scheduled',
      clientFields: { sessionType: 'avaliacao' },
    }), guide, 'session-id');

    expect(document.operationalStatus).toBe('scheduled');
    expect(document).not.toHaveProperty('sessionType');
  });
});
