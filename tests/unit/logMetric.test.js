/**
 * Testes unitários para o utilitário de observabilidade logMetric.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logMetric } from '../../utils/logMetric.js';

describe('logMetric', () => {
  let consoleSpy;
  let errorSpy;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('deve emitir JSON estruturado no stdout', () => {
    logMetric('ProfessionalFinancialService', 'getProfessionalRanking', {
      executionTimeMs: 123,
      cacheHit: true,
      count: 42
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed).toMatchObject({
      level: 'metric',
      service: 'ProfessionalFinancialService',
      operation: 'getProfessionalRanking',
      executionTimeMs: 123,
      cacheHit: true,
      count: 42
    });
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('não deve lançar exceção quando console.log falha', () => {
    consoleSpy.mockImplementation(() => {
      throw new Error('stdout indisponível');
    });

    expect(() =>
      logMetric('ReconciliationService', 'getGlobalReconciliation', {})
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      '[logMetric] Falha ao emitir métrica:',
      'stdout indisponível'
    );
  });
});
