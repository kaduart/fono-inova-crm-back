// models/Certificate.js
// Certificado digital usado para assinar DPS/Eventos. Ciclo de vida próprio, desacoplado de
// FiscalProfile (Fase 2 v3, Seção 2.4) — vence, renova, revoga, independente da configuração fiscal.
import mongoose from 'mongoose';
import { CertificateType, CertificateStatus } from '../constants/fiscalEnums.js';

const certificateSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: Object.values(CertificateType),
    required: true
  },
  // Nunca a senha em texto puro — sempre referência a secret manager/KMS/HSM (decisão de
  // infraestrutura de segurança pendente, Fase 2 v3 Seção 12, item 6)
  passwordReference: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  issuer: { type: String },
  thumbprint: { type: String, index: true },
  storageKey: { type: String },
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
