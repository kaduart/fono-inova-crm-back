// tests/unit/guideLifecycle/insuranceGuidesApi.test.js
import { describe, it, expect } from 'vitest';
import { buildGuideResponse } from '../../../services/guideLifecycle/guideResponseBuilder.js';

const date = (str) => new Date(`${str}T00:00:00.000Z`);

/**
 * Testes de contrato da API Sprint 2.
 *
 * Validam que buildGuideResponse retorna exatamente:
 * { guide, lifecycle }
 *
 * Sem depender de MongoDB, Express ou autenticação.
 */
describe('InsuranceGuides API Response (Sprint 2)', () => {
  it('retorna formato { guide, lifecycle } para guia ativa válida', async () => {
    const rawGuide = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      number: '123456',
      patientId: { _id: { toString: () => '607f1f77bcf86cd799439022' }, fullName: 'Paciente Teste' },
      insurance: 'bradesco-saude',
      specialty: 'psicologia',
      totalSessions: 10,
      usedSessions: 3,
      status: 'active',
      expiresAt: date('2026-07-31'),
      sessionValue: 100,
      doctorId: { _id: { toString: () => '707f1f77bcf86cd799439033' }, fullName: 'Dr. Teste' },
      createdAt: date('2026-07-01'),
    };

    const convenio = {
      guidePolicy: {
        renewalType: 'end_of_month',
        renewalDay: 'last_day',
        expirationWarningDays: 5
      },
      defaultSessions: 8
    };

    const result = await buildGuideResponse(rawGuide, convenio);

    expect(result).toHaveProperty('guide');
    expect(result).toHaveProperty('lifecycle');

    expect(result.guide._id).toBe('507f1f77bcf86cd799439011');
    expect(result.guide.number).toBe('123456');
    expect(result.guide.insurance).toBe('bradesco-saude');
    expect(result.guide.guidePolicy).toEqual(convenio.guidePolicy);
    expect(result.guide.defaultSessions).toBe(8);

    expect(result.lifecycle.state.status).toBe('active');
    expect(result.lifecycle.eligibility.canSchedule).toBe(true);
    expect(result.lifecycle.eligibility.canBill).toBe(true);
    expect(result.lifecycle.eligibility.canRenew).toBe(false);
    expect(result.lifecycle.eligibility.canEdit).toBe(true);
    expect(result.lifecycle.eligibility.canBeSuperseded).toBe(true);
    expect(result.lifecycle.alerts).toHaveLength(0);
  });

  it('retorna lifecycle com alerta quando guia está próxima do vencimento', async () => {
    const rawGuide = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      number: '123456',
      patientId: '607f1f77bcf86cd799439022',
      insurance: 'bradesco-saude',
      specialty: 'psicologia',
      totalSessions: 10,
      usedSessions: 3,
      status: 'active',
      expiresAt: date('2026-07-31'),
      createdAt: date('2026-07-01'),
    };

    const convenio = {
      guidePolicy: {
        renewalType: 'end_of_month',
        expirationWarningDays: 5
      }
    };

    const today = date('2026-07-26');
    const result = await buildGuideResponse(rawGuide, convenio, today);

    expect(result.lifecycle.eligibility.canRenew).toBe(true);
    expect(result.lifecycle.alerts[0].code).toBe('EXPIRING_SOON');
    expect(result.lifecycle.alerts[0].severity).toBe('warning');
  });

  it('retorna lifecycle bloqueado quando guia está vencida', async () => {
    const rawGuide = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      number: '123456',
      patientId: '607f1f77bcf86cd799439022',
      insurance: 'bradesco-saude',
      specialty: 'psicologia',
      totalSessions: 10,
      usedSessions: 3,
      status: 'active',
      expiresAt: date('2026-07-31'),
      createdAt: date('2026-07-01'),
    };

    const convenio = {
      guidePolicy: {
        renewalType: 'end_of_month',
        expirationWarningDays: 5
      }
    };

    const today = date('2026-08-05');
    const result = await buildGuideResponse(rawGuide, convenio, today);

    expect(result.lifecycle.eligibility.canSchedule).toBe(false);
    expect(result.lifecycle.eligibility.canBill).toBe(false);
    expect(result.lifecycle.alerts[0].code).toBe('EXPIRED');
    expect(result.lifecycle.alerts[0].severity).toBe('error');
  });

  it('retorna lifecycle para guia until_consumed esgotada', async () => {
    const rawGuide = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      number: '123456',
      patientId: '607f1f77bcf86cd799439022',
      insurance: 'unimed-anapolis',
      specialty: 'psicologia',
      totalSessions: 10,
      usedSessions: 10,
      status: 'active',
      createdAt: date('2026-07-01'),
    };

    const convenio = {
      guidePolicy: {
        renewalType: 'until_consumed'
      }
    };

    const result = await buildGuideResponse(rawGuide, convenio);

    expect(result.lifecycle.eligibility.canSchedule).toBe(false);
    expect(result.lifecycle.eligibility.canRenew).toBe(true);
    expect(result.lifecycle.alerts[0].code).toBe('EXHAUSTED');
    expect(result.lifecycle.alerts[0].severity).toBe('error');
  });

  it('retorna formato correto mesmo sem guidePolicy (fallback com política vazia)', async () => {
    const rawGuide = {
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      number: '123456',
      patientId: '607f1f77bcf86cd799439022',
      insurance: 'convenio-desconhecido',
      specialty: 'psicologia',
      totalSessions: 10,
      usedSessions: 3,
      status: 'active',
      createdAt: date('2026-07-01'),
    };

    // Passando política vazia para evitar query no banco em teste unitário
    const result = await buildGuideResponse(rawGuide, { guidePolicy: {} });

    expect(result).toHaveProperty('guide');
    expect(result).toHaveProperty('lifecycle');
    expect(result.guide.guidePolicy).toEqual({});
    expect(result.lifecycle.eligibility.canSchedule).toBe(true);
  });
});
