import { describe, it, expect } from 'vitest';
import { applyFinancialProtection } from './appointmentFinancialPolicy.js';

describe('appointmentFinancialPolicy', () => {
  const baseAppointment = {
    _id: '123',
    billingType: 'convenio',
    paymentMethod: 'convenio',
  };

  it('preserva billingType convenio quando payload envia particular', () => {
    const result = applyFinancialProtection(baseAppointment, { billingType: 'particular' });
    expect(result.billingType).toBe('convenio');
  });

  it('preserva paymentMethod convenio quando payload envia pix', () => {
    const result = applyFinancialProtection(baseAppointment, { paymentMethod: 'pix' });
    expect(result.paymentMethod).toBe('convenio');
  });

  it('preserva billingType liminar quando payload envia particular', () => {
    const appt = { ...baseAppointment, billingType: 'liminar', paymentMethod: 'liminar_credit' };
    const result = applyFinancialProtection(appt, { billingType: 'particular' });
    expect(result.billingType).toBe('liminar');
  });

  it('preserva paymentMethod liminar_credit quando payload envia pix', () => {
    const appt = { ...baseAppointment, billingType: 'liminar', paymentMethod: 'liminar_credit' };
    const result = applyFinancialProtection(appt, { paymentMethod: 'pix' });
    expect(result.paymentMethod).toBe('liminar_credit');
  });

  it('permite upgrade particular -> convenio quando current é particular', () => {
    const appt = { ...baseAppointment, billingType: 'particular', paymentMethod: 'pix' };
    const result = applyFinancialProtection(appt, { billingType: 'convenio' });
    expect(result.billingType).toBe('convenio');
  });

  it('permite alteração legítima quando __allowFinancialConversion está presente', () => {
    const result = applyFinancialProtection(baseAppointment, {
      billingType: 'particular',
      paymentMethod: 'pix',
      __allowFinancialConversion: true,
    });
    expect(result.billingType).toBe('particular');
    expect(result.paymentMethod).toBe('pix');
  });

  it('não altera payload quando não há downgrade', () => {
    const payload = { billingType: 'convenio', paymentMethod: 'convenio' };
    const result = applyFinancialProtection(baseAppointment, payload);
    expect(result).toEqual(payload);
  });
});
