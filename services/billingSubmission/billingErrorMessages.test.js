import { describe, it, expect } from 'vitest';
import { describeItem, buildBillingMessage, humanizeBillingError } from './billingErrorMessages.js';

const item = {
  sessionId: 's1',
  patientName: 'Antonella Souza Eneas',
  sessionDate: '2026-06-29T12:00:00.000Z',
  guideNumber: '16241739',
  amount: 80,
  paymentStatus: 'paid',
  insuranceStatus: 'pending_billing',
};

describe('billingErrorMessages', () => {
  it('descreve paciente, data, guia e valor — sem expor ID de pagamento', () => {
    const text = describeItem(item);
    expect(text).toContain('Antonella Souza Eneas');
    expect(text).toContain('29/06/2026');
    expect(text).toContain('guia 16241739');
    expect(text).toMatch(/R\$\s?80,00/);
    expect(text).not.toMatch(/[0-9a-f]{24}/);
  });

  it('pagamento já baixado: diz quem, o quê e o que fazer', () => {
    const built = buildBillingMessage('BILLING_SUBMISSION_PAYMENT_STATUS_NOT_BILLABLE', [item]);
    expect(built.message).toContain('Antonella Souza Eneas');
    expect(built.message).toContain('já consta como pago');
    expect(built.message).toContain('financeiro');
    expect(built.message).toContain('Nada foi faturado');
  });

  it('o erro técnico das invariantes usa a mesma mensagem', () => {
    const a = buildBillingMessage('PAYMENT_STATUS_NOT_BILLABLE', [item]);
    expect(a.title).toMatch(/pagamento já baixado/i);
  });

  it('lista no máximo 5 e resume o resto', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...item, sessionId: `s${i}` }));
    const built = buildBillingMessage('BILLING_SUBMISSION_PAYMENT_STATUS_NOT_BILLABLE', many);
    expect(built.message).toContain('e mais 3 sessão(ões)');
    expect(built.message.split('• ').length - 1).toBe(6);
  });

  it('código fora do catálogo ou sem sessões → null (mantém mensagem original)', () => {
    expect(buildBillingMessage('OUTRO_CODIGO', [item])).toBeNull();
    expect(buildBillingMessage('BILLING_SUBMISSION_SESSION_NOT_COMPLETED', [])).toBeNull();
  });

  it('humanizeBillingError preserva a mensagem técnica e nunca lança', async () => {
    const err = Object.assign(new Error('Payment 6a3c… está em paid'), {
      code: 'PAYMENT_STATUS_NOT_BILLABLE',
      details: { paymentId: '6a3c0b63c3dd2574dca64e91', status: 'paid' },
    });
    const ok = await humanizeBillingError(err, { load: async () => [item] });
    expect(ok.message).toContain('Antonella Souza Eneas');
    expect(ok.technicalMessage).toBe('Payment 6a3c… está em paid');
    expect(ok.items).toHaveLength(1);

    const falha = await humanizeBillingError(err, { load: async () => { throw new Error('db caiu'); } });
    expect(falha.message).toBe('Payment 6a3c… está em paid');
  });
});
