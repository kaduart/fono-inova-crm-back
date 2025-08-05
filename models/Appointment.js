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
  },
  operationalStatus: {
    type: String,
    enum: ['agendado', 'confirmado', 'cancelado', 'pago', 'faltou'],
    default: 'agendado'
  },
  clinicalStatus: {
    type: String,
    enum: ['pendente', 'em_andamento', 'concluído', 'faltou'],
    default: 'pendente'
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
  specialty: {
    type: String,
    required: true,
    enum: ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia', 'pediatria', 'neuroped'],

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
    enum: ['individual_session', 'package_session', 'evaluation'],
    required: true
  },
  sessionValue: {
    type: Number,
    min: 0,
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
  { patient: 1, doctor: 1, date: 1, time: 1 },
  { unique: true, name: 'unique_appointment' }
);

appointmentSchema.post('save', async function (doc) {
  await syncEvent(doc, 'appointment');
});

appointmentSchema.post('findOneAndUpdate', async function (doc) {
  if (doc) {
    await syncEvent(doc, 'appointment');
  }
});

appointmentSchema.post('findOneAndDelete', async function (doc) {
  if (doc) {
    await MedicalEvent.deleteOne({
      originalId: doc._id,
      type: 'appointment'
    });
  }
});

/* appointmentSchema.pre('save', function (next) {
  // Sincroniza status legado com novo modelo
  if (this.isModified('operationalStatus') || this.isModified('clinicalStatus')) {
    if (this.clinicalStatus === 'concluído') {
      this.status = 'concluído';
    } else if (this.operationalStatus === 'cancelado') {
      this.status = 'cancelado';
    } else if (this.operationalStatus === 'confirmado') {
      this.status = 'confirmado';
    } else {
      this.status = 'agendado';
    }
  }

  // Sincroniza novo modelo com status legado
  if (this.isModified('status')) {
    if (this.status === 'concluído') {
      this.clinicalStatus = 'concluído';
      this.operationalStatus = 'pago';
    } else if (this.status === 'cancelado') {
      this.operationalStatus = 'cancelado';
    } else if (this.status === 'confirmado') {
      this.operationalStatus = 'confirmado';
    } else {
      this.operationalStatus = 'agendado';
      this.clinicalStatus = 'pendente';
    }
  }
  next();
}); */

const Appointment = mongoose.model('Appointment', appointmentSchema);

export default Appointment;
