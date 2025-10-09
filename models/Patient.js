import mongoose from 'mongoose';

const patientSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true },
  dateOfBirth: { type: Date, required: true },
  birthCertificate: { type: String },
  doctor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    index: true,
    validate: {
      validator: function (v) {
        return mongoose.Types.ObjectId.isValid(v);
      },
      message: props => `${props.value} não é um ID válido para médico!`
    }
  },
  gender: { type: String, trim: true },
  maritalStatus: { type: String, trim: true },
  placeOfBirth: { type: String, trim: true },
  address: {
    street: { type: String, trim: true },
    number: { type: String, trim: true },
    district: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    zipCode: { type: String, trim: true },
  },
  phone: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  cpf: {
    type: String, trim: true
  },
  rg: {
    type: String, trim: true
  },
  mainComplaint: { type: String, trim: true },
  clinicalHistory: { type: String, trim: true },
  medications: { type: String, trim: true },
  allergies: { type: String, trim: true },
  familyHistory: { type: String, trim: true },
  healthPlan: {
    name: { type: String, trim: true },
    policyNumber: { type: String, trim: true },
  },
  legalGuardian: { type: String, trim: true },
  emergencyContact: {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    relationship: { type: String, trim: true },
  },
  appointments: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Appointment'
    }
  ],
  packages: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Package'
    }
  ],
  imageAuthorization: { type: Boolean, default: false },
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  timestamps: true
});

// Campos virtuais para lastAppointment e nextAppointment
patientSchema.virtual('lastAppointment', {
  ref: 'Appointment',
  localField: '_id',
  foreignField: 'patient',
  justOne: true,
  match: { date: { $lt: new Date() } },
  options: { sort: { date: -1 }, limit: 1 }
});

patientSchema.virtual('nextAppointment', {
  ref: 'Appointment',
  localField: '_id',
  foreignField: 'patient',
  justOne: true,
  match: { date: { $gte: new Date() } },
  options: { sort: { date: 1 }, limit: 1 }
});

patientSchema.pre('save', function (next) {
  const patient = this;

  // Só atualiza se appointments foi modificado
  if (!patient.isModified('appointments')) return next();

  const now = new Date();
  let lastAppointment = null;
  let nextAppointment = null;

  // Ordena appointments por data
  const sortedAppointments = [...patient.appointments].sort((a, b) =>
    new Date(a.date) - new Date(b.date)
  );

  // Encontra o último agendamento passado
  for (let i = sortedAppointments.length - 1; i >= 0; i--) {
    if (new Date(sortedAppointments[i].date) < now) {
      lastAppointment = sortedAppointments[i];
      break;
    }
  }

  // Encontra o próximo agendamento futuro
  for (let i = 0; i < sortedAppointments.length; i++) {
    if (new Date(sortedAppointments[i].date) >= now) {
      nextAppointment = sortedAppointments[i];
      break;
    }
  }

  patient.lastAppointment = lastAppointment;
  patient.nextAppointment = nextAppointment;
  next();
});

const Patient = mongoose.model('Patient', patientSchema, 'patients');

export default Patient;
