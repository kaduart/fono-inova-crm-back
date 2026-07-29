// utils/certificateCrypto.js
// Criptografia em repouso do certificado digital (.pfx/.p12) e da senha — resolve a decisão de
// infraestrutura de segurança que estava pendente desde a Fase 2 v3 (models/Certificate.js).
// AES-256-GCM via `crypto` nativo do Node — sem dependência nova. Chave vem de variável de
// ambiente (FISCAL_CERT_ENCRYPTION_KEY, 64 caracteres hex = 32 bytes), nunca hardcoded, nunca
// gerada automaticamente pelo código (decisão explícita: gerar/rotacionar a chave é ação humana).
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.FISCAL_CERT_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'FISCAL_CERT_ENCRYPTION_KEY não configurada. Gere uma com `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` e adicione ao .env / variáveis de ambiente do servidor.'
    );
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('FISCAL_CERT_ENCRYPTION_KEY precisa ter exatamente 64 caracteres hexadecimais (32 bytes).');
  }
  return key;
}

/** @param {Buffer} buffer @returns {{ciphertext: string, iv: string, authTag: string}} tudo em base64 */
export function encryptBuffer(buffer) {
  const iv = crypto.randomBytes(12); // GCM recomenda IV de 12 bytes
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64')
  };
}

/** @param {{ciphertext: string, iv: string, authTag: string}} enc @returns {Buffer} */
export function decryptToBuffer(enc) {
  if (!enc?.ciphertext || !enc?.iv || !enc?.authTag) {
    throw new Error('Payload criptografado incompleto — não é possível decifrar.');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, 'base64')), decipher.final()]);
}

export function encryptString(str) {
  return encryptBuffer(Buffer.from(str, 'utf8'));
}

export function decryptToString(enc) {
  return decryptToBuffer(enc).toString('utf8');
}
