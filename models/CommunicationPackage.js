// models/CommunicationPackage.js
// Pacote de envio de uma comunicação com convênio: contém apenas referências a documentos + snapshot.
import mongoose from 'mongoose';

export const PackageStatus = {
  DRAFT: 'draft',
  SENT: 'sent',
  RESENT: 'resent',
  FAILED: 'failed'
};

const communicationPackageSchema = new mongoose.Schema({
  communicationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InsuranceCommunication',
    required: true,
    index: true
  },
  attachments: [{
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PatientDocument',
      required: true
    },
    type: {
      type: String,
      required: true
    },
    filename: {
      type: String,
      required: true
    },
    url: {
      type: String,
      required: true
    },
    hash: {
      type: String,
      default: ''
    },
    mimeType: {
      type: String,
      default: ''
    },
    size: {
      type: Number,
      default: 0
    },
    includedAt: {
      type: Date,
      default: Date.now
    }
  }],
  status: {
    type: String,
    enum: Object.values(PackageStatus),
    default: PackageStatus.DRAFT
  },
  attempt: {
    type: Number,
    default: 0
  },
  lastAttemptAt: {
    type: Date
  },
  sentAt: {
    type: Date
  },
  resentAt: {
    type: Date
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, { timestamps: true });

const CommunicationPackage = mongoose.models.CommunicationPackage || mongoose.model('CommunicationPackage', communicationPackageSchema);
export default CommunicationPackage;
