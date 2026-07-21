// models/InsurancePlan.js
import mongoose from 'mongoose';

const slotSchema = new mongoose.Schema({
  dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
  time:      { type: String, required: true, match: /^\d{2}:\d{2}$/ }
}, { _id: false });

const insurancePlanSchema = new mongoose.Schema({
  patient:   { type: mongoose.Schema.Types.ObjectId, ref: 'Patient',         required: true },
  guide:     { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceGuide',  required: true },
  doctor:    { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor',          required: true },

  specialty:        { type: String, required: true, lowercase: true, trim: true },
  totalSessions:    { type: Number, required: true, min: 1 },
  sessionsPerWeek:  { type: Number, required: true, min: 1, max: 5 },
  startDate:        { type: Date,   required: true },

  slots: { type: [slotSchema], default: [] },

  sessionValue: { type: Number, default: 0 },

  generatedAppointments: [
    { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }
  ],

  // Flag que indica que a configuração do plano mudou estruturalmente e a agenda
  // futura ainda não foi sincronizada. O card exibe um alerta e o botão "Gerar
  // sessões" aplica a nova configuração.
  needsSessionRegeneration: { type: Boolean, default: false },

  status: {
    type: String,
    enum: ['active', 'completed', 'canceled'],
    default: 'active'
  },

  notes:     { type: String, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }

}, { timestamps: true });

// Índice: um plano por guia
insurancePlanSchema.index({ guide: 1 }, { unique: true });

const InsurancePlan = mongoose.model('InsurancePlan', insurancePlanSchema);
export default InsurancePlan;
