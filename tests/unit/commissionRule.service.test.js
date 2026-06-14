/**
 * Testes unitários para o motor de regras de comissão.
 */

import { describe, it, expect } from 'vitest';
import {
  classifySessionForCommission,
  findApplicableCommissionRule,
  calculateSessionCommission,
  calculateCommissionBatch
} from '../../services/commissionRule.service.js';

describe('commissionRule.service', () => {
  const doctor = {
    specialty: 'fonoaudiologia',
    commissionRules: {
      standardSession: 60,
      evaluationSession: 80,
      neuropsychEvaluation: 1200,
      rules: [
        {
          _id: 'r1',
          serviceType: 'session',
          billingType: 'particular',
          commissionType: 'fixed',
          value: 65,
          active: true
        },
        {
          _id: 'r2',
          serviceType: 'session',
          billingType: 'convenio',
          insurance: 'unimed',
          commissionType: 'fixed',
          value: 45,
          active: true
        },
        {
          _id: 'r3',
          serviceType: 'session',
          billingType: 'convenio',
          insurance: 'bradesco',
          commissionType: 'percentage',
          value: 40,
          active: true
        },
        {
          _id: 'r4',
          serviceType: 'evaluation',
          billingType: 'particular',
          commissionType: 'fixed',
          value: 100,
          active: true
        }
      ]
    }
  };

  it('classifica sessão particular', () => {
    const session = { paymentMethod: 'particular', sessionValue: 120 };
    expect(classifySessionForCommission(session)).toEqual({
      billingType: 'particular',
      serviceType: 'session',
      insurance: null
    });
  });

  it('classifica sessão de convênio unimed', () => {
    const session = {
      paymentMethod: 'convenio',
      sessionValue: 120,
      insuranceGuide: { insurance: 'unimed' }
    };
    expect(classifySessionForCommission(session)).toEqual({
      billingType: 'convenio',
      serviceType: 'session',
      insurance: 'unimed'
    });
  });

  it('encontra regra fixa para particular', () => {
    const session = { paymentMethod: 'particular', sessionValue: 120 };
    const rule = findApplicableCommissionRule(doctor, session);
    expect(rule).toMatchObject({ _id: 'r1', commissionType: 'fixed', value: 65 });
  });

  it('encontra regra específica por convênio', () => {
    const session = {
      paymentMethod: 'convenio',
      sessionValue: 120,
      insuranceGuide: { insurance: 'unimed' }
    };
    const rule = findApplicableCommissionRule(doctor, session);
    expect(rule).toMatchObject({ _id: 'r2', commissionType: 'fixed', value: 45 });
  });

  it('calcula percentual para convênio bradesco', () => {
    const session = {
      paymentMethod: 'convenio',
      sessionValue: 200,
      insuranceGuide: { insurance: 'bradesco' }
    };
    const commission = calculateSessionCommission(doctor, session);
    expect(commission).toBe(80); // 40% de 200
  });

  it('calcula avaliação pela regra específica', () => {
    const session = { paymentMethod: 'particular', sessionValue: 200, sessionType: 'evaluation' };
    const commission = calculateSessionCommission(doctor, session);
    expect(commission).toBe(100);
  });

  it('retorna 0 quando não há regra configurada', () => {
    const docWithoutRules = { specialty: 'fonoaudiologia', commissionRules: { rules: [] } };
    const session = { paymentMethod: 'particular', sessionValue: 120 };
    const commission = calculateSessionCommission(docWithoutRules, session);
    expect(commission).toBe(0);
  });

  it('calcula neuropediatria com percentual padrão', () => {
    const neuropedDoctor = { specialty: 'neuroped', commissionRules: {} };
    const session = { paymentMethod: 'particular', sessionValue: 200 };
    const commission = calculateSessionCommission(neuropedDoctor, session);
    expect(commission).toBe(160); // 80% de 200
  });

  it('maior prioridade vence sobre regra menos específica', () => {
    const docWithPriority = {
      specialty: 'fonoaudiologia',
      commissionRules: {
        rules: [
          {
            _id: 'r_generica',
            serviceType: 'session',
            billingType: 'convenio',
            commissionType: 'fixed',
            value: 50,
            priority: 0,
            active: true
          },
          {
            _id: 'r_especifica',
            serviceType: 'session',
            billingType: 'convenio',
            insurance: 'unimed',
            commissionType: 'fixed',
            value: 90,
            priority: 10,
            active: true
          }
        ]
      }
    };

    const session = {
      paymentMethod: 'convenio',
      sessionValue: 200,
      insuranceGuide: { insurance: 'unimed' }
    };

    const rule = findApplicableCommissionRule(docWithPriority, session);
    expect(rule).toMatchObject({ _id: 'r_especifica', value: 90, priority: 10 });

    const commission = calculateSessionCommission(docWithPriority, session);
    expect(commission).toBe(90);
  });

  it('ignora regra inativa', () => {
    const docWithInactiveRule = {
      specialty: 'fonoaudiologia',
      commissionRules: {
        standardSession: 60,
        rules: [
          { _id: 'r1', serviceType: 'session', billingType: 'particular', commissionType: 'fixed', value: 999, active: false }
        ]
      }
    };
    const session = { paymentMethod: 'particular', sessionValue: 120 };
    const commission = calculateSessionCommission(docWithInactiveRule, session);
    expect(commission).toBe(0);
  });

  it('aplica regra percentual para neuropsicologia avulsa particular', () => {
    const doc = {
      specialty: 'psicologia',
      commissionRules: {
        rules: [
          {
            _id: 'r_neuro',
            serviceType: 'neuropsychological',
            billingType: 'particular',
            commissionType: 'percentage',
            value: 50,
            active: true
          }
        ]
      }
    };

    const session = { paymentMethod: 'particular', sessionType: 'neuropsychological', sessionValue: 500 };
    const commission = calculateSessionCommission(doc, session);
    expect(commission).toBe(250);
  });

  it('neuropsicologia em pacote retorna 0 (processada em batch)', () => {
    const doc = {
      specialty: 'psicologia',
      commissionRules: {
        rules: [
          {
            _id: 'r_neuro',
            serviceType: 'neuropsychological',
            billingType: 'particular',
            commissionType: 'percentage',
            value: 50,
            active: true
          }
        ]
      }
    };

    const session = { paymentMethod: 'particular', sessionType: 'neuropsychological', sessionValue: 500, package: { _id: 'pkg1' } };
    const commission = calculateSessionCommission(doc, session);
    expect(commission).toBe(0);
  });

  it('calcula batch com neuropsicologia completa', () => {
    const pkg = { _id: 'pkg1', totalSessions: 10, sessionType: 'neuropsych_evaluation' };
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      status: 'completed',
      paymentMethod: 'particular',
      sessionType: 'neuropsych_evaluation',
      sessionValue: 150,
      package: pkg
    }));

    const doc = {
      specialty: 'fonoaudiologia',
      commissionRules: { neuropsychEvaluation: 1200, rules: [] }
    };

    const { totalCommission } = calculateCommissionBatch(doc, sessions);
    expect(totalCommission).toBe(1200);
  });

  // ═════════════════════════════════════════════════════════════════
  // Sprint 3.10 — minValue / maxValue / effectiveDate
  // ═════════════════════════════════════════════════════════════════

  it('aplica regra com minValue (sessão acima do limiar)', () => {
    const doc = {
      specialty: 'fonoaudiologia',
      commissionRules: {
        standardSession: 60,
        rules: [
          { _id: 'r_barato', serviceType: 'session', billingType: 'particular', commissionType: 'fixed', value: 50, active: true, maxValue: 100 },
          { _id: 'r_caro', serviceType: 'session', billingType: 'particular', commissionType: 'fixed', value: 80, active: true, minValue: 101 }
        ]
      }
    };

    expect(calculateSessionCommission(doc, { paymentMethod: 'particular', sessionValue: 80 })).toBe(50);
    expect(calculateSessionCommission(doc, { paymentMethod: 'particular', sessionValue: 150 })).toBe(80);
  });

  it('aplica regra com effectiveDate futura apenas a partir da data', () => {
    const doc = {
      specialty: 'fonoaudiologia',
      commissionRules: {
        standardSession: 60,
        rules: [
          {
            _id: 'r_reajuste',
            serviceType: 'session',
            billingType: 'particular',
            commissionType: 'fixed',
            value: 100,
            active: true,
            effectiveDate: new Date('2026-07-01T00:00:00Z')
          }
        ]
      }
    };

    const sessionBefore = { paymentMethod: 'particular', sessionValue: 120, date: new Date('2026-06-15T00:00:00Z') };
    const sessionAfter = { paymentMethod: 'particular', sessionValue: 120, date: new Date('2026-07-15T00:00:00Z') };

    expect(calculateSessionCommission(doc, sessionBefore)).toBe(0);
    expect(calculateSessionCommission(doc, sessionAfter)).toBe(100);
  });

  it('effectiveDate vence sobre startDate em caso de empate', () => {
    const doc = {
      specialty: 'fonoaudiologia',
      commissionRules: {
        standardSession: 60,
        rules: [
          {
            _id: 'r_antiga',
            serviceType: 'session',
            billingType: 'particular',
            commissionType: 'fixed',
            value: 70,
            active: true,
            startDate: new Date('2026-01-01T00:00:00Z')
          },
          {
            _id: 'r_nova',
            serviceType: 'session',
            billingType: 'particular',
            commissionType: 'fixed',
            value: 90,
            active: true,
            startDate: new Date('2026-01-01T00:00:00Z'),
            effectiveDate: new Date('2026-06-01T00:00:00Z')
          }
        ]
      }
    };

    const session = { paymentMethod: 'particular', sessionValue: 120, date: new Date('2026-06-15T00:00:00Z') };
    const rule = findApplicableCommissionRule(doc, session);
    expect(rule).toMatchObject({ _id: 'r_nova', value: 90 });
  });
});
