// tests/unit/guideLifecycle/guideLifecycle.test.js
import { describe, it, expect } from 'vitest';
import { EndOfMonthStrategy } from '../../../services/guideLifecycle/strategies/EndOfMonthStrategy.js';
import { UntilConsumedStrategy } from '../../../services/guideLifecycle/strategies/UntilConsumedStrategy.js';
import { FixedDateStrategy } from '../../../services/guideLifecycle/strategies/FixedDateStrategy.js';
import { AuthorizationValidityStrategy } from '../../../services/guideLifecycle/strategies/AuthorizationValidityStrategy.js';
import { StrategyFactory } from '../../../services/guideLifecycle/StrategyFactory.js';
import { GuideLifecycleService } from '../../../services/guideLifecycle/GuideLifecycleService.js';

const date = (str) => new Date(`${str}T00:00:00.000Z`);

// =============================================================================
// EndOfMonthStrategy
// =============================================================================
describe('EndOfMonthStrategy', () => {
  const policy = {
    renewalType: 'end_of_month',
    renewalDay: 'last_day',
    expirationWarningDays: 5
  };

  it('guia válida: não expirada e sem alerta', () => {
    const today = date('2026-07-01');
    const guide = { expiresAt: date('2026-07-31') };
    const strategy = new EndOfMonthStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.expired).toBe(false);
    expect(result.nearExpiration).toBe(false);
    expect(result.mustRenew).toBe(false);
    expect(result.alerts).toHaveLength(0);
  });

  it('guia vence hoje', () => {
    const today = date('2026-07-31');
    const guide = { expiresAt: date('2026-07-31') };
    const strategy = new EndOfMonthStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.expired).toBe(true);
    expect(result.mustRenew).toBe(true);
    expect(result.alerts[0].code).toBe('EXPIRED');
    expect(result.alerts[0].severity).toBe('error');
  });

  it('guia vencida', () => {
    const today = date('2026-08-05');
    const guide = { expiresAt: date('2026-07-31') };
    const strategy = new EndOfMonthStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.expired).toBe(true);
    expect(result.alerts[0].code).toBe('EXPIRED');
  });

  it('faltam 5 dias para o vencimento', () => {
    const today = date('2026-07-26');
    const guide = { expiresAt: date('2026-07-31') };
    const strategy = new EndOfMonthStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.expired).toBe(false);
    expect(result.nearExpiration).toBe(true);
    expect(result.mustRenew).toBe(true);
    expect(result.alerts[0].code).toBe('EXPIRING_SOON');
    expect(result.alerts[0].metadata.remainingDays).toBe(5);
  });

  it('faltam 2 dias para o vencimento', () => {
    const today = date('2026-07-29');
    const guide = { expiresAt: date('2026-07-31') };
    const strategy = new EndOfMonthStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.nearExpiration).toBe(true);
    expect(result.alerts[0].metadata.remainingDays).toBe(2);
  });

  it('guia superseded mantém cálculo de expiração', () => {
    const today = date('2026-08-05');
    const guide = { expiresAt: date('2026-07-31'), status: 'superseded' };
    const strategy = new EndOfMonthStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.expired).toBe(true);
  });

  it('guia cancelled mantém cálculo de expiração', () => {
    const today = date('2026-08-05');
    const guide = { expiresAt: date('2026-07-31'), status: 'cancelled' };
    const strategy = new EndOfMonthStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.expired).toBe(true);
  });
});

// =============================================================================
// UntilConsumedStrategy
// =============================================================================
describe('UntilConsumedStrategy', () => {
  const policy = { renewalType: 'until_consumed' };

  it('sessões restantes: sem alerta', () => {
    const guide = { totalSessions: 10, usedSessions: 3 };
    const strategy = new UntilConsumedStrategy(policy);
    const result = strategy.evaluate(guide);

    expect(result.expired).toBe(false);
    expect(result.nearExpiration).toBe(false);
    expect(result.mustRenew).toBe(false);
    expect(result.alerts).toHaveLength(0);
  });

  it('exatamente 0 sessões: esgotada', () => {
    const guide = { totalSessions: 10, usedSessions: 10 };
    const strategy = new UntilConsumedStrategy(policy);
    const result = strategy.evaluate(guide);

    expect(result.expired).toBe(true);
    expect(result.mustRenew).toBe(true);
    expect(result.alerts[0].code).toBe('EXHAUSTED');
    expect(result.alerts[0].severity).toBe('error');
  });

  it('sessões negativas: proteção contra inconsistência', () => {
    const guide = { totalSessions: 10, usedSessions: 15 };
    const strategy = new UntilConsumedStrategy(policy);
    const result = strategy.evaluate(guide);

    expect(result.expired).toBe(true);
    expect(result.alerts[0].metadata.remainingSessions).toBe(0);
  });

  it('poucas sessões restantes: alerta de aviso', () => {
    const guide = { totalSessions: 10, usedSessions: 9 };
    const strategy = new UntilConsumedStrategy(policy);
    const result = strategy.evaluate(guide);

    expect(result.expired).toBe(false);
    expect(result.nearExpiration).toBe(true);
    expect(result.alerts[0].code).toBe('LOW_SESSIONS');
    expect(result.alerts[0].metadata.remainingSessions).toBe(1);
  });

  it('guia superseded mantém cálculo de consumo', () => {
    const guide = { totalSessions: 10, usedSessions: 10, status: 'superseded' };
    const strategy = new UntilConsumedStrategy(policy);
    const result = strategy.evaluate(guide);

    expect(result.expired).toBe(true);
  });
});

// =============================================================================
// FixedDateStrategy
// =============================================================================
describe('FixedDateStrategy', () => {
  const policy = { renewalType: 'fixed_date', expirationWarningDays: 5 };

  it('antes da data: válida', () => {
    const today = date('2026-07-01');
    const guide = { expiresAt: date('2026-07-10') };
    const strategy = new FixedDateStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.expired).toBe(false);
    expect(result.alerts).toHaveLength(0);
  });

  it('exatamente na data: vencida', () => {
    const today = date('2026-07-10');
    const guide = { expiresAt: date('2026-07-10') };
    const strategy = new FixedDateStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.expired).toBe(true);
    expect(result.alerts[0].code).toBe('EXPIRED');
  });

  it('depois da data: vencida', () => {
    const today = date('2026-07-15');
    const guide = { expiresAt: date('2026-07-10') };
    const strategy = new FixedDateStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.expired).toBe(true);
  });
});

// =============================================================================
// AuthorizationValidityStrategy
// =============================================================================
describe('AuthorizationValidityStrategy', () => {
  const policy = { renewalType: 'authorization_validity', expirationWarningDays: 5 };

  it('autorização válida', () => {
    const today = date('2026-07-01');
    const guide = { expiresAt: date('2026-07-20') };
    const strategy = new AuthorizationValidityStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.expired).toBe(false);
    expect(result.alerts).toHaveLength(0);
  });

  it('autorização expirada', () => {
    const today = date('2026-08-01');
    const guide = { expiresAt: date('2026-07-20') };
    const strategy = new AuthorizationValidityStrategy(policy);
    const result = strategy.evaluate(guide, today);

    expect(result.expired).toBe(true);
    expect(result.alerts[0].code).toBe('AUTHORIZATION_EXPIRED');
  });
});

// =============================================================================
// StrategyFactory
// =============================================================================
describe('StrategyFactory', () => {
  it('end_of_month -> EndOfMonthStrategy', () => {
    const strategy = StrategyFactory.create({ renewalType: 'end_of_month' });
    expect(strategy).toBeInstanceOf(EndOfMonthStrategy);
  });

  it('until_consumed -> UntilConsumedStrategy', () => {
    const strategy = StrategyFactory.create({ renewalType: 'until_consumed' });
    expect(strategy).toBeInstanceOf(UntilConsumedStrategy);
  });

  it('fixed_date -> FixedDateStrategy', () => {
    const strategy = StrategyFactory.create({ renewalType: 'fixed_date' });
    expect(strategy).toBeInstanceOf(FixedDateStrategy);
  });

  it('authorization_validity -> AuthorizationValidityStrategy', () => {
    const strategy = StrategyFactory.create({ renewalType: 'authorization_validity' });
    expect(strategy).toBeInstanceOf(AuthorizationValidityStrategy);
  });

  it('renewalType desconhecido -> fallback UntilConsumedStrategy', () => {
    const strategy = StrategyFactory.create({ renewalType: 'unknown' });
    expect(strategy).toBeInstanceOf(UntilConsumedStrategy);
  });
});

// =============================================================================
// GuideLifecycleService (regras transversais)
// =============================================================================
describe('GuideLifecycleService', () => {
  const activeGuide = {
    status: 'active',
    insurance: 'bradesco-saude',
    totalSessions: 10,
    usedSessions: 3,
    expiresAt: date('2026-07-31')
  };

  it('guia ativa e válida: pode agendar, faturar e editar', () => {
    const today = date('2026-07-01');
    const result = GuideLifecycleService.evaluateWithPolicy(
      activeGuide,
      { renewalType: 'end_of_month', expirationWarningDays: 5 },
      today
    );

    expect(result.state.status).toBe('active');
    expect(result.eligibility.canSchedule).toBe(true);
    expect(result.eligibility.canBill).toBe(true);
    expect(result.eligibility.canRenew).toBe(false);
    expect(result.eligibility.canEdit).toBe(true);
    expect(result.eligibility.canBeSuperseded).toBe(true);
    expect(result.alerts).toHaveLength(0);
  });

  it('guia próxima do vencimento: pode renovar', () => {
    const today = date('2026-07-26');
    const result = GuideLifecycleService.evaluateWithPolicy(
      activeGuide,
      { renewalType: 'end_of_month', expirationWarningDays: 5 },
      today
    );

    expect(result.eligibility.canRenew).toBe(true);
    expect(result.alerts[0].code).toBe('EXPIRING_SOON');
  });

  it('guia vencida: não pode agendar/faturar, mas pode renovar', () => {
    const today = date('2026-08-05');
    const result = GuideLifecycleService.evaluateWithPolicy(
      activeGuide,
      { renewalType: 'end_of_month', expirationWarningDays: 5 },
      today
    );

    expect(result.eligibility.canSchedule).toBe(false);
    expect(result.eligibility.canBill).toBe(false);
    expect(result.eligibility.canRenew).toBe(true);
    expect(result.eligibility.canBeSuperseded).toBe(false);
    expect(result.alerts[0].code).toBe('EXPIRED');
  });

  it('guia superseded: não pode nada operacional', () => {
    const guide = { ...activeGuide, status: 'superseded' };
    const today = date('2026-07-01');
    const result = GuideLifecycleService.evaluateWithPolicy(
      guide,
      { renewalType: 'end_of_month', expirationWarningDays: 5 },
      today
    );

    expect(result.state.status).toBe('superseded');
    expect(result.eligibility.canSchedule).toBe(false);
    expect(result.eligibility.canBill).toBe(false);
    expect(result.eligibility.canRenew).toBe(false);
    expect(result.eligibility.canEdit).toBe(false);
    expect(result.eligibility.canBeSuperseded).toBe(false);
  });

  it('guia cancelled: não pode nada operacional', () => {
    const guide = { ...activeGuide, status: 'cancelled' };
    const today = date('2026-07-01');
    const result = GuideLifecycleService.evaluateWithPolicy(
      guide,
      { renewalType: 'end_of_month', expirationWarningDays: 5 },
      today
    );

    expect(result.eligibility.canSchedule).toBe(false);
    expect(result.eligibility.canBill).toBe(false);
    expect(result.eligibility.canRenew).toBe(false);
    expect(result.eligibility.canEdit).toBe(false);
  });

  it('guia esgotada (until_consumed): pode renovar, mas não agendar/faturar', () => {
    const guide = {
      status: 'active',
      insurance: 'unimed-anapolis',
      totalSessions: 10,
      usedSessions: 10
    };
    const result = GuideLifecycleService.evaluateWithPolicy(
      guide,
      { renewalType: 'until_consumed' },
      date('2026-07-01')
    );

    expect(result.eligibility.canSchedule).toBe(false);
    expect(result.eligibility.canBill).toBe(false);
    expect(result.eligibility.canRenew).toBe(true);
    expect(result.alerts[0].code).toBe('EXHAUSTED');
  });

  it('sem convênio: comportamento permissivo (fallback)', async () => {
    const guide = { status: 'active' };
    const result = await GuideLifecycleService.evaluate(guide, date('2026-07-01'));

    expect(result.eligibility.canSchedule).toBe(true);
    expect(result.eligibility.canBill).toBe(true);
    expect(result.eligibility.canRenew).toBe(false);
  });
});
