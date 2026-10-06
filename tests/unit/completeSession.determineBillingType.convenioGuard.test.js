/**
 * 🛡️ Complete: guia de convênio vinculada ⇒ fluxo de convênio (caso Antonella/Unimed, 2026-10-06).
 * Função pura — sem banco.
 */
import { describe, it, expect, vi } from 'vitest';
import { determineBillingType } from '../../services/completeSessionService.v2.js';

describe('determineBillingType — convênio nunca cai no fluxo particular', () => {
  it('guia vinculada com billingType=particular roteia para convenio', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(determineBillingType({ _id: 'a1', billingType: 'particular', insuranceGuide: 'g1' }, null)).toBe('convenio');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('guia vinculada mesmo com pacote therapy no meio continua convenio', () => {
    expect(determineBillingType({ billingType: 'particular', insuranceGuide: 'g1' }, { type: 'therapy' })).toBe('convenio');
  });

  it('convênio explícito continua convenio', () => {
    expect(determineBillingType({ billingType: 'convenio' }, null)).toBe('convenio');
  });

  it('particular sem guia continua particular', () => {
    expect(determineBillingType({ billingType: 'particular' }, null)).toBe('particular');
  });

  it('liminar continua com prioridade sobre guia', () => {
    expect(determineBillingType({ liminarContract: 'l1', insuranceGuide: 'g1' }, null)).toBe('liminar');
  });
});
