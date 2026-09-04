import { describe, expect, it } from 'vitest';
import Appointment from '../../models/Appointment.js';
import { mapAppointmentDTO } from '../../utils/appointmentDto.js';
import {
  APPOINTMENT_CLIENT_FIELD_NAMES,
  pickAppointmentClientFields,
} from '../../services/appointment/contracts/appointmentClientFields.js';
import { sanitizeAppointmentPayload } from '../../services/appointment/commands/_helpers.js';

describe('contrato único de campos simples do Appointment', () => {
  it('só repassa campos declarados e bloqueia mass assignment', () => {
    const picked = pickAppointmentClientFields({
      responsible: 'Raquel',
      preferredPeriod: 'tarde',
      paymentStatus: 'paid',
      isPaid: true,
      operationalStatus: 'completed',
      __allowFinancialConversion: true,
    });

    expect(picked).toEqual({ responsible: 'Raquel', preferredPeriod: 'tarde' });
  });

  it('aceita o envelope clientFields e prefere seu valor ao legado top-level', () => {
    expect(pickAppointmentClientFields({
      responsible: 'Valor legado',
      clientFields: {
        responsible: 'Raquel',
        preferredPeriod: 'tarde',
        metadata: {
          origin: {
            source: 'agenda_externa',
            convertedBy: '507f1f77bcf86cd799439011',
            convertedAt: new Date(),
          },
        },
        paymentStatus: 'paid',
        __allowFinancialConversion: true,
      },
    })).toEqual({
      responsible: 'Raquel',
      preferredPeriod: 'tarde',
      metadata: { origin: { source: 'agenda_externa' } },
    });
  });

  it('expande o envelope no update sem propagar o envelope ou campos proibidos', () => {
    const safe = sanitizeAppointmentPayload({
      notes: 'Observação preservada',
      clientFields: {
        responsible: 'Raquel',
        preferredPeriod: 'tarde',
        paymentStatus: 'paid',
        __allowFinancialConversion: true,
      },
    });

    expect(safe).toEqual({
      notes: 'Observação preservada',
      responsible: 'Raquel',
      preferredPeriod: 'tarde',
    });
    expect(safe).not.toHaveProperty('clientFields');
  });

  it('todo campo contratado existe no schema Appointment', () => {
    for (const field of APPOINTMENT_CLIENT_FIELD_NAMES) {
      const exists = Appointment.schema.path(field) || Appointment.schema.pathType(field) === 'nested';
      expect(Boolean(exists), `${field} ausente no schema`).toBe(true);
    }
  });

  it('o DTO expõe todos os campos contratados com os mesmos valores', () => {
    const values = {
      responsible: 'Raquel',
      sessionType: 'fonoaudiologia',
      preferredPeriod: 'tarde',
      metadata: { origin: { source: 'agenda_externa' } },
      insuranceProvider: 'unimed-anapolis',
      insuranceValue: 80,
      authorizationCode: 'AUT-123',
    };

    const dto = mapAppointmentDTO({
      _id: '507f1f77bcf86cd799439011',
      specialty: 'fonoaudiologia',
      ...values,
    });

    expect(Object.fromEntries(
      APPOINTMENT_CLIENT_FIELD_NAMES.map(field => [field, dto[field]])
    )).toEqual(values);
  });

  it('preserva os defaults públicos anteriores do DTO', () => {
    const dto = mapAppointmentDTO({ specialty: 'fonoaudiologia' });

    expect(dto).toMatchObject({
      responsible: '',
      sessionType: null,
      preferredPeriod: null,
      metadata: null,
      insuranceProvider: null,
      insuranceValue: 0,
      authorizationCode: null,
    });
  });
});

describe('deposit and balance read contract', () => {
  it('exposes the received deposit and canonical balance without changing sessionValue', () => {
    const dto = mapAppointmentDTO(
      { sessionValue: 500, billingType: 'particular' },
      { depositAmount: 50 }
    );

    expect(dto).toMatchObject({
      sessionValue: 500,
      depositAmount: 50,
      remainingAmount: 450,
    });
  });

  it('keeps the legacy read contract when there is no deposit', () => {
    const dto = mapAppointmentDTO({ sessionValue: 500, billingType: 'particular' });

    expect(dto).toMatchObject({
      sessionValue: 500,
      depositAmount: 0,
      remainingAmount: null,
    });
  });

  it('returns zero remaining after the balance is also paid', () => {
    const dto = mapAppointmentDTO(
      { sessionValue: 500, billingType: 'particular' },
      { depositAmount: 50, paidTotal: 500 }
    );

    expect(dto.remainingAmount).toBe(0);
  });
});
