// fiscal-provider/CertificateManager.js
// Provider Layer. Assinatura digital real implementada em 2026-07-29 — decisão A1 confirmada
// pelo usuário (decisoes_fiscais_clinica.md #2), certificado já sai criptografado do banco
// (utils/certificateCrypto.js), então este arquivo só recebe os bytes já decifrados.
//
// Dependências novas (autorizadas explicitamente antes de adicionar, como combinado):
//   - node-forge: parseia o .pfx (PKCS#12) e extrai chave privada + certificado X.509.
//   - xml-crypto: assina a DPS no padrão XML-DSig (enveloped signature).
//
// ⚠️ Convenção de assinatura ASSUMIDA, não confirmada contra o XSD/Swagger oficial (que continua
// bloqueado por exigir certificado real para acessar — Fase 1, Seção 3.8): enveloped signature,
// canonicalização exclusiva (C14N-exc), digest SHA-256, algoritmo RSA-SHA256 — é o padrão comum
// de documentos fiscais brasileiros (NFe/ICP-Brasil), mas precisa ser validado contra a resposta
// real da Sefin Nacional em Produção Restrita assim que o certificado A1 verdadeiro estiver
// disponível. Se a Sefin rejeitar por schema de assinatura, é aqui que ajustar — não é suposição
// silenciosa, está documentada.
//
// Interface deliberadamente pequena — só `sign()`. "É esse certificado usável?" já é respondido
// pelo domínio (domain/fiscal/validators/EmissionEligibilityValidator.js, que checa
// Certificate.status direto no repositório) — duplicar essa checagem aqui seria a mesma regra em
// dois lugares.

import crypto from 'node:crypto';
import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';

const dnToString = (dn) => dn.attributes.map((a) => `${a.shortName || a.name}=${a.value}`).join(', ');

/** Parseia o .pfx (PKCS#12) — lança CERTIFICADO_INVALIDO se senha errada ou arquivo corrompido/não-PKCS12. */
function parsePkcs12(pfxBuffer, password) {
  try {
    const p12Der = forge.util.createBuffer(pfxBuffer.toString('binary'));
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    return forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
  } catch (error) {
    throw new Error(`CERTIFICADO_INVALIDO: falha ao ler o .pfx — senha incorreta ou arquivo corrompido (${error.message})`);
  }
}

/** Extrai os bags de chave privada + certificado X.509 de um PKCS#12 já parseado. */
function extractKeyAndCertBags(p12) {
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  const certBag = certBags[forge.pki.oids.certBag]?.[0];
  if (!keyBag?.key || !certBag?.cert) {
    throw new Error('CERTIFICADO_INVALIDO: não foi possível extrair chave privada e certificado do arquivo .pfx');
  }
  return { key: keyBag.key, cert: certBag.cert };
}

/**
 * Valida que o arquivo é um PKCS#12 legível com a senha informada, e extrai metadados úteis pra
 * conferência humana antes de salvar. Usado no upload (fiscalController.createCertificate) —
 * lança erro imediatamente se senha/arquivo estiverem errados, em vez de descobrir só na hora de
 * emitir a primeira nota.
 *
 * ⚠️ `detectedCnpj` é extração best-effort do Common Name — convenção comum de certificados
 * e-CNPJ ICP-Brasil é `CN="RAZAO SOCIAL:14DIGITOS"`, mas isso não é validado contra o XSD/manual
 * oficial (não é campo de assinatura, é só apoio visual pro admin conferir). Nunca usar pra
 * sobrescrever `FiscalProfile.cnpj` automaticamente — só para exibir e o humano comparar.
 *
 * Metadados de auditoria adicionados 2026-07-29 (`fileHash`/`serialNumber`/`thumbprint`/
 * `subject`): permitem identificar/comparar qual certificado está em uso e detectar upload
 * duplicado **sem decifrar o .pfx de novo** — `fileHash`/`thumbprint` ficam em texto puro no
 * banco (não são segredo, são só impressões digitais, igual um checksum de arquivo).
 *
 * @param {Buffer} pfxBuffer
 * @param {string} password
 */
export function inspectPkcs12(pfxBuffer, password) {
  const p12 = parsePkcs12(pfxBuffer, password);
  const { cert } = extractKeyAndCertBags(p12);
  const commonName = cert.subject.getField('CN')?.value || null;
  const cnpjMatch = commonName?.match(/:(\d{14})$/);
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();

  // Key Usage (RFC 5280) — nem todo PKCS#12 é necessariamente apto pra assinatura digital.
  // Não bloqueia sozinho (a extensão pode faltar em certificados válidos mal formados por
  // ferramentas antigas), só registra pra auditoria — quem decide bloquear é o controller.
  const keyUsageExt = cert.getExtension('keyUsage');
  const keyUsage = keyUsageExt
    ? { digitalSignature: !!keyUsageExt.digitalSignature, nonRepudiation: !!keyUsageExt.nonRepudiation }
    : null;

  return {
    commonName,
    subject: dnToString(cert.subject),
    detectedCnpj: cnpjMatch ? cnpjMatch[1] : null,
    issuer: cert.issuer.getField('CN')?.value || null,
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    serialNumber: cert.serialNumber,
    keyUsage,
    // SHA-256 do certificado X.509 em DER — impressão digital padrão pra identificar o cert.
    thumbprint: crypto.createHash('sha256').update(Buffer.from(certDer, 'binary')).digest('hex'),
    // SHA-256 do arquivo .pfx inteiro (não só do certificado) — detecta upload do mesmo arquivo 2x.
    fileHash: crypto.createHash('sha256').update(pfxBuffer).digest('hex')
  };
}

export class CertificateManager {
  /* eslint-disable no-unused-vars */
  async sign(xml, certificate) {
    throw new Error('NOT_IMPLEMENTED: use RealCertificateManager ou MockCertificateManager');
  }
  /* eslint-enable no-unused-vars */
}

/**
 * Implementação de desenvolvimento/teste — NUNCA usar em produção. Não assina de verdade, só
 * anexa um marcador para permitir que o resto do pipeline (Adapter, parsing de resposta) seja
 * testado sem depender de um certificado real.
 */
export class MockCertificateManager extends CertificateManager {
  async sign(xml) {
    return `${xml}<!-- MOCK_SIGNATURE: não é uma assinatura digital válida, uso restrito a testes -->`;
  }

  async signElement(xml) {
    return `${xml}<!-- MOCK_SIGNATURE: não é uma assinatura digital válida, uso restrito a testes -->`;
  }
}

/**
 * Assina a DPS de verdade com um certificado A1 (.pfx) já decifrado em memória.
 * Quem monta esses dois parâmetros é services/fiscal/_attemptSubmission.js, usando
 * utils/certificateCrypto.js para decifrar o que está em repouso no MongoDB — este arquivo nunca
 * lê o banco nem lida com criptografia em repouso, só recebe bytes já prontos.
 */
export class RealCertificateManager extends CertificateManager {
  /**
   * @param {Buffer} pfxBuffer - conteúdo binário do .pfx (PKCS#12), já decifrado
   * @param {string} password - senha do certificado, já decifrada
   */
  constructor(pfxBuffer, password) {
    super();
    this.pfxBuffer = pfxBuffer;
    this.password = password;
  }

  /** Extrai chave privada + certificado X.509 do .pfx via node-forge. */
  _extractKeyAndCert() {
    const p12 = parsePkcs12(this.pfxBuffer, this.password);
    const { key, cert } = extractKeyAndCertBags(p12);
    return {
      privateKeyPem: forge.pki.privateKeyToPem(key),
      certificatePem: forge.pki.certificateToPem(cert)
    };
  }

  /**
   * @param {string} xml - XML da DPS não assinado (DpsBuilder.buildDpsXml)
   * @returns {Promise<string>} XML com <Signature> inserido como filho de DPS, após infDPS
   */
  async sign(xml) {
    const idMatch = xml.match(/<infDPS Id="([^"]+)"/);
    if (!idMatch) {
      throw new Error('DPS_SEM_ID: XML da DPS não tem o atributo Id em infDPS — não é possível assinar');
    }
    return this.signElement(xml, { id: idMatch[1], rootLocalName: 'DPS' });
  }

  /** Assina um elemento identificado por @Id e insere Signature como filho da raiz indicada. */
  async signElement(xml, { id, rootLocalName, notaControl = false }) {
    const { privateKeyPem, certificatePem } = this._extractKeyAndCert();
    const referenceXpath = `//*[@Id='${id}']`;
    const rootXpath = `/*[local-name()='${rootLocalName}']`;
    const canonicalization = notaControl
      ? 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
      : 'http://www.w3.org/2001/10/xml-exc-c14n#';
    const signatureAlgorithm = notaControl
      ? 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
      : 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
    const digestAlgorithm = notaControl
      ? 'http://www.w3.org/2000/09/xmldsig#sha1'
      : 'http://www.w3.org/2001/04/xmlenc#sha256';

    const sig = new SignedXml({ privateKey: privateKeyPem, publicCert: certificatePem });
    sig.getKeyInfoContent = SignedXml.getKeyInfoContent; // inclui X509Certificate no <KeyInfo>
    sig.canonicalizationAlgorithm = canonicalization;
    sig.signatureAlgorithm = signatureAlgorithm;
    sig.addReference({
      xpath: referenceXpath,
      digestAlgorithm,
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        canonicalization
      ]
    });

    // DPS_v1.01.xsd: Signature é irmã de infDPS, não filha dele. A referência assinada continua
    // sendo infDPS/@Id; somente o local físico do elemento XML-DSig muda para a raiz DPS.
    sig.computeSignature(xml, { location: { reference: rootXpath, action: 'append' } });

    return sig.getSignedXml();
  }
}
