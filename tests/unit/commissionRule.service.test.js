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
  it('calcula 50% por atendimento mesmo em pacotes incompletos', () => {
    const doc = { commissionRules: { rules: [{
      serviceType: 'neuropsychological', billingType: 'particular',
      commissionType: 'percentage', value: 50, active: true
    }] } };
    const makeSessions = (id, totalValue, count = 3) => Array.from({ length: count }, () => ({
      package: { _id: id, sessionType: 'neuropsicologia', totalSessions: 3, totalValue, sessionValue: 900 },
      sessionType: 'session',
      sessionValue: 900
    }));
    const result = calculateCommissionBatch(doc, [
      ...makeSessions('package-a', 1500), ...makeSessions('package-b', 2000),
      ...makeSessions('incomplete', 3000, 2)
    ]);
    expect(result.totalCommission).toBe(3600);
    expect(result.breakdown.neuropsychEvaluations).toEqual({ count: 8, value: 3600 });
    expect(result.breakdown.standardSessions.count).toBe(0);
    expect(result.totalProductionBase).toBe(7200);
  });

  it('preserva repasse fixo zero sem substituir pelo padrão', () => {
    const result = calculateCommissionBatch({ commissionRules: { rules: [{
      serviceType: 'neuropsychological', billingType: 'particular',
      commissionType: 'fixed', value: 0, active: true
    }] } }, [{
      package: { _id: 'zero', sessionType: 'neuropsych_evaluation', totalSessions: 1, totalValue: 2000 }
    }]);
    expect(result.totalCommission).toBe(0);
  });

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

  it('neuropsicologia em pacote gera repasse na própria sessão', () => {
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
    expect(commission).toBe(250);
  });

  it('calcula batch com neuropsicologia por sessão sem usar valor legado do pacote', () => {
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
      commissionRules: { neuropsychEvaluation: 1200, rules: [{
        serviceType: 'neuropsychological', billingType: 'particular',
        commissionType: 'percentage', value: 50, active: true
      }] }
    };

    const { totalCommission } = calculateCommissionBatch(doc, sessions);
    expect(totalCommission).toBe(750);
  });

  it('reproduz setembro da Milena: 10 atendimentos somam R$ 875', () => {
    const doc = { commissionRules: { neuropsychEvaluation: 50, neuropsychCommissionType: 'percentage', rules: [{
      serviceType: 'neuropsychological', billingType: 'particular',
      commissionType: 'percentage', value: 50, active: true
    }] } };
    const makeSessions = (sessionValue, count, sessionType) => Array.from({ length: count }, () => ({
      sessionType: 'psicologia', sessionValue, professionalPaymentStatus: 'payable',
      paymentMethod: 'package_prepaid',
      package: { _id: sessionType, sessionType, sessionValue, totalSessions: 10, totalValue: sessionValue * 10 }
    }));
    const result = calculateCommissionBatch(doc, [
      ...makeSessions(200, 5, 'psicologia'),
      ...makeSessions(150, 2, 'psicopedagogia'),
      ...makeSessions(150, 3, 'neuropsicologia')
    ]);
    expect(result.totalCommission).toBe(875);
    expect(result.totalProductionBase).toBe(1750);
    expect(result.breakdown.standardSessions).toMatchObject({ count: 7, value: 650 });
    expect(result.breakdown.neuropsychEvaluations).toEqual({ count: 3, value: 225 });
  });

  it('respeita non_payable na neuropsicologia e mantém a base de produção', () => {
    const doc = { commissionRules: { rules: [{
      serviceType: 'neuropsychological', billingType: 'particular',
      commissionType: 'percentage', value: 50, active: true
    }] } };
    const session = {
      sessionType: 'psicologia', sessionValue: 999, professionalPaymentStatus: 'non_payable',
      package: { _id: 'pkg', sessionType: 'neuropsicologia', sessionValue: 150, totalSessions: 10 }
    };
    expect(calculateSessionCommission(doc, session)).toBe(0);
    const result = calculateCommissionBatch(doc, [session]);
    expect(result.totalCommission).toBe(0);
    expect(result.totalProductionBase).toBe(150);
    expect(result.breakdown.neuropsychEvaluations).toEqual({ count: 0, value: 0 });
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
