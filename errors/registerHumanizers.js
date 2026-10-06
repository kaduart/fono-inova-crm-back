/**
 * Registra os tradutores de cada domínio no catálogo central.
 * Importado uma vez no boot (middleware/errorHandler.js) e por controllers que respondem erro
 * por conta própria. Novo domínio = novo `registerHumanizer` aqui (ver docs/MENSAGERIA_PADRAO.md).
 */
import { registerHumanizer } from './errorCatalog.js';
import { humanizeBillingError } from '../services/billingSubmission/billingErrorMessages.js';

// Faturamento de convênio: identifica paciente/sessão/guia e diz o que fazer.
registerHumanizer(
  (code) => code.startsWith('BILLING_SUBMISSION_') || code === 'PAYMENT_STATUS_NOT_BILLABLE',
  async (error) => {
    const human = await humanizeBillingError(error);
    // Sem título = nenhuma sessão identificada → deixa o fluxo cair no texto original.
    return human.title ? { message: human.message, title: human.title, action: human.action, items: human.items } : null;
  }
);
