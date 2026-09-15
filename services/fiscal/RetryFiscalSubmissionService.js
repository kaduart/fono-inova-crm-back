// Após resultado indeterminado, reconciliar a DPS original antes de qualquer reenvio.
import { v4 as uuidv4 } from 'uuid';
import { fiscalInvoiceRepository } from '../../infrastructure/persistence/FiscalInvoiceRepository.js';
import { fiscalSubmissionRepository } from '../../infrastructure/persistence/FiscalSubmissionRepository.js';
import { reconcileSubmission } from './_attemptSubmission.js';
import * as FiscalInvoiceService from '../../domain/fiscal/services/FiscalInvoiceService.js';
import { FiscalInvoiceStatus } from '../../constants/fiscalEnums.js';

export class RetryFiscalSubmissionService {
  async retry(fiscalInvoiceId, options = {}) {
    const correlationId = options.correlationId || uuidv4();
    const fiscalInvoice = await fiscalInvoiceRepository.findById(fiscalInvoiceId);
    if (!fiscalInvoice) throw new Error('FISCAL_INVOICE_NAO_ENCONTRADA');
    if (fiscalInvoice.status !== FiscalInvoiceStatus.PENDING_SUBMISSION) {
      throw new Error('FISCAL_INVOICE_STATUS_INVALIDO_PARA_RETRY: ' + fiscalInvoice.status);
    }
    const submission = await fiscalSubmissionRepository.findLastAttempt(fiscalInvoiceId);
    const required = (reason) => ({ fiscalInvoice, outcome: 'reconciliation_required', reason });
    if (!submission) return required('PREVIOUS_SUBMISSION_NOT_FOUND');
    let result;
    try {
      result = await reconcileSubmission(fiscalInvoice, submission, options);
    } catch {
      return required('RECONCILIATION_QUERY_FAILED');
    }
    if (result?.status === 'authorized' && result.fields?.chaveAcesso && result.fields?.nNFSe && result.fields?.cStat) {
      const updated = await FiscalInvoiceService.recordAuthorization(fiscalInvoiceId, submission,
        { ...result.fields, providerSnapshot: submission.providerSnapshot }, { correlationId });
      if (result.xml) await FiscalInvoiceService.attachAttachment(fiscalInvoiceId, {
        type: 'xml_nfse', storageRef: result.xml, mimeType: 'application/xml',
        size: Buffer.byteLength(result.xml, 'utf8'), generatedAt: new Date()
      });
      return { fiscalInvoice: updated, outcome: 'authorized' };
    }
    // Até existir contrato homologado de ausência definitiva, nem "não encontrado"
    // é prova suficiente para reenviar (processamento pode estar em andamento).
    return required(result?.reason || 'RECONCILIATION_NOT_CONCLUSIVE');
  }
}
export const retryFiscalSubmissionService = new RetryFiscalSubmissionService();
