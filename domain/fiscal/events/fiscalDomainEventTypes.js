// domain/fiscal/events/fiscalDomainEventTypes.js
// Domain Events internos do CRM — NUNCA confundir com OfficialFiscalEvent (evento da prefeitura,
// Fase 2 v3 Seção 5). Publicados exclusivamente pelos services em domain/fiscal/services/.
// A ligação com filas BullMQ reais (eventToQueueMap) é responsabilidade do PR4 — aqui só
// persistimos no Outbox (infraestrutura já existente e compartilhada com o resto do CRM).

export const FiscalDomainEventTypes = {
  FISCAL_INVOICE_REQUESTED: 'FISCAL_INVOICE_REQUESTED',
  FISCAL_SUBMISSION_STARTED: 'FISCAL_SUBMISSION_STARTED',
  FISCAL_SUBMISSION_SUCCEEDED: 'FISCAL_SUBMISSION_SUCCEEDED',
  FISCAL_SUBMISSION_FAILED: 'FISCAL_SUBMISSION_FAILED',
  FISCAL_INVOICE_AUTHORIZED: 'FISCAL_INVOICE_AUTHORIZED',
  FISCAL_INVOICE_REJECTED: 'FISCAL_INVOICE_REJECTED',
  FISCAL_INVOICE_CANCELLED: 'FISCAL_INVOICE_CANCELLED',
  FISCAL_INVOICE_SUBSTITUTED: 'FISCAL_INVOICE_SUBSTITUTED',
  OFFICIAL_FISCAL_EVENT_RECORDED: 'OFFICIAL_FISCAL_EVENT_RECORDED'
};
