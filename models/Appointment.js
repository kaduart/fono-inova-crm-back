import mongoose from 'mongoose';
import { syncEvent } from '../services/syncService.js';
import MedicalEvent from './MedicalEvent.js';


const appointmentSchema = new mongoose.Schema({
  patient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: [true, 'Paciente é obrigatório']
  },
  doctor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: [true, 'Profissional é obrigatório']
  },
  date: {
    type: String,
    required: [true, 'Data é obrigatória']
  },
  time: {
    type: String,
    required: [true, 'Horário é obrigatório'],
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Formato de horário inválido (HH:MM)']
  },
  notes: {
    type: String,
    required: false,
    default: ''
  },
  operationalStatus: {
    type: String,
    enum: ['scheduled', 'confirmed', 'pending', 'canceled', 'paid', 'missed'],
    default: 'scheduled',
  },
  clinicalStatus: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'missed'],
    default: 'pending',
  },
  history: [{
    action: String,
    newStatus: String,
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    timestamp: Date,
    context: String
  }],
  duration: {
    type: Number,
    default: 40
  },
  payment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
    required: false
  },
  visualFlag: {
    type: String,
    enum: ['ok', 'pending', 'partial', 'blocked'],
    default: 'pending',
    description: 'Indicador visual do estado financeiro para o calendário'
  },
  specialty: {
    type: String,
    required: true,
    enum: ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'tongue_tie_test', , 'neuropsych_evaluation', 'fisioterapia', 'pediatria', 'neuroped'],

  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'partial', 'canceled', 'advanced', 'package_paid'],
    default: 'pending'
  },
  advancedSessions: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  }],
  package: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Package'
  },
  session: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Session'
  },
  serviceType: {
    type: String,
    enum: [
      'evaluation', 'session', 'package_session',
      'individual_session', 'meet', 'alignment',
      'tongue_tie_test', 'neuropsych_evaluation'
    ],

    required: true
  },
  sessionValue: {
    type: Number,
    min: 0,
    default: 0
  },
  paymentMethod: {
    type: String,
    enum: ['dinheiro', 'pix', 'cartão'],
    default: 'dinheiro'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
}
);
appointmentSchema.pre('findOneAndUpdate', function (next) {
  this.options.runValidators = true;
  this.options.context = 'query';
  next();
});

appointmentSchema.index(
  { doctor: 1, date: 1, time: 1 },
  {
    unique: true,
    name: 'unique_appointment_slot',
    partialFilterExpression: {
      operationalStatus: 'scheduled' // só bloqueia horário AGENDADO
    }
  }
);

appointmentSchema.post('save', async function (doc) {
  try {
    await syncEvent(doc, 'appointment');
  } catch (error) {
    console.error('⚠️ Erro no hook post-save (não crítico):', error.message);
    // NÃO propaga erro
  }
});

appointmentSchema.post('findOneAndUpdate', async function (doc) {
  if (doc) {
    try {
      await syncEvent(doc, 'appointment');
    } catch (error) {
      console.error('⚠️ Erro no hook post-findOneAndUpdate (não crítico):', error.message);
      // NÃO propaga erro
    }
  }
});

appointmentSchema.post('findOneAndDelete', async function (doc) {
  if (doc) {
    try {
      await MedicalEvent.deleteOne({
        originalId: doc._id,
        type: 'appointment'
      });
    } catch (error) {
      console.error('⚠️ Erro no hook post-delete (não crítico):', error.message);
    }
  }
});


const Appointment = mongoose.model('Appointment', appointmentSchema);

export default Appointment;
