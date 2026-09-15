// services/fiscal/TestFiscalConnectionService.js
// Diagnóstico de conectividade mTLS — não emite nada, não monta DPS, não assina XML. Só carrega
// o certificado do FiscalProfile ativo, monta o https.Agent e faz UMA chamada GET real contra o
// provider resolvido, devolvendo um diagnóstico estruturado. Existe pra responder "o certificado
// ainda está funcionando?" sem precisar escrever um script descartável toda vez — útil sobretudo
// quando o certificado for renovado/trocado no futuro.

import https from 'node:https';
import { fiscalProfileRepository } from '../../infrastructure/persistence/FiscalProfileRepository.js';
import { certificateRepository } from '../../infrastructure/persistence/CertificateRepository.js';
import { resolveProviderName } from '../../fiscal-provider/FiscalProviderResolver.js';
import { buildCertificateContext } from '../../fiscal-provider/buildCertificateContext.js';
import { FiscalProviderName } from '../../constants/fiscalProviders.js';
import { FiscalAmbiente } from '../../constants/fiscalEnums.js';
import { ENDPOINTS as ANAPOLIS_ENDPOINTS } from '../../adapters/fiscal/AnapolisMunicipalAdapter.js';

const REQUEST_TIMEOUT_MS = 15000;

// basePath real confirmado em 2026-07-29 lendo o Swagger oficial com mTLS — ver
// adapters/fiscal/SefinNacionalAdapter.js para o histórico completo do achado.
const SEFIN_HOSTS = {
  [FiscalAmbiente.PRODUCAO]: 'sefin.nfse.gov.br',
  [FiscalAmbiente.PRODUCAO_RESTRITA]: 'sefin.producaorestrita.nfse.gov.br'
};
const SEFIN_BASE_PATH = '/SefinNacional';
// Endpoint de diagnóstico: consulta por uma chave inexistente (50 zeros). Resposta esperada se
// tudo estiver certo é um 404 estruturado (não um erro de handshake TLS) — ver achado real
// documentado em go_live_nfse.md, Bloco "Bloqueadores atuais".
const DIAGNOSTIC_CHAVE = '0'.repeat(50);

function get(hostname, path, agent) {
  const start = Date.now();
  return new Promise((resolve) => {
    const req = https.request({ hostname, path, method: 'GET', agent, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        connected: true,
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8').slice(0, 1000),
        duration: Date.now() - start
      }));
    });
    req.on('error', (error) => resolve({
      connected: false,
      error: error.code || error.message,
      duration: Date.now() - start
    }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ connected: false, error: 'TIMEOUT', duration: Date.now() - start });
    });
    req.end();
  });
}

/**
 * @param {string} [cnpj] - se omitido, usa o primeiro FiscalProfile ativo encontrado
 * @returns {Promise<Object>} diagnóstico estruturado — nunca lança, sempre devolve um objeto
 *   descrevendo o que deu certo/errado, pra ser exposto direto como resposta HTTP.
 */
export async function testFiscalConnection(cnpj) {
  const resolvedProfile = cnpj
    ? await fiscalProfileRepository.findActiveByCnpj(cnpj)
    : await fiscalProfileRepository.findFirstActive();

  if (!resolvedProfile) {
    return { ok: false, step: 'fiscal_profile', message: 'Nenhum FiscalProfile ativo encontrado (configure o perfil fiscal primeiro).' };
  }

  if (!resolvedProfile.certificateRef) {
    return { ok: false, step: 'certificate_lookup', message: 'Perfil fiscal não tem certificado vinculado.', fiscalProfileCnpj: resolvedProfile.cnpj };
  }

  const certificate = await certificateRepository.findById(resolvedProfile.certificateRef);
  if (!certificate) {
    return { ok: false, step: 'certificate_lookup', message: 'Certificado vinculado não encontrado no banco (referência quebrada).', fiscalProfileCnpj: resolvedProfile.cnpj };
  }

  let httpsAgent;
  try {
    ({ httpsAgent } = buildCertificateContext(certificate));
  } catch (error) {
    return {
      ok: false,
      step: 'decrypt',
      message: `Falha ao decifrar o certificado: ${error.message}`,
      certificate: { originalFilename: certificate.originalFilename, status: certificate.status }
    };
  }

  if (!httpsAgent) {
    return { ok: false, step: 'decrypt', message: 'Certificado sem arquivo criptografado válido.', certificate: { originalFilename: certificate.originalFilename } };
  }

  const providerName = resolveProviderName(resolvedProfile);
  const daysUntilExpiry = certificate.expiresAt
    ? Math.floor((new Date(certificate.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  const certificateInfo = {
    originalFilename: certificate.originalFilename,
    issuer: certificate.issuer,
    expiresAt: certificate.expiresAt,
    daysUntilExpiry,
    status: certificate.status
  };

  let host;
  let path;
  if (providerName === FiscalProviderName.SEFIN_NACIONAL) {
    host = SEFIN_HOSTS[resolvedProfile.ambiente] || SEFIN_HOSTS[FiscalAmbiente.PRODUCAO_RESTRITA];
    path = `${SEFIN_BASE_PATH}/nfse/${DIAGNOSTIC_CHAVE}`;
  } else if (providerName === FiscalProviderName.ANAPOLIS_MUNICIPAL) {
    const endpoint = ANAPOLIS_ENDPOINTS[resolvedProfile.ambiente] || ANAPOLIS_ENDPOINTS[FiscalAmbiente.PRODUCAO_RESTRITA];
    const url = new URL(endpoint);
    host = url.hostname;
    path = url.pathname;
  } else {
    return {
      ok: false,
      step: 'provider_not_supported',
      message: `Diagnóstico de conectividade real não está implementado para o provider ${providerName}.`,
      providerName,
      certificate: certificateInfo
    };
  }

  // Requisição única GET (sem corpo SOAP, sem DPS) — para o .asmx da Nota Control isso é o
  // comportamento padrão de um serviço ASP.NET: devolve a página de descrição do serviço ou um
  // erro estruturado, nunca aciona RecepcionarLoteDpsSincrono nem qualquer emissão.
  const result = await get(host, path, httpsAgent);

  if (!result.connected) {
    // 495 e outros erros de handshake TLS chegam aqui como erro de conexão, não como status HTTP.
    return {
      ok: false,
      step: 'tls_handshake',
      tls: false,
      certificateAccepted: false,
      providerName,
      error: result.error,
      host,
      path,
      duration: result.duration,
      certificate: certificateInfo
    };
  }

  // Qualquer resposta HTTP (mesmo 4xx/5xx) prova que o handshake TLS completou e o certificado
  // foi aceito o suficiente pra chegar na camada de aplicação — só um erro de conexão (acima)
  // ou um 495 explícito (SSL Certificate Error, hosts que rejeitam na borda) indicam rejeição.
  // Para Anápolis, um 403/ACCESS_DENIED (confirmado nos testes desta auditoria — causa ainda não
  // determinada, ver docs/nfse-fiscal-module/anapolis_audit_2026-09-11.md §5) também chega aqui
  // como resposta de aplicação, não como falha de handshake — `ok` reflete isso corretamente: a
  // conexão/TLS funcionou, algo na aplicação/borda do provedor é quem devolveu 403.
  const isSslRejection = result.status === 495;

  const diagnostic = {
    ok: !isSslRejection,
    step: isSslRejection ? 'tls_handshake' : 'application_response',
    tls: true,
    certificateAccepted: !isSslRejection,
    httpStatus: result.status,
    providerName,
    host,
    path,
    ambiente: resolvedProfile.ambiente,
    duration: result.duration,
    responseBody: result.body,
    certificate: certificateInfo
  };

  if (providerName === FiscalProviderName.ANAPOLIS_MUNICIPAL) {
    // Informativo, não afeta `ok` — checa se o WSDL do próprio endpoint e o .xsd público do
    // provedor estão acessíveis agora, sem exigir DPS/lote. `schemaDownload` não usa o
    // certificado do contribuinte (é um download público, não faz parte do webservice SOAP).
    diagnostic.wsdlAvailable = await probeGetOk(host, `${path}?WSDL`, httpsAgent);
    diagnostic.schemaDownloadAvailable = await probeGetOk('www.notacontrol.com.br', '/download/nfse/schema_v101.xsd');
  }

  return diagnostic;
}

/** Probe leve: só diz se um GET chegou a uma resposta HTTP (qualquer status), sem devolver corpo. */
async function probeGetOk(hostname, path, agent) {
  const result = await get(hostname, path, agent);
  return result.connected ? { reachable: true, httpStatus: result.status } : { reachable: false, error: result.error };
}
