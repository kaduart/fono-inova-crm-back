// adapters/fiscal/MockAdapter.js
// Municipal Adapter de desenvolvimento/teste — nenhuma chamada de rede real. Permite testar todo
// o pipeline (DpsBuilder → CertificateManager → Provider → parsing de resposta → domínio) sem
// depender de credenciais/certificado real.

import { FiscalProvider } from '../../fiscal-provider/FiscalProvider.js';

let mockSequence = 0;

export class MockAdapter extends FiscalProvider {
  /** @param {{ forceOutcome?: 'success'|'rejected'|'timeout'|'network_error' }} [options] */
  constructor({ forceOutcome = 'success' } = {}) {
    super();
    this.forceOutcome = forceOutcome;
  }

  async submitDps(_signedDpsXml) {
    if (this.forceOutcome === 'rejected') {
      return { success: false, error: { code: 'E1301', message: 'Rejeição simulada (MockAdapter)' } };
    }
    if (this.forceOutcome === 'timeout') {
      const err = new Error('MOCK_TIMEOUT');
      err.isTimeout = true;
      throw err;
    }
    if (this.forceOutcome === 'network_error') {
      const err = new Error('MOCK_NETWORK_ERROR');
      err.isNetworkError = true;
      throw err;
    }

    mockSequence += 1;
    const chaveAcesso = `MOCK${Date.now()}${mockSequence}`;
    return {
      success: true,
      xml: `<NFSe><infNFSe id="${chaveAcesso}"><cStat>100</cStat><nNFSe>${mockSequence}</nNFSe></infNFSe></NFSe>`,
      fields: { cStat: 100, chaveAcesso, nNFSe: mockSequence, ambGer: 1, tpEmis: 2 }
    };
  }

  async queryByChave(chaveAcesso) {
    return { cStat: 100, chaveAcesso };
  }

  async registerEvent(_chaveAcesso, _eventPayload) {
    return { success: true };
  }

  async listEvents(_chaveAcesso) {
    return [];
  }

  async getDanfse(_chaveAcesso) {
    return { pdfBase64: 'TU9DS19QREY=' }; // "MOCK_PDF" em base64
  }
}
