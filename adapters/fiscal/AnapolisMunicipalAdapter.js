// Adapter do Webservice municipal de Anápolis, operado pela Nota Control/ISSNET.
// Contrato: Manual de Integração Webservice v1.01, rev. 03/08/2026. O transporte é SOAP
// Document/Literal wrapped e a emissão unitária é enviada como lote síncrono de uma DPS.

import https from 'node:https';
import { FiscalProvider } from '../../fiscal-provider/FiscalProvider.js';
import { FiscalAmbiente } from '../../constants/fiscalEnums.js';
import { extractFieldsFromNfseResponseXml } from '../../fiscal-provider/DpsBuilder.js';

// Exportado (além de usado internamente) para o diagnóstico de conectividade municipal
// (TestFiscalConnectionService) reusar exatamente o mesmo endpoint por ambiente, sem duplicar as
// URLs num segundo lugar e arriscar os dois desalinharem.
export const ENDPOINTS = {
  [FiscalAmbiente.PRODUCAO]: 'https://nfse.issnetonline.com.br/wsnfsenacional/anapolis/nfse.asmx',
  [FiscalAmbiente.PRODUCAO_RESTRITA]: 'https://nfse.issnetonline.com.br/wsnfsenacional/homologacao/nfse.asmx'
};
const NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse';
const OPERATION = 'RecepcionarLoteDpsSincrono';
// Manual v1.01, §9.2.6/7.2.6: único serviço de consulta aplicável a uma DPS enviada pelo fluxo
// síncrono (RecepcionarLoteDpsSincrono não gera protocolo de lote assíncrono para ConsultarLoteDps
// consultar depois — a única identidade estável que sobra após um timeout é Série+Número da DPS).
const CONSULTA_OPERATION = 'ConsultarNfsePorDps';
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

// §7.4: toda operação usa o mesmo envelope cabecalho+dados — confirmado também no exemplo do
// validador de schema (§14, Request 1) para um método diferente (ValidarXml). Generalizado aqui
// para qualquer `operation`/`dadosMsg`, não só o envio de lote.
export function buildNotaControlSoapRequest(dadosMsgXml, operation = OPERATION) {
  const cabecalho = `<cabecalho versao="1.01" xmlns="${NAMESPACE}"><versaoDados>1.01</versaoDados></cabecalho>`;

  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:nfse="${NAMESPACE}">` +
    `<soap:Body><nfse:${operation}><nfseCabecMsg>${cabecalho}</nfseCabecMsg>` +
    `<nfseDadosMsg>${dadosMsgXml}</nfseDadosMsg></nfse:${operation}></soap:Body></soap:Envelope>`;
}

// Manual §9.2.6, tcIdentificacaoDps (SerieDPS+NumDPS) + tcIdentificacaoPessoaEmpresaComIM
// (CNPJ/CPF+IM) — não é assinada: §7.3.5 só lista DPS, Lote de DPS e NFS-e/Eventos como
// assináveis, mensagens de consulta não constam.
export function buildConsultarNfseDpsXml({ serie, nDPS, cnpj, inscricaoMunicipal }) {
  return `<ConsultarNfseDpsEnvio xmlns="${NAMESPACE}">` +
    `<IdentificacaoDps><SerieDPS>${escapeXml(serie)}</SerieDPS><NumDPS>${escapeXml(nDPS)}</NumDPS></IdentificacaoDps>` +
    `<Prestador><CNPJ>${escapeXml(cnpj)}</CNPJ><IM>${escapeXml(inscricaoMunicipal)}</IM></Prestador>` +
    `</ConsultarNfseDpsEnvio>`;
}

// Endurecido em 2026-09-11 (fechamento da etapa municipal): este adapter NUNCA retorna
// status:'not_found'. Sem uma amostra real de homologação, não há como confirmar se uma mensagem
// de "não encontrado" significa (a) a DPS nunca chegou ao provedor, (b) ainda está em
// processamento, ou (c) foi processada mas indexada sob outra chave — tratar qualquer uma dessas
// como sinal de "seguro reenviar" seria inventar uma garantia que o manual não dá. Toda resposta
// que não seja uma autorização completa (chaveAcesso+nNFSe+cStat) cai em 'unknown'; o texto da
// mensagem some só no `reason`, para diagnóstico humano, nunca na decisão automática de retry.
// Esse regex portanto não decide o `status` — só enriquece o `reason` quando aplicável.
const POSSIBLE_NOT_FOUND_PATTERN = /n[aã]o\s*(foi\s*)?encontrad[ao]|n[aã]o\s*exist(e|ente)/i;

export function parseConsultarNfseDpsResponse(soapXml) {
  const result = tagValue(soapXml, `${CONSULTA_OPERATION}Result`) || tagValue(soapXml, 'return') || soapXml;
  const payload = decodeXml(result);
  const nfseXml = tagValue(payload, 'CompNfse') || (/<(?:\w+:)?NFSe[\s>]/i.test(payload) ? payload : null);
  if (nfseXml) {
    const fields = extractFieldsFromNfseResponseXml(nfseXml);
    if (fields.chaveAcesso && fields.nNFSe && fields.cStat) {
      return { status: 'authorized', fields, xml: nfseXml };
    }
    return { status: 'unknown', reason: 'NOTA_CONTROL_CONSULTA_NFSE_INCOMPLETA' };
  }
  const errorMessage = tagValue(payload, 'Mensagem') || tagValue(payload, 'Codigo');
  if (!errorMessage) return { status: 'unknown', reason: 'NOTA_CONTROL_CONSULTA_RESPOSTA_INESPERADA' };
  const possibleNotFound = POSSIBLE_NOT_FOUND_PATTERN.test(errorMessage);
  return {
    status: 'unknown',
    reason: possibleNotFound
      ? `NOTA_CONTROL_CONSULTA_POSSIVEL_NAO_ENCONTRADO_NAO_CONFIRMADO: ${errorMessage}`
      : `NOTA_CONTROL_CONSULTA_MENSAGEM_NAO_RECONHECIDA: ${errorMessage}`
  };
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

  _request(body, operation = OPERATION) {
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
          SOAPAction: `"${NAMESPACE}/${operation}"`,
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
    const request = buildNotaControlSoapRequest(signedBatchXml, OPERATION);
    const { status, body, diagnostics } = await this._request(request, OPERATION);
    if (status < 200 || status >= 300) {
      return { success: false, error: { httpStatus: status, body }, diagnostics };
    }
    return { ...parseNotaControlResponse(body), diagnostics };
  }

  /**
   * Reconciliação após timeout/resultado indeterminado — nunca reenvia a DPS. Usa
   * `ConsultarNfsePorDps` (manual §9.2.6), a única consulta com identidade estável disponível
   * depois de `RecepcionarLoteDpsSincrono` (não há protocolo de lote assíncrono para consultar).
   * Nunca lança: qualquer falha vira `{status:'unknown', reason}` para o chamador decidir com
   * segurança (reconciliation_required), nunca autorizar reenvio por omissão.
   *
   * `cnpj`/`inscricaoMunicipal`: identidade do prestador usada NA TENTATIVA ORIGINAL — quem chama
   * (services/fiscal/_attemptSubmission.js) deve passá-los lidos do FiscalSnapshot imutável dessa
   * tentativa, nunca do FiscalProfile atual (pode ter mudado desde a tentativa original). Caem no
   * fallback de `this.fiscalProfile` só quando não informados — uso direto/diagnóstico deste
   * adapter fora do fluxo de reconciliação normal (ex. chamada manual, teste), nunca o caminho que
   * decide se um reenvio é seguro.
   */
  async reconcileDps({ serie, nDPS, cnpj, inscricaoMunicipal }) {
    if (!serie || !nDPS) return { status: 'unknown', reason: 'DPS_IDENTITY_MISSING' };
    const resolvedCnpj = cnpj || this.fiscalProfile?.cnpj;
    const resolvedIM = inscricaoMunicipal || this.fiscalProfile?.inscricaoMunicipal;
    if (!resolvedCnpj || !resolvedIM) {
      return { status: 'unknown', reason: 'NOTA_CONTROL_IDENTIDADE_PRESTADOR_INDISPONIVEL' };
    }
    const consultaXml = buildConsultarNfseDpsXml({ serie, nDPS, cnpj: resolvedCnpj, inscricaoMunicipal: resolvedIM });
    const request = buildNotaControlSoapRequest(consultaXml, CONSULTA_OPERATION);
    try {
      const { status, body, diagnostics } = await this._request(request, CONSULTA_OPERATION);
      if (status < 200 || status >= 300) {
        return { status: 'unknown', reason: `NOTA_CONTROL_CONSULTA_HTTP_${status}`, diagnostics };
      }
      return { ...parseConsultarNfseDpsResponse(body), diagnostics };
    } catch (error) {
      return { status: 'unknown', reason: error.isTimeout ? 'NOTA_CONTROL_CONSULTA_TIMEOUT' : (error.message || 'NOTA_CONTROL_CONSULTA_ERRO'), diagnostics: error.diagnostics };
    }
  }

  async queryByChave() { throw new Error('NOTA_CONTROL_CONSULTA_POR_CHAVE_NAO_IMPLEMENTADA'); }
  async registerEvent() { throw new Error('NOTA_CONTROL_EVENTO_NAO_IMPLEMENTADO'); }
  async listEvents() { throw new Error('NOTA_CONTROL_EVENTOS_NAO_IMPLEMENTADO'); }
  async getDanfse() { throw new Error('NOTA_CONTROL_DANFSE_NAO_IMPLEMENTADO'); }
}
