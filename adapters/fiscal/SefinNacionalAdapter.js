// adapters/fiscal/SefinNacionalAdapter.js
// Municipal Adapter para a Sefin Nacional — corrigido em 2026-07-29 contra o Swagger REAL
// (`GET /SefinNacional/swagger/docs/v1`, obtido com mTLS usando o certificado A1 real da
// clínica), depois que a suposição original (baseada só na prosa dos manuais, Fase 1) se provou
// incompleta em dois pontos importantes:
//
//   1. **basePath**: é `/SefinNacional`, não a raiz do host. `host: sefin.producaorestrita.
//      nfse.gov.br` + `basePath: /SefinNacional` — confirmado no próprio spec, não é suposição.
//   2. **Corpo de `POST /nfse` e `POST /nfse/{chave}/eventos` NÃO é XML puro** — é JSON contendo
//      o XML compactado em gzip e codificado em base64: `{"dpsXmlGZipB64": "..."}` e
//      `{"pedidoRegistroEventoXmlGZipB64": "..."}`, respectivamente (schemas `NFSePostRequest`/
//      `EventosPostRequest` do spec real). A resposta de sucesso (201) também é JSON, com
//      `chaveAcesso` disponível direto (não precisa extrair do XML) e o XML da NFS-e emitida em
//      `nfseXmlGZipB64` (mesmo formato gzip+base64).
//
// `/ParametrosMunicipais` e `/DANFSe` deste host retornam 501 — descontinuados, movidos para
// `adn.producaorestrita.nfse.gov.br/parametrizacao/` e `/danfse/` respectivamente (confirmado no
// próprio spec, campo `summary` do path).
//
// mTLS: usa `https` nativo do Node (não `fetch`/undici) porque `https.request`/`https.Agent`
// aceitam `pfx`+`passphrase` diretamente — certificado cliente sem dependência nova. `httpsAgent`
// é um `https.Agent` já construído com o certificado decifrado (services/fiscal/
// _attemptSubmission.js); undefined = sem certificado, chamada real falha no handshake (esperado).
//
// Desacoplamento de persistência (correção de review): o Adapter NÃO grava ProviderTransaction —
// isso acoplaria a Provider Layer à tecnologia de banco (Mongo) e dificultaria testar o Adapter
// isolado. Cada chamada retorna/lança um objeto `diagnostics` com os dados brutos da execução
// HTTP; quem decide persistir é a camada de aplicação que orquestra o Adapter (PR4), chamando
// `recordProviderTransaction()` (fiscal-provider/recordProviderTransaction.js) com esse
// `diagnostics`.

import https from 'node:https';
import zlib from 'node:zlib';
import { FiscalProvider } from '../../fiscal-provider/FiscalProvider.js';
import { FiscalAmbiente } from '../../constants/fiscalEnums.js';
import { extractFieldsFromNfseResponseXml } from '../../fiscal-provider/DpsBuilder.js';

const REQUEST_TIMEOUT_MS = 30000;

// basePath confirmado no spec real para Produção Restrita. A URL de Produção listada na doc
// oficial (apis-prod-restrita-e-producao) usa o mesmo segmento `/SefinNacional` sem `/API/` —
// mantido por simetria, ainda não verificado com chamada real (só Produção Restrita foi testada).
const HOSTS = {
  [FiscalAmbiente.PRODUCAO]: {
    sefin: 'https://sefin.nfse.gov.br/SefinNacional',
    adn: 'https://adn.nfse.gov.br'
  },
  [FiscalAmbiente.PRODUCAO_RESTRITA]: {
    sefin: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
    adn: 'https://adn.producaorestrita.nfse.gov.br'
  }
};

const gzipBase64 = (str) => zlib.gzipSync(Buffer.from(str, 'utf8')).toString('base64');
const gunzipBase64 = (b64) => zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');

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
   * `https.request` (não `fetch`) para poder usar `this.httpsAgent` (https.Agent com
   * pfx/passphrase) no handshake mTLS.
   */
  _request(urlString, { method = 'GET', headers = {}, body } = {}) {
    const start = Date.now();
    const url = new URL(urlString);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          agent: this.httpsAgent // undefined = agente padrão, sem certificado cliente
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const responseBody = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode,
              body: responseBody,
              diagnostics: {
                endpoint: urlString,
                httpStatus: res.statusCode,
                request: body,
                response: responseBody,
                duration: Date.now() - start
              }
            });
          });
        }
      );

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(Object.assign(new Error('Timeout na chamada ao provider fiscal'), { isTimeout: true }));
      });

      req.on('error', (error) => {
        error.isTimeout = error.isTimeout || false;
        error.diagnostics = {
          endpoint: urlString,
          request: body,
          response: error.message,
          duration: Date.now() - start
        };
        reject(error);
      });

      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * POST /nfse — emissão síncrona. Corpo real: JSON `{dpsXmlGZipB64}` (XML assinado, gzip,
   * base64) — confirmado no spec real 2026-07-29, não é XML puro como versões anteriores
   * assumiam.
   */
  async submitDps(signedDpsXml) {
    const requestBody = JSON.stringify({ dpsXmlGZipB64: gzipBase64(signedDpsXml) });
    const { status, body, diagnostics } = await this._request(`${this.hosts.sefin}/nfse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody
    });

    if (status >= 200 && status < 300) {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        // Resposta 2xx que não veio como JSON — não deveria acontecer segundo o spec, mas não
        // inventa sucesso silencioso: devolve como se fosse rejeição, com o corpo bruto pra depurar.
        return { success: false, error: { httpStatus: status, body }, diagnostics };
      }
      const nfseXml = parsed.nfseXmlGZipB64 ? gunzipBase64(parsed.nfseXmlGZipB64) : null;
      const fieldsFromXml = nfseXml ? extractFieldsFromNfseResponseXml(nfseXml) : {};
      return {
        success: true,
        xml: nfseXml,
        fields: { ...fieldsFromXml, chaveAcesso: parsed.chaveAcesso || fieldsFromXml.chaveAcesso },
        diagnostics
      };
    }

    let parsedError = body;
    try {
      parsedError = JSON.parse(body);
    } catch {
      // corpo de erro não veio como JSON — mantém texto bruto
    }
    return { success: false, error: { httpStatus: status, body: parsedError }, diagnostics };
  }

  /** GET /nfse/{chaveAcesso} — resposta é JSON (NFSeGetResponseSucesso), não confirmado em detalhe ainda. */
  async queryByChave(chaveAcesso) {
    const { body, diagnostics } = await this._request(`${this.hosts.sefin}/nfse/${chaveAcesso}`, { method: 'GET' });
    return { body, diagnostics };
  }

  /**
   * POST /nfse/{chaveAcesso}/eventos — corpo real: JSON `{pedidoRegistroEventoXmlGZipB64}`
   * (mesmo padrão gzip+base64 do `submitDps`, confirmado no spec real 2026-07-29).
   */
  async registerEvent(chaveAcesso, signedEventXml) {
    const requestBody = JSON.stringify({ pedidoRegistroEventoXmlGZipB64: gzipBase64(signedEventXml) });
    const { status, body, diagnostics } = await this._request(`${this.hosts.sefin}/nfse/${chaveAcesso}/eventos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody
    });
    return { success: status >= 200 && status < 300, body, diagnostics };
  }

  /** GET /nfse/{chaveAcesso}/eventos/{tipoEvento}/{numSeqEvento} — consulta de evento específico (spec real; não existe listagem genérica de todos os eventos neste host). */
  async listEvents(chaveAcesso, tipoEvento, numSeqEvento) {
    const { body, diagnostics } = await this._request(
      `${this.hosts.sefin}/nfse/${chaveAcesso}/eventos/${tipoEvento}/${numSeqEvento}`,
      { method: 'GET' }
    );
    return { body, diagnostics };
  }

  /**
   * GET /danfse/{chaveAcesso} — descontinuado neste host (spec real: 501, "movido para
   * adn.../danfse/docs/index.html"). Mantido apontando pro ADN, que é onde o serviço real vive
   * segundo a doc oficial (apis-prod-restrita-e-producao) — não testado nesta sessão.
   */
  async getDanfse(chaveAcesso) {
    const { body, diagnostics } = await this._request(`${this.hosts.adn}/danfse/${chaveAcesso}`, { method: 'GET' });
    return { pdf: body, diagnostics };
  }
}
