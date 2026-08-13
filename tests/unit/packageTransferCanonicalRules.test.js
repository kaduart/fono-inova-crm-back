import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

describe('regras canônicas da transferência e do reparo da guia', () => {
  it('projeta os vínculos de cobertura do Package na PackagesView', () => {
    const schema = read('models/PackagesView.js');
    const projection = read('domains/billing/services/PackageProjectionService.js');

    expect(schema).toMatch(/fundedByTransfer:\s*Number/);
    expect(schema).toMatch(/sourceTransferId\s*:/);
    expect(projection).toMatch(/fundedByTransfer:\s*pkg\.fundedByTransfer/);
    expect(projection).toMatch(/sourceTransferId:\s*pkg\.sourceTransferId/);
  });

  it('estorna Payment pelo serviço canônico, nunca por update direto de status', () => {
    const repair = read('scripts/maintenance/repair-icaro-guide-16173377.js');

    expect(repair).toMatch(/transitionPaymentStatus\(paymentId, 'canceled'/);
    expect(repair).not.toMatch(/Payment\.updateMany\([\s\S]*?status:\s*'canceled'/);
  });
});
