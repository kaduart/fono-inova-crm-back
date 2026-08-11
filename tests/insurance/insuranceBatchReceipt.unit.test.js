import { describe, expect, it } from 'vitest';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import {
  allocateNetAmounts,
  InsuranceBatchReceiptError,
  updateInvoiceNumber,
  __testables
} from '../../services/insuranceBatch/InsuranceBatchReceiptService.js';

describe('InsuranceBatchReceipt — baixa financeira por NF/guia', () => {
  it('rateia o líquido da NF e reconcilia o último centavo', () => {
    const allocations = allocateNetAmounts([80, 80, 80, 80, 80], 391.96);

    expect(allocations).toEqual([78.39, 78.39, 78.39, 78.39, 78.4]);
    expect(allocations.reduce((sum, value) => sum + value, 0)).toBeCloseTo(391.96, 2);
  });

  it('preserva proporcionalidade quando os valores das sessões divergem', () => {
    expect(allocateNetAmounts([100, 300], 360)).toEqual([90, 270]);
  });

  it('rejeita lote sem valor bruto', () => {
    expect(() => allocateNetAmounts([0, 0], 0)).toThrowError(InsuranceBatchReceiptError);
  });

  it('permite status parcial no agregado da NF', () => {
    const statusPath = InsuranceBatch.schema.path('status');
    expect(statusPath.enumValues).toContain('partial');
  });

  it('deriva NF recebida pelos Payments mesmo quando o status antigo do lote ficou sent', () => {
    const paymentId = '64b000000000000000000001';
    const guideId = '64b000000000000000000002';
    const row = __testables.toReceivable({
      _id: '64b000000000000000000003',
      status: 'sent',
      invoiceNumber: '5001',
      totalGross: 100,
      totalNet: 98,
      sessions: [{
        payment: paymentId,
        guide: { _id: guideId, number: '123', specialty: 'fonoaudiologia' },
        grossAmount: 100,
        status: 'sent'
      }]
    }, new Map([[paymentId, { insurance: { status: 'received', receivedAmount: 98 } }]]));

    expect(row.status).toBe('received');
    expect(row.receivedAmount).toBe(98);
    expect(row.pendingAmount).toBe(0);
    expect(row.guides[0].status).toBe('received');
  });

  it('exige número da NF para atualização', async () => {
    await expect(updateInvoiceNumber('64b000000000000000000003', { invoiceNumber: '   ' }))
      .rejects.toThrow(InsuranceBatchReceiptError);
  });
});
