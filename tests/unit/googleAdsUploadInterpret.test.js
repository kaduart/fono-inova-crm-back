/** Correção 6: duplicado no Google (order_id já importado pelo CSV) não é falha. */
import { describe, it, expect } from 'vitest';
import { interpretUploadResponse } from '../../services/googleAdsConversionsService.js';

describe('interpretUploadResponse', () => {
  it('sem erro parcial: sent', () => {
    expect(interpretUploadResponse({})).toEqual({ status: 'sent' });
  });
  it('ORDER_ID_ALREADY_IN_USE sozinho: sent com motivo', () => {
    expect(interpretUploadResponse({ partial_failure_error: { code: 3, message: 'conversion_upload_error: ORDER_ID_ALREADY_IN_USE' } }))
      .toEqual({ status: 'sent', reason: 'ja_importado_pelo_csv' });
  });
  it('outros erros continuam falha permanente', () => {
    const r = interpretUploadResponse({ partial_failure_error: { message: 'EXPIRED_EVENT' } });
    expect(r).toMatchObject({ status: 'failed', retryable: false });
  });
  it('ORDER_ID junto com outro erro não vira sent', () => {
    const r = interpretUploadResponse({ partial_failure_error: { message: 'ORDER_ID_ALREADY_IN_USE; UNPARSEABLE_GCLID' } });
    expect(r.status).toBe('failed');
  });
  it('erro desconhecido pode ser repetido', () => {
    expect(interpretUploadResponse({ partial_failure_error: { message: 'INTERNAL_ERROR' } })).toMatchObject({ status: 'failed', retryable: true });
  });
});
