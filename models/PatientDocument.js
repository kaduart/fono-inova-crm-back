// models/PatientDocument.js
// Document Center genérico: um documento físico por paciente, referenciado por múltiplos módulos.
import mongoose from 'mongoose';

export const PatientDocumentType = {
  GUIDE: 'guide',
  MEDICAL_ORDER: 'medical_order',
  INSURANCE_CARD: 'insurance_card',
  ID_DOCUMENT: 'id_document',
  CPF: 'cpf',
  PRINT_PORTAL: 'print_portal',
  REPORT: 'report',
  ATTENDANCE_LIST: 'attendance_list',
  INVOICE: 'invoice',
  BILLING_STATEMENT: 'billing_statement',
  OTHER: 'other'
};

export const PatientDocumentSource = {
  UPLOAD: 'upload',
  PASTE: 'paste',
  GENERATED: 'generated'
};

export const PatientDocumentCategory = {
  AUTHORIZATION: 'authorization',
  CLINICAL: 'clinical',
  FINANCIAL: 'financial',
  LEGAL: 'legal'
};

const patientDocumentSchema = new mongoose.Schema({
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true,
    index: true
  },
  category: {
    type: String,
    enum: Object.values(PatientDocumentCategory),
    default: PatientDocumentCategory.AUTHORIZATION,
    index: true
  },
  type: {
    type: String,
    enum: Object.values(PatientDocumentType),
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  originalName: {
    type: String,
    trim: true
  },
  url: {
    type: String,
    required: true,
    trim: true
  },
  publicId: {
    type: String,
    trim: true
  },
  mimeType: {
    type: String,
    trim: true
  },
  size: {
    type: Number,
    min: 0
  },
  extension: {
    type: String,
    trim: true
  },
  source: {
    type: String,
    enum: Object.values(PatientDocumentSource),
    default: PatientDocumentSource.UPLOAD
  },
  tags: [{
    type: String,
    trim: true
  }],
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

patientDocumentSchema.index({ patientId: 1, type: 1 });
patientDocumentSchema.index({ createdAt: -1 });

const PatientDocument = mongoose.models.PatientDocument || mongoose.model('PatientDocument', patientDocumentSchema);
export default PatientDocument;
