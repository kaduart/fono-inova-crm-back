import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../infrastructure/persistence/FiscalInvoiceRepository.js', () => ({ fiscalInvoiceRepository: { findById: vi.fn() } }));
vi.mock('../../infrastructure/persistence/FiscalSubmissionRepository.js', () => ({ fiscalSubmissionRepository: { findLastAttempt: vi.fn() } }));
vi.mock('../../services/fiscal/_attemptSubmission.js', () => ({ reconcileSubmission: vi.fn(), attemptSubmission: vi.fn() }));
vi.mock('../../domain/fiscal/services/FiscalInvoiceService.js', () => ({ recordAuthorization: vi.fn(), attachAttachment: vi.fn() }));
import { fiscalInvoiceRepository } from '../../infrastructure/persistence/FiscalInvoiceRepository.js';
import { fiscalSubmissionRepository } from '../../infrastructure/persistence/FiscalSubmissionRepository.js';
import { reconcileSubmission, attemptSubmission } from '../../services/fiscal/_attemptSubmission.js';
import { recordAuthorization } from '../../domain/fiscal/services/FiscalInvoiceService.js';
import { retryFiscalSubmissionService } from '../../services/fiscal/RetryFiscalSubmissionService.js';
const invoice = { _id: 'invoice', status: 'pending_submission' };
beforeEach(() => {
  vi.resetAllMocks();
  fiscalInvoiceRepository.findById.mockResolvedValue(invoice);
  fiscalSubmissionRepository.findLastAttempt.mockResolvedValue({ _id: 'attempt', providerSnapshot: 'anapolis_municipal', outcome: 'timeout' });
});
describe('retry exige reconciliação', () => {
  it.each(['unknown', 'not_found', 'processing'])('resultado %s bloqueia submit', async (status) => {
    reconcileSubmission.mockResolvedValue({ status });
    expect((await retryFiscalSubmissionService.retry('invoice')).outcome).toBe('reconciliation_required');
    expect(attemptSubmission).not.toHaveBeenCalled();
    expect(recordAuthorization).not.toHaveBeenCalled();
  });
  it('consulta falha: mantém pendente', async () => {
    reconcileSubmission.mockRejectedValue(new Error('disconnect'));
    expect((await retryFiscalSubmissionService.retry('invoice')).outcome).toBe('reconciliation_required');
    expect(attemptSubmission).not.toHaveBeenCalled();
  });
  it('autorização existente é registrada sem reenviar', async () => {
    const fields = { chaveAcesso: 'key', nNFSe: 123, cStat: 100 };
    reconcileSubmission.mockResolvedValue({ status: 'authorized', fields });
    recordAuthorization.mockResolvedValue({ ...invoice, status: 'authorized' });
    expect((await retryFiscalSubmissionService.retry('invoice')).outcome).toBe('authorized');
    expect(recordAuthorization).toHaveBeenCalledWith('invoice', expect.anything(), { ...fields, providerSnapshot: 'anapolis_municipal' }, expect.anything());
    expect(attemptSubmission).not.toHaveBeenCalled();
  });
  it('autorização incompleta não vira sucesso', async () => {
    reconcileSubmission.mockResolvedValue({ status: 'authorized', fields: {} });
    expect((await retryFiscalSubmissionService.retry('invoice')).outcome).toBe('reconciliation_required');
    expect(recordAuthorization).not.toHaveBeenCalled();
  });
});
