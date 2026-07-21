/**
 * ============================================================================
 * ISSUE FISCAL INVOICE SERVICE
 * ============================================================================
 *
 * Application Service — PR4 (Integração) do módulo fiscal NFS-e. Peça central que faltava:
 * conecta o Fiscal Domain (PR2: FiscalInvoiceService, sem HTTP/provider) com a Provider Layer
 * (PR3: FiscalProvider/Adapters, sem persistência/regra de negócio).
 *
 * Fluxo:
 *   1. FiscalInvoiceService.createDraft()      → valida elegibilidade (EmissionPolicy), cria DRAFT
 *   2. FiscalInvoiceService.requestEmission()  → DRAFT → PENDING_SUBMISSION, abre FiscalSubmission #1
 *                                                 + FiscalSnapshot (domain/fiscal, PR2)
 *   3. attemptSubmission() (helper local)      → resolve provider, monta+assina XML, chama Adapter
 *   4. Provider retorna sucesso/rejeição/erro  → FiscalInvoiceService.recordAuthorization/
 *                                                 recordRejection/recordInfrastructureFailure
 *   5. Cada etapa já publica Domain Events via Outbox (PR2) — nada novo a publicar aqui.
 *
 * Segue o mesmo padrão de domains/billing/services/PackageBillingService.v2.js: correlationId
 * gerado se ausente, log estruturado por etapa, sem inventar convenção nova.
 * ============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import * as FiscalInvoiceService from '../../domain/fiscal/services/FiscalInvoiceService.js';
import { attemptSubmission } from './_attemptSubmission.js';

export class IssueFiscalInvoiceService {
  /**
   * @param {Object} draft - ver domain/fiscal/services/FiscalInvoiceService.createDraft
   * @param {{ correlationId?: string }} [options]
   * @returns {Promise<{ fiscalInvoice: Object, outcome: 'authorized'|'rejected'|'network_error'|'timeout' }>}
   */
  async issue(draft, options = {}) {
    const correlationId = options.correlationId || uuidv4();

    console.log('[IssueFiscalInvoiceService] Iniciando emissão', {
      origin: draft.origin,
      patient: draft.patient,
      correlationId
    });

    const fiscalInvoice = await FiscalInvoiceService.createDraft(draft);

    console.log('[IssueFiscalInvoiceService] Draft criado', {
      fiscalInvoiceId: fiscalInvoice._id.toString(),
      correlationId
    });

    const { submission, snapshot } = await FiscalInvoiceService.requestEmission(fiscalInvoice._id, { correlationId });

    console.log('[IssueFiscalInvoiceService] Submission aberta, chamando provider', {
      fiscalInvoiceId: fiscalInvoice._id.toString(),
      fiscalSubmissionId: submission._id.toString(),
      attemptNumber: submission.attemptNumber,
      correlationId
    });

    const { fiscalInvoice: updated, outcome } = await attemptSubmission(fiscalInvoice, submission, snapshot, {
      correlationId,
      overrideAdapter: options.overrideAdapter // só usado em testes de integração
    });

    console.log('[IssueFiscalInvoiceService] Emissão concluída', {
      fiscalInvoiceId: fiscalInvoice._id.toString(),
      outcome,
      correlationId
    });

    return { fiscalInvoice: updated, outcome };
  }
}

export const issueFiscalInvoiceService = new IssueFiscalInvoiceService();
