// models/InsuranceCommunication.js
import mongoose from 'mongoose';

export const CommunicationStatus = {
  DRAFT: 'draft',
  READY: 'ready',
  SENDING: 'sending',
  SENT: 'sent',
  APPROVED: 'approved',
  DENIED: 'denied'
};

export const CommunicationPurpose = {
  AUTHORIZATION: 'authorization',
  BILLING: 'billing',
  APPEAL: 'appeal',
  DOCUMENTATION: 'documentation'
};

const insuranceCommunicationSchema = new mongoose.Schema({
  // Novo fluxo. Registros legados permanecem sem este campo.
  billingSubmissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BillingSubmission',
    index: true,
    default: null
  },
  billingAllocationIds: [{
    type: mongoose.Schema.Types.ObjectId
  }],
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true,
    index: true
  },
  insuranceProvider: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  guideId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InsuranceGuide',
    index: true
  },
  purpose: {
    type: String,
    enum: Object.values(CommunicationPurpose),
    default: CommunicationPurpose.AUTHORIZATION,
    index: true
  },
  specialty: {
    type: String,
    lowercase: true,
    trim: true
  },
  requestedSessions: {
    type: Number,
    min: 1
  },
  status: {
    type: String,
    enum: Object.values(CommunicationStatus),
    default: CommunicationStatus.DRAFT,
    index: true
  },
  statusReason: {
    type: String,
    default: '',
    trim: true
  },
  notes: {
    type: String,
    default: '',
    trim: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InsuranceBatch',
    index: true,
    default: null
  },
  invoiceNumber: {
    type: String,
    default: null,
    trim: true,
    index: true
  },
  invoiceDate: {
    type: Date,
    default: null
  },
  sentAt: {
    type: Date,
    default: null,
    index: true
  },
  deliveryMethod: {
    type: String,
    enum: ['email', 'external', 'portal'],
    default: 'email',
    index: true,
    trim: true,
    lowercase: true
  }
}, { timestamps: true });

insuranceCommunicationSchema.index({ insuranceProvider: 1, status: 1 });
insuranceCommunicationSchema.index({ insuranceProvider: 1, purpose: 1, status: 1 });
insuranceCommunicationSchema.index({ createdAt: -1 });
insuranceCommunicationSchema.index({ billingSubmissionId: 1, createdAt: -1 });
insuranceCommunicationSchema.index(
  { guideId: 1, purpose: 1, status: 1, updatedAt: -1 },
  { name: 'insurance_view_guide_communication', sparse: true }
);

const InsuranceCommunication = mongoose.models.InsuranceCommunication || mongoose.model('InsuranceCommunication', insuranceCommunicationSchema);
export default InsuranceCommunication;
