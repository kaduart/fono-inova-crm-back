// models/Certificate.js
// Certificado digital usado para assinar DPS/Eventos. Ciclo de vida próprio, desacoplado de
// FiscalProfile (Fase 2 v3, Seção 2.4) — vence, renova, revoga, independente da configuração fiscal.
import mongoose from 'mongoose';
import { CertificateType, CertificateStatus } from '../constants/fiscalEnums.js';

const encryptedBlobSchema = new mongoose.Schema({
  ciphertext: { type: String },
  iv: { type: String },
  authTag: { type: String }
}, { _id: false });

const certificateSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: Object.values(CertificateType),
    required: true
  },
  // Legado — nunca populado pelo fluxo real de upload (que usa encryptedFile/encryptedPassword
  // abaixo). Mantido opcional só por compatibilidade com registros antigos, não usar em código novo.
  passwordReference: {
    type: String,
    required: false
  },
  // Decisão de infraestrutura de segurança resolvida em 2026-07-29 (estava pendente desde a Fase
  // 2 v3): AES-256-GCM em repouso, chave em variável de ambiente (utils/certificateCrypto.js).
  // Não é HSM/secret manager externo — avaliado como suficiente para o porte da clínica; revisar
  // se o volume/risco justificar upgrade futuro.
  encryptedFile: encryptedBlobSchema,
  encryptedPassword: encryptedBlobSchema,
  originalFilename: { type: String },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  issuer: { type: String },
  subject: { type: String }, // DN completo do titular (não só o CN) — auditoria
  serialNumber: { type: String }, // número de série do certificado X.509
  thumbprint: { type: String, index: true }, // SHA-256 do certificado (DER) — identifica o cert sem decifrar
  fileHash: { type: String, index: true }, // SHA-256 do .pfx inteiro — detecta upload duplicado do mesmo arquivo
  // Key Usage (RFC 5280) — registrado só como auditoria, não bloqueia sozinho (extensão pode
  // faltar em certificado válido gerado por ferramenta antiga). Quem decide bloquear no upload
  // é o controller, com base em `notAfter` (isso sim bloqueia).
  keyUsage: {
    digitalSignature: { type: Boolean },
    nonRepudiation: { type: Boolean }
  },
  storageKey: { type: String }, // legado, não usado pelo fluxo real (arquivo vai em encryptedFile)
  status: {
    type: String,
    enum: Object.values(CertificateStatus),
    default: CertificateStatus.VALIDATING,
    index: true
  }
}, { timestamps: true });

certificateSchema.index({ status: 1, expiresAt: 1 });

const Certificate = mongoose.models.Certificate || mongoose.model('Certificate', certificateSchema);
export default Certificate;
