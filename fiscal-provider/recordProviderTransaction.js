// fiscal-provider/recordProviderTransaction.js
// Helper compartilhado pelos Adapters para logar cada chamada HTTP real — nunca chamado pelo
// Fiscal Domain diretamente (ponto 7 do review: isso "salva dias de investigação" quando o
// provedor municipal responde erro estranho de forma intermitente).
import { v4 as uuidv4 } from 'uuid';
import { providerTransactionRepository } from '../infrastructure/persistence/ProviderTransactionRepository.js';

export async function recordProviderTransaction(fiscalSubmissionId, details, { session } = {}) {
  return providerTransactionRepository.create(
    {
      fiscalSubmission: fiscalSubmissionId,
      attemptId: details.attemptId || uuidv4(),
      traceId: details.traceId || uuidv4(),
      endpoint: details.endpoint,
      httpStatus: details.httpStatus,
      request: details.request,
      response: details.response,
      headers: details.headers,
      duration: details.duration,
      tlsVersion: details.tlsVersion,
      certificateThumbprint: details.certificateThumbprint,
      providerVersion: details.providerVersion,
      retryOf: details.retryOf
    },
    { session }
  );
}
