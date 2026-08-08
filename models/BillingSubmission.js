import mongoose from 'mongoose';

export const BillingSubmissionStatus = Object.freeze({
  DRAFT: 'draft',
  FINALIZED: 'finalized',
  CANCELLED: 'cancelled'
});

const invoiceDraftSchema = new mongoose.Schema({
  // Rascunho pode ser preenchido em etapas. A obrigatoriedade dos três campos
  // é aplicada atomicamente por finalizeBillingSubmission().
  invoiceNumber: { type: String, trim: true, default: null },
  invoiceDate: { type: Date, default: null },
  documentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PatientDocument',
    default: null
  }
}, { _id: false });

const billingAllocationSchema = new mongoose.Schema({
  sessionIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Session',
    required: true
  }],
  invoice: {
    type: invoiceDraftSchema,
    default: null
  }
});

const billingSubmissionSchema = new mongoose.Schema({
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true,
    index: true
  },
  insuranceProviderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Convenio',
    required: true,
    index: true
  },
  billingCompetence: {
    type: String,
    required: true,
    match: /^\d{4}-(0[1-9]|1[0-2])$/,
    index: true
  },
  sessionIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Session',
    required: true
  }],
  billingAllocations: {
    type: [billingAllocationSchema],
    default: []
  },
  status: {
    type: String,
    enum: Object.values(BillingSubmissionStatus),
    default: BillingSubmissionStatus.DRAFT,
    required: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  finalizedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  finalizedAt: { type: Date, default: null },
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  cancelledAt: { type: Date, default: null }
}, {
  timestamps: true,
  collection: 'billing_submissions',
  optimisticConcurrency: true
});

function hasUniqueObjectIds(values = []) {
  const normalized = values.map(value => value?.toString()).filter(Boolean);
  return normalized.length === new Set(normalized).size;
}

billingSubmissionSchema.pre('validate', function validateSubmission(next) {
  if (!this.sessionIds?.length) {
    return next(new Error('BILLING_SUBMISSION_SESSIONS_REQUIRED'));
  }
  if (!hasUniqueObjectIds(this.sessionIds)) {
    return next(new Error('BILLING_SUBMISSION_DUPLICATE_SESSION'));
  }
  for (const allocation of this.billingAllocations || []) {
    if (!allocation.sessionIds?.length) {
      return next(new Error('BILLING_SUBMISSION_ALLOCATION_SESSIONS_REQUIRED'));
    }
    if (!hasUniqueObjectIds(allocation.sessionIds)) {
      return next(new Error('BILLING_SUBMISSION_DUPLICATE_SESSION'));
    }
  }
  next();
});

// Reserva estrutural: uma sessão só pode estar em um submission editável.
billingSubmissionSchema.index(
  { sessionIds: 1 },
  {
    unique: true,
    partialFilterExpression: { status: BillingSubmissionStatus.DRAFT },
    name: 'unique_draft_billing_submission_per_session'
  }
);
billingSubmissionSchema.index(
  { patientId: 1, insuranceProviderId: 1, billingCompetence: 1, createdAt: -1 },
  { name: 'billing_submission_patient_provider_competence' }
);

const BillingSubmission = mongoose.models.BillingSubmission
  || mongoose.model('BillingSubmission', billingSubmissionSchema);

export default BillingSubmission;
