import mongoose from 'mongoose';

const ShadowLockSchema = new mongoose.Schema({
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true,
    index: true
  },
  doctorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: true,
    index: true
  },
  date: {
    type: Date,
    required: true
  },
  time: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'canceled', 'converted'],
    default: 'active',
    index: true
  },
  createdBy: {
    type: String, // nome da secretária ou 'system'
    default: 'system'
  },
  expiresAt: {
    type: Date,
    required: true
  },
  notes: {
    type: String
  }
}, {
  timestamps: true
});

// Índice otimizado para lookup de slots
ShadowLockSchema.index({ doctorId: 1, date: 1, time: 1, status: 1 });
ShadowLockSchema.index({ expiresAt: 1 });

export default mongoose.model('ShadowLock', ShadowLockSchema);
