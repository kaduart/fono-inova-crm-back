// models/FiscalAttachment.js
// Artefatos RECEBIDOS/GERADOS pela autoridade fiscal (XML autorizado, DANFSe). Imutável — nova
// versão (ex. substituição) sempre cria novo FiscalInvoice + novo FiscalAttachment, nunca sobrescreve
// (Fase 2 v3, invariante #4). Distinto de FiscalSnapshot, que é o que o CRM ENVIOU.
import mongoose from 'mongoose';
import { FiscalAttachmentType } from '../constants/fiscalEnums.js';

const fiscalAttachmentSchema = new mongoose.Schema({
  fiscalInvoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FiscalInvoice',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: Object.values(FiscalAttachmentType),
    required: true
  },
  storageRef: { type: String, required: true },
  hash: { type: String },
  mimeType: { type: String },
  size: { type: Number },
  generatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

fiscalAttachmentSchema.index({ fiscalInvoice: 1, type: 1 });

const FiscalAttachment = mongoose.models.FiscalAttachment || mongoose.model('FiscalAttachment', fiscalAttachmentSchema);
export default FiscalAttachment;
