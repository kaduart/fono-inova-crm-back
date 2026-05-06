import mongoose from 'mongoose';

const ShadowPatternSchema = new mongoose.Schema({
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
  dayOfWeek: {
    type: Number,
    required: true,
    min: 0,
    max: 6
  },
  time: {
    type: String,
    required: true
  },
  occurrences: {
    type: Number,
    default: 0
  },
  lastDates: [{
    type: Date
  }],
  confidence: {
    type: Number,
    default: 0,
    min: 0,
    max: 1
  },
  lastAnalyzedAt: {
    type: Date,
    default: Date.now
  },
  validUntil: {
    type: Date,
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  }
}, {
  timestamps: true
});

// Índices otimizados para lookup de slots
ShadowPatternSchema.index({ doctorId: 1, dayOfWeek: 1, time: 1 });
ShadowPatternSchema.index({ patientId: 1, doctorId: 1, dayOfWeek: 1, time: 1 }, { unique: true });
ShadowPatternSchema.index({ validUntil: 1 });

export default mongoose.model('ShadowPattern', ShadowPatternSchema);
