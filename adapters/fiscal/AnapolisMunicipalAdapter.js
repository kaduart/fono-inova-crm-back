// Adapter do Webservice municipal de Anápolis, operado pela Nota Control/ISSNET.
// Contrato: Manual de Integração Webservice v1.01, rev. 03/08/2026. O transporte é SOAP
// Document/Literal wrapped e a emissão unitária é enviada como lote síncrono de uma DPS.

import https from 'node:https';
import { FiscalProvider } from '../../fiscal-provider/FiscalProvider.js';
import { FiscalAmbiente } from '../../constants/fiscalEnums.js';
import { extractFieldsFromNfseResponseXml } from '../../fiscal-provider/DpsBuilder.js';

const ENDPOINTS = {
  [FiscalAmbiente.PRODUCAO]: 'https://nfse.issnetonline.com.br/wsnfsenacional/anapolis/nfse.asmx',
  [FiscalAmbiente.PRODUCAO_RESTRITA]: 'https://nfse.issnetonline.com.br/wsnfsenacional/homologacao/nfse.asmx'
};
const NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse';
const OPERATION = 'RecepcionarLoteDpsSincrono';
const TIMEOUT_MS = 30000;

const escapeXml = (value) => String(value || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const decodeXml = (value) => String(value || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const tagValue = (xml, tag) => {
  const match = String(xml || '').match(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i'));
  return match?.[1]?.trim() || null;
};

export function buildNotaControlBatchXml(signedDpsXml, { cnpj, inscricaoMunicipal, numeroLote }) {
  const dps = signedDpsXml.replace(/^<\?xml[^>]*>\s*/i, '');
  return `<EnviarLoteDpsSincronoEnvio xmlns="${NAMESPACE}"><LoteDps Id="Lote${numeroLote}" versao="1.01">` +
    `<NumeroLote>${numeroLote}</NumeroLote><Prestador><CNPJ>${escapeXml(cnpj)}</CNPJ>` +
    `<IM>${escapeXml(inscricaoMunicipal)}</IM></Prestador><QuantidadeDps>1</QuantidadeDps>` +
    `<ListaDps>${dps}</ListaDps></LoteDps></EnviarLoteDpsSincronoEnvio>`;
}

export function buildNotaControlSoapRequest(signedBatchXml) {
  const cabecalho = `<cabecalho versao="1.01" xmlns="${NAMESPACE}"><versaoDados>1.01</versaoDados></cabecalho>`;

  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:nfse="${NAMESPACE}">` +
    `<soap:Body><nfse:${OPERATION}><nfseCabecMsg>${cabecalho}</nfseCabecMsg>` +
    `<nfseDadosMsg>${signedBatchXml}</nfseDadosMsg></nfse:${OPERATION}></soap:Body></soap:Envelope>`;
}

export function parseNotaControlResponse(soapXml) {
  const result = tagValue(soapXml, `${OPERATION}Result`) || tagValue(soapXml, 'return') || soapXml;
  const payload = decodeXml(result);
  const errorCode = tagValue(payload, 'Codigo');
  const errorMessage = tagValue(payload, 'Mensagem');
  if (errorCode || errorMessage) {
    return {
      success: false,
      error: { code: errorCode || 'NOTA_CONTROL_REJEICAO', message: errorMessage, correction: tagValue(payload, 'Correcao'), body: payload }
    };
  }
  const nfseXml = tagValue(payload, 'CompNfse') || (/<(?:\w+:)?NFSe[\s>]/i.test(payload) ? payload : null);
  if (!nfseXml) {
    return { success: false, error: { code: 'NOTA_CONTROL_RESPOSTA_INESPERADA', body: payload } };
  }
  return { success: true, xml: nfseXml, fields: extractFieldsFromNfseResponseXml(nfseXml) };
}

export class AnapolisMunicipalAdapter extends FiscalProvider {
  constructor({ ambiente = FiscalAmbiente.PRODUCAO_RESTRITA, httpsAgent, fiscalProfile, certManager } = {}) {
    super();
    this.endpoint = ENDPOINTS[ambiente];
    this.httpsAgent = httpsAgent;
    this.fiscalProfile = fiscalProfile;
    this.certManager = certManager;
  }

  _request(body) {
    const startedAt = Date.now();
    const url = new URL(this.endpoint);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        agent: this.httpsAgent,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: `"${NAMESPACE}/${OPERATION}"`,
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          diagnostics: { endpoint: this.endpoint, httpStatus: res.statusCode, request: body, response: Buffer.concat(chunks).toString('utf8'), duration: Date.now() - startedAt }
        }));
      });
      req.setTimeout(TIMEOUT_MS, () => req.destroy(Object.assign(new Error('Timeout na Nota Control'), { isTimeout: true })));
      req.on('error', (error) => {
        error.diagnostics = { endpoint: this.endpoint, request: body, response: error.message, duration: Date.now() - startedAt };
        reject(error);
      });
      req.write(body);
      req.end();
    });
  }

  async submitDps(signedDpsXml) {
    if (!this.fiscalProfile?.cnpj || !this.fiscalProfile?.inscricaoMunicipal) {
      throw new Error('NOTA_CONTROL_PERFIL_INCOMPLETO: CNPJ e inscrição municipal são obrigatórios');
    }
    const nDps = tagValue(signedDpsXml, 'nDPS');
    if (!this.certManager?.signElement) throw new Error('NOTA_CONTROL_ASSINADOR_DE_LOTE_AUSENTE');
    const batchXml = buildNotaControlBatchXml(signedDpsXml, {
      cnpj: this.fiscalProfile.cnpj,
      inscricaoMunicipal: this.fiscalProfile.inscricaoMunicipal,
      numeroLote: nDps
    });
    const signedBatchXml = await this.certManager.signElement(batchXml, {
      id: `Lote${nDps}`,
      rootLocalName: 'EnviarLoteDpsSincronoEnvio',
      notaControl: true
    });
    const request = buildNotaControlSoapRequest(signedBatchXml);
    const { status, body, diagnostics } = await this._request(request);
    if (status < 200 || status >= 300) {
      return { success: false, error: { httpStatus: status, body }, diagnostics };
    }
    return { ...parseNotaControlResponse(body), diagnostics };
  }

  async queryByChave() { throw new Error('NOTA_CONTROL_CONSULTA_POR_CHAVE_NAO_IMPLEMENTADA'); }
  async registerEvent() { throw new Error('NOTA_CONTROL_EVENTO_NAO_IMPLEMENTADO'); }
  async listEvents() { throw new Error('NOTA_CONTROL_EVENTOS_NAO_IMPLEMENTADO'); }
  async getDanfse() { throw new Error('NOTA_CONTROL_DANFSE_NAO_IMPLEMENTADO'); }
}
