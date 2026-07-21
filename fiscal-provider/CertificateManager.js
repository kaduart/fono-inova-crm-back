// fiscal-provider/CertificateManager.js
// Provider Layer. ⚠️ ASSINATURA DIGITAL REAL NÃO IMPLEMENTADA NESTE PR — bloqueada por duas
// decisões ainda em aberto (Fase 1.5 / Fase 2 v3 Seção 11-12):
//   1. Tipo de certificado (A1 arquivo vs A3/HSM) — muda radicalmente a arquitetura (assinar em
//      Node.js vs delegar a hardware/serviço externo).
//   2. Nenhuma biblioteca de assinatura XML (ex. xml-crypto, node-forge) está instalada no
//      projeto — adicionar dependência é decisão que não deve ser tomada por suposição.
//
// Interface deliberadamente pequena — só `sign()`. "É esse certificado usável?" já é resondido
// pelo domínio (domain/fiscal/validators/EmissionEligibilityValidator.js, que checa
// Certificate.status direto no repositório) — duplicar essa checagem aqui seria a mesma regra em
// dois lugares. Este arquivo define só o CONTRATO que o restante do Provider Layer usa, mais uma
// implementação Mock para desenvolvimento/teste.

export class CertificateManager {
  /* eslint-disable no-unused-vars */
  async sign(xml, certificate) {
    throw new Error('NOT_IMPLEMENTED: CertificateManager.sign — pendente decisão de tipo de certificado (A1 vs A3/HSM)');
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
}
