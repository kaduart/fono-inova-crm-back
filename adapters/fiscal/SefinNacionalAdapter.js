// adapters/fiscal/SefinNacionalAdapter.js
// Municipal Adapter para a Sefin Nacional / ADN — endpoints confirmados na Fase 1
// (project_nfse_phase1_official_spec.md, Seção 3.2/3.6). Estruturalmente completo, mas não
// testado contra o ambiente real: exige certificado digital para mTLS, que ainda não existe
// neste projeto (CertificateManager só tem implementação Mock).
//
// Hosts confirmados (Fase 1, Seção 4):
//   Produção Restrita: sefin.producaorestrita.nfse.gov.br / adn.producaorestrita.nfse.gov.br
//   Produção:          sefin.nfse.gov.br / adn.nfse.gov.br
//
// Desacoplamento de persistência (correção de review): o Adapter NÃO grava ProviderTransaction —
// isso acoplaria a Provider Layer à tecnologia de banco (Mongo) e dificultaria testar o Adapter
// isolado. Cada chamada retorna/lança um objeto `diagnostics` com os dados brutos da execução
// HTTP; quem decide persistir é a camada de aplicação que orquestra o Adapter (PR4), chamando
// `recordProviderTransaction()` (fiscal-provider/recordProviderTransaction.js) com esse
// `diagnostics`.

import { FiscalProvider } from '../../fiscal-provider/FiscalProvider.js';
import { FiscalAmbiente } from '../../constants/fiscalEnums.js';

const HOSTS = {
  [FiscalAmbiente.PRODUCAO]: { sefin: 'https://sefin.nfse.gov.br', adn: 'https://adn.nfse.gov.br' },
  [FiscalAmbiente.PRODUCAO_RESTRITA]: {
    sefin: 'https://sefin.producaorestrita.nfse.gov.br',
    adn: 'https://adn.producaorestrita.nfse.gov.br'
  }
};

export class SefinNacionalAdapter extends FiscalProvider {
  /**
   * @param {{ ambiente: string, httpsAgent?: object }} config
   *   `httpsAgent` deve carregar o certificado cliente (mTLS) — hoje sempre undefined, pois não
   *   há certificado real disponível. Chamadas reais vão falhar no handshake TLS até isso ser
   *   resolvido — comportamento esperado, não um bug deste adapter.
   */
  constructor({ ambiente = FiscalAmbiente.PRODUCAO_RESTRITA, httpsAgent } = {}) {
    super();
    this.hosts = HOSTS[ambiente];
    this.httpsAgent = httpsAgent;
  }

  /**
   * Executa a chamada e sempre devolve `diagnostics` (mesmo em erro) — puro I/O, sem tocar
   * persistência. `diagnostics` tem o shape esperado por `recordProviderTransaction()`.
   */
  async _request(url, options) {
    const start = Date.now();
    try {
      const response = await fetch(url, { ...options, dispatcher: this.httpsAgent });
      const body = await response.text();
      return {
        status: response.status,
        body,
        diagnostics: {
          endpoint: url,
          httpStatus: response.status,
          request: options.body,
          response: body,
          duration: Date.now() - start
        }
      };
    } catch (error) {
      error.diagnostics = {
        endpoint: url,
        request: options.body,
        response: error.message,
        duration: Date.now() - start
      };
      throw error;
    }
  }

  /** POST /nfse (Sefin Nacional) — emissão síncrona (Fase 1, Seção 3.2/6) */
  async submitDps(signedDpsXml) {
    const { status, body, diagnostics } = await this._request(`${this.hosts.sefin}/nfse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: signedDpsXml
    });

    if (status >= 200 && status < 300) {
      return { success: true, xml: body, diagnostics };
    }
    return { success: false, error: { httpStatus: status, body }, diagnostics };
  }

  /** GET /nfse/{chaveAcesso} */
  async queryByChave(chaveAcesso) {
    const { body, diagnostics } = await this._request(`${this.hosts.sefin}/nfse/${chaveAcesso}`, { method: 'GET' });
    return { body, diagnostics };
  }

  /** POST /nfse/{chaveAcesso}/eventos (Fase 1, Seção 3.3) */
  async registerEvent(chaveAcesso, eventPayload) {
    const { status, body, diagnostics } = await this._request(`${this.hosts.sefin}/nfse/${chaveAcesso}/eventos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: eventPayload
    });
    return { success: status >= 200 && status < 300, body, diagnostics };
  }

  /** GET /nfse/{chaveAcesso}/eventos */
  async listEvents(chaveAcesso) {
    const { body, diagnostics } = await this._request(`${this.hosts.sefin}/nfse/${chaveAcesso}/eventos`, { method: 'GET' });
    return { body, diagnostics };
  }

  /** GET /danfse/{chaveAcesso} (ADN, Fase 1 Seção 3.6) */
  async getDanfse(chaveAcesso) {
    const { body, diagnostics } = await this._request(`${this.hosts.adn}/danfse/${chaveAcesso}`, { method: 'GET' });
    return { pdf: body, diagnostics };
  }
}
