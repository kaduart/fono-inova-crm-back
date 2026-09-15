/**
 * 🧪 CertificateManager (RealCertificateManager + inspectPkcs12) — item 5 da tarefa de
 * homologação de Anápolis (2026-09-11). Não existiam testes deste arquivo antes.
 *
 * Certificados usados aqui são PKCS#12 autoassinados, gerados em memória com node-forge — nunca
 * um segredo real, nunca impresso em log/asserção (só thumbprint/hash, que são impressões
 * digitais públicas, não segredo).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { inspectPkcs12, RealCertificateManager } from '../../fiscal-provider/CertificateManager.js';

const PASSWORD = 'senha-teste-123';

function buildTestPfx({ notBefore, notAfter, cn = 'CLINICA TESTE:12345678000199', password = PASSWORD } = {}) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = notBefore || new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = notAfter || new Date('2027-01-01T00:00:00Z');
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs);
  cert.setIssuer([{ name: 'commonName', value: 'AC Teste (fixture de unit test, não é ICP-Brasil real)' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, password, { algorithm: '3des' });
  const pfx = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
  return { pfx, certificatePem: forge.pki.certificateToPem(cert) };
}

function verifySignedXml(xml, certificatePem) {
  const match = xml.match(/<Signature[\s\S]*<\/Signature>/);
  if (!match) return { hasSignature: false, valid: false };
  const verifier = new SignedXml({ publicCert: certificatePem });
  verifier.loadSignature(match[0]);
  // xml-crypto ora retorna false (digest não bate — conteúdo adulterado), ora lança (assinatura
  // não bate — chave pública errada) — as duas são "não válido" do ponto de vista deste teste.
  try {
    return { hasSignature: true, valid: verifier.checkSignature(xml) };
  } catch {
    return { hasSignature: true, valid: false };
  }
}

const DPS_XML = '<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">' +
  '<infDPS Id="DPS520110821234567800019900001000000000000001"><tpAmb>2</tpAmb><nDPS>1</nDPS></infDPS></DPS>';

describe('inspectPkcs12', () => {
  let valid;
  beforeAll(() => { valid = buildTestPfx(); });

  it('certificado válido: extrai metadados corretos (notBefore/notAfter/thumbprint/fileHash)', () => {
    const info = inspectPkcs12(valid.pfx, PASSWORD);
    expect(info.commonName).toBe('CLINICA TESTE:12345678000199');
    expect(info.detectedCnpj).toBe('12345678000199');
    expect(new Date(info.notBefore).getUTCFullYear()).toBe(2026);
    expect(new Date(info.notAfter).getUTCFullYear()).toBe(2027);
    expect(info.thumbprint).toHaveLength(64); // sha256 hex
    expect(info.fileHash).toHaveLength(64);
  });

  it('senha inválida: lança CERTIFICADO_INVALIDO, nunca vaza detalhe da chave', () => {
    expect(() => inspectPkcs12(valid.pfx, 'senha-errada')).toThrow(/CERTIFICADO_INVALIDO/);
  });

  it('arquivo corrompido/não-PKCS12: lança CERTIFICADO_INVALIDO', () => {
    const garbage = Buffer.from('isto não é um certificado, é só texto aleatório'.repeat(20));
    expect(() => inspectPkcs12(garbage, PASSWORD)).toThrow(/CERTIFICADO_INVALIDO/);
  });

  it('arquivo vazio: lança CERTIFICADO_INVALIDO (não trava, não retorna metadados vazios)', () => {
    expect(() => inspectPkcs12(Buffer.alloc(0), PASSWORD)).toThrow(/CERTIFICADO_INVALIDO/);
  });

  it('certificado expirado: inspectPkcs12 extrai o notAfter no passado (não é papel deste método rejeitar, só relatar)', () => {
    const expired = buildTestPfx({ notBefore: new Date('2020-01-01'), notAfter: new Date('2021-01-01') });
    const info = inspectPkcs12(expired.pfx, PASSWORD);
    expect(new Date(info.notAfter).getTime()).toBeLessThan(Date.now());
  });
});

describe('RealCertificateManager.sign / signElement', () => {
  it('assina a DPS: Signature aparece como irmão de infDPS (DPS_v1.01.xsd), assinatura verifica correta', async () => {
    const { pfx, certificatePem } = buildTestPfx();
    const manager = new RealCertificateManager(pfx, PASSWORD);
    const signed = await manager.sign(DPS_XML);

    expect(signed).toContain('<infDPS Id="DPS520110821234567800019900001000000000000001">');
    expect(signed).toMatch(/<\/infDPS><Signature/);
    expect(signed).toContain('<X509Certificate>');

    const result = verifySignedXml(signed, certificatePem);
    expect(result.hasSignature).toBe(true);
    expect(result.valid).toBe(true);
  });

  it('XML sem Id em infDPS: sign() lança DPS_SEM_ID, nunca produz um XML "assinado" inválido silenciosamente', async () => {
    const { pfx } = buildTestPfx();
    const manager = new RealCertificateManager(pfx, PASSWORD);
    await expect(manager.sign('<DPS versao="1.01"><infDPS><nDPS>1</nDPS></infDPS></DPS>')).rejects.toThrow(/DPS_SEM_ID/);
  });

  it('senha inválida: sign() propaga CERTIFICADO_INVALIDO em vez de assinar com a chave errada', async () => {
    const { pfx } = buildTestPfx();
    const manager = new RealCertificateManager(pfx, 'senha-errada');
    await expect(manager.sign(DPS_XML)).rejects.toThrow(/CERTIFICADO_INVALIDO/);
  });

  it('PFX corrompido: signElement() nunca produz uma assinatura a partir de bytes inválidos', async () => {
    const manager = new RealCertificateManager(Buffer.from('corrompido-de-proposito'), PASSWORD);
    await expect(manager.sign(DPS_XML)).rejects.toThrow(/CERTIFICADO_INVALIDO/);
  });

  it('DETECÇÃO DE ADULTERAÇÃO: XML alterado depois de assinado falha na verificação', async () => {
    const { pfx, certificatePem } = buildTestPfx();
    const manager = new RealCertificateManager(pfx, PASSWORD);
    const signed = await manager.sign(DPS_XML);

    const tampered = signed.replace('<nDPS>1</nDPS>', '<nDPS>999999</nDPS>');
    const original = verifySignedXml(signed, certificatePem);
    const adulterated = verifySignedXml(tampered, certificatePem);

    expect(original.valid).toBe(true);
    expect(adulterated.valid).toBe(false);
  });

  it('ASSINATURA AUSENTE: um XML nunca assinado não tem <Signature> para verificar', () => {
    const result = verifySignedXml(DPS_XML, 'irrelevante');
    expect(result.hasSignature).toBe(false);
  });

  it('assinado com um certificado A, verificado contra o certificado público de outro (B): falha', async () => {
    const { pfx: pfxA } = buildTestPfx({ cn: 'EMPRESA A:11111111000191' });
    const { certificatePem: certB } = buildTestPfx({ cn: 'EMPRESA B:22222222000191' });
    const managerA = new RealCertificateManager(pfxA, PASSWORD);
    const signed = await managerA.sign(DPS_XML);

    const result = verifySignedXml(signed, certB);
    expect(result.valid).toBe(false);
  });

  it('signElement (municipal, notaControl:true): usa RSA-SHA1/SHA1/C14N conforme manual §7.3.3, e assinatura verifica', async () => {
    const { pfx, certificatePem } = buildTestPfx();
    const manager = new RealCertificateManager(pfx, PASSWORD);
    const loteXml = '<EnviarLoteDpsSincronoEnvio xmlns="http://www.sped.fazenda.gov.br/nfse">' +
      '<LoteDps Id="Lote1" versao="1.01"><NumeroLote>1</NumeroLote></LoteDps></EnviarLoteDpsSincronoEnvio>';
    const signed = await manager.signElement(loteXml, { id: 'Lote1', rootLocalName: 'EnviarLoteDpsSincronoEnvio', notaControl: true });

    expect(signed).toContain('http://www.w3.org/2000/09/xmldsig#rsa-sha1');
    expect(signed).toContain('http://www.w3.org/2000/09/xmldsig#sha1');
    expect(signed).toContain('http://www.w3.org/TR/2001/REC-xml-c14n-20010315');

    const result = verifySignedXml(signed, certificatePem);
    expect(result.valid).toBe(true);
  });
});
