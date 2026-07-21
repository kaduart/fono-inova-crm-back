// models/CommunicationEmailLog.js
// Registro imutável de cada envio/tentativa de comunicação com convênio por e-mail.
import mongoose from 'mongoose';

export const EmailLogStatus = {
  SUCCESS: 'success',
  ERROR: 'error'
};

const communicationEmailLogSchema = new mongoose.Schema({
  communicationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InsuranceCommunication',
    required: true,
    index: true
  },
  communicationPackageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CommunicationPackage',
    required: true,
    index: true
  },
  to: {
    type: String,
    required: true
  },
  subject: {
    type: String,
    required: true
  },
  template: {
    type: String
  },
  message: {
    type: String
  },
  attachments: [{
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PatientDocument'
    },
    publicId: String,
    url: String,
    name: String,
    hash: String,
    mimeType: String,
    size: Number
  }],
  attempt: {
    type: Number,
    default: 1
  },
  lastAttemptAt: {
    type: Date
  },
  durationMs: {
    type: Number
  },
  protocol: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: Object.values(EmailLogStatus),
    required: true
  },
  errorMessage: {
    type: String
  },
  sentBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

communicationEmailLogSchema.index({ communicationId: 1, sentAt: -1 });

const CommunicationEmailLog = mongoose.models.CommunicationEmailLog || mongoose.model('CommunicationEmailLog', communicationEmailLogSchema);
export default CommunicationEmailLog;
