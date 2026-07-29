// fiscal-provider/buildCertificateContext.js
// Extraído de services/fiscal/_attemptSubmission.js (2026-07-29) — passou a ser usado também pelo
// endpoint de diagnóstico de conectividade (controllers/fiscalController.js testConnection), não
// só pelo fluxo de emissão. Único ponto do CRM que decifra um Certificate e monta o que o resto
// precisa: um `https.Agent` pro handshake mTLS e um `RealCertificateManager` pra assinar XML.

import https from 'node:https';
import { RealCertificateManager } from './CertificateManager.js';
import { decryptToBuffer, decryptToString } from '../utils/certificateCrypto.js';

/**
 * @param {Object|null} certificate - documento Certificate (com encryptedFile/encryptedPassword)
 * @returns {{ httpsAgent: import('node:https').Agent|undefined, certManager: RealCertificateManager|null }}
 *   Sem certificado com arquivo criptografado vinculado (perfil incompleto ou ambiente de teste):
 *   devolve tudo vazio — quem chama decide o fallback (Mock, ou reportar erro no diagnóstico).
 */
export function buildCertificateContext(certificate) {
  if (!certificate?.encryptedFile?.ciphertext || !certificate?.encryptedPassword?.ciphertext) {
    return { httpsAgent: undefined, certManager: null };
  }
  const fileBuffer = decryptToBuffer(certificate.encryptedFile);
  const password = decryptToString(certificate.encryptedPassword);
  return {
    httpsAgent: new https.Agent({ pfx: fileBuffer, passphrase: password }),
    certManager: new RealCertificateManager(fileBuffer, password)
  };
}
