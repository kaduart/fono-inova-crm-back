import mongoose from 'mongoose';

const SPECIALTIES = [
  'fonoaudiologia',
  'terapia_ocupacional',
  'psicologia',
  'fisioterapia',
  'psicomotricidade',
  'musicoterapia',
  'psicopedagogia',
  'neuropediatria'
];

// Cada slot = um dia da semana + horário fixo
// Ex: fono tem seg 14h e qui 10h → slots: [{ dayOfWeek:1, time:"14:00" }, { dayOfWeek:4, time:"10:00" }]
const slotSchema = new mongoose.Schema({
  dayOfWeek: { type: Number, required: true, min: 0, max: 6 }, // 0=dom … 6=sab
  time:      { type: String, required: true, match: /^\d{2}:\d{2}$/ } // "HH:MM"
}, { _id: false });

const therapyScheduleSchema = new mongoose.Schema({
  doctor:                { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
  slots:                 { type: [slotSchema], default: [] },
  sessionValue:          { type: Number, required: true, min: 0.01 },
  sessionDurationMinutes:{ type: Number, default: 40 }
}, { _id: false });

const therapeuticPlanSchema = new mongoose.Schema({
  patient:          { type: mongoose.Schema.Types.ObjectId, ref: 'Patient',         required: true },
  liminarContract:  { type: mongoose.Schema.Types.ObjectId, ref: 'LiminarContract', required: true },

  version:   { type: Number, required: true, min: 1 },
  startDate: { type: Date,   required: true },
  endDate:   { type: Date,   default: null },  // null = plano vigente

  status: {
    type: String,
    enum: ['active', 'superseded', 'canceled'],
    default: 'active'
  },

  // ─── FREQUÊNCIA POR ESPECIALIDADE ──────────────────────────
  therapies: {
    type: Map,
    of: therapyScheduleSchema,
    validate: {
      validator: function (map) {
        for (const key of map.keys()) {
          if (!SPECIALTIES.includes(key)) return false;
        }
        return true;
      },
      message: `Especialidades válidas: ${SPECIALTIES.join(', ')}`
    }
  },

  notes:     { type: String, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }

}, { timestamps: true });

// Garante unicidade: um contrato não pode ter duas versões ativas
therapeuticPlanSchema.index(
  { liminarContract: 1, version: 1 },
  { unique: true }
);

const TherapeuticPlan = mongoose.model('TherapeuticPlan', therapeuticPlanSchema);
export default TherapeuticPlan;
