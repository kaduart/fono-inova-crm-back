import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveProviderName } from '../../fiscal-provider/FiscalProviderResolver.js';
import { loadResolutionPolicies } from '../../fiscal-provider/ResolutionPolicy.js';
const profile = { municipioIBGE: '5201108', regimeTributario: 'SIMPLES_NACIONAL' };
afterEach(() => vi.unstubAllEnvs());

describe('ResolutionPolicy: corte de Brasília', () => {
  it.each([
    ['2026-09-11T12:00:00-03:00', 'anapolis_municipal'],
    ['2026-09-30T12:00:00-03:00', 'anapolis_municipal'],
    ['2026-10-31T23:59:59-03:00', 'anapolis_municipal'],
    ['2026-10-31T23:59:59.999-03:00', 'anapolis_municipal'],
    ['2026-11-01T00:00:00-03:00', 'sefin_nacional'],
    ['2026-11-02T12:00:00-03:00', 'sefin_nacional'],
    ['2026-11-01T02:59:59.999Z', 'anapolis_municipal'],
    ['2026-11-01T03:00:00Z', 'sefin_nacional']
  ])('%s → %s', (date, expected) => {
    expect(resolveProviderName(profile, { asOfDate: new Date(date) })).toBe(expected);
  });
  it('outro regime não migra', () => {
    expect(resolveProviderName({ ...profile, regimeTributario: 'LUCRO_PRESUMIDO' }, { asOfDate: new Date('2026-11-02') })).toBe('anapolis_municipal');
  });
  it('configuração temporal é injetável sem alterar resolver', () => {
    expect(resolveProviderName(profile, { asOfDate: new Date('2026-09-11'), policies: [{ ...profile, effectiveFrom: null, effectiveUntil: null, provider: 'sefin_nacional' }] })).toBe('sefin_nacional');
  });
  it('override legado não antecipa migração', () => {
    vi.stubEnv('FISCAL_SEFIN_NACIONAL_EFFECTIVE_FROM', '2026-09-01');
    expect(resolveProviderName(profile, { asOfDate: new Date('2026-09-11') })).toBe('anapolis_municipal');
  });
  it('falha fechada para políticas sobrepostas ou data inválida', () => {
    const policies = loadResolutionPolicies();
    expect(() => resolveProviderName(profile, { asOfDate: new Date('2026-09-11'), policies: [...policies, policies[0]] })).toThrow('AMBIGUOUS');
    expect(() => resolveProviderName(profile, { asOfDate: new Date('invalid') })).toThrow('INVALID');
  });
});
