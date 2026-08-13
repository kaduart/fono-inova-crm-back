import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('propriedade canônica de Payment.status no faturamento', () => {
  it('BillingSubmissionService delega o lote e não escreve Payment.status diretamente', () => {
    const source = read('services/billingSubmission/BillingSubmissionService.js');

    expect(source).toContain("transitionPaymentStatusBatch(paymentTransitions, 'billed'");
    expect(source).not.toMatch(/Payment\.bulkWrite/);
    expect(source).not.toMatch(/buildBilledUpdate/);
    expect(source).not.toMatch(/PAYMENT_STATUS_CHANGED/);
  });

  it('paymentStatusService é proprietário do bulkWrite, ledger e Outbox do lote', () => {
    const source = read('services/paymentStatusService.js');

    expect(source).toMatch(/export async function transitionPaymentStatusBatch/);
    expect(source).toMatch(/Payment\.bulkWrite/);
    expect(source).toMatch(/FinancialLedger\.insertMany/);
    expect(source).toMatch(/Outbox\.insertMany/);
    expect(source).toMatch(/EventTypes\.PAYMENT_STATUS_CHANGED/);
  });
});
