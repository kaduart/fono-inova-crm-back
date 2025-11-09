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
  cpf: { type: String, trim: true },
  rg: { type: String, trim: true },
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
  appointments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],
  packages: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Package' }],
  imageAuthorization: { type: Boolean, default: false },
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  timestamps: true
});

// ---------- VIRTUALS (apenas ordenação simples) ----------
patientSchema.virtual('lastAppointment', {
  ref: 'Appointment',
  localField: '_id',
  foreignField: 'patient',
  justOne: true,
  options: { sort: { date: -1, time: -1 } }
});

patientSchema.virtual('nextAppointment', {
  ref: 'Appointment',
  localField: '_id',
  foreignField: 'patient',
  justOne: true,
  options: { sort: { date: 1, time: 1 } }
});

// ---------- HELPERS LOCAIS (sem UTC bug) ----------
function todayYMD() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10); // "YYYY-MM-DD"
}
function nowHM() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo'
  }).formatToParts(new Date());
  const H = parts.find(p => p.type === 'hour')?.value ?? '00';
  const M = parts.find(p => p.type === 'minute')?.value ?? '00';
  return `${H}:${M}`;
}
function cmpAsc(a, b) { // data asc, hora asc
  const da = (a.date || '').slice(0, 10), db = (b.date || '').slice(0, 10);
  if (da !== db) return da < db ? -1 : 1;
  const ta = a.time || '', tb = b.time || '';
  if (ta === tb) return 0;
  return ta < tb ? -1 : 1;
}
function cmpDesc(a, b) { return -cmpAsc(a, b); }

// ---------- MÉTODO DE INSTÂNCIA ----------
patientSchema.methods.calculateAppointments = async function () {
  if (!this.populated('appointments')) {
    await this.populate({
      path: 'appointments',
      populate: [
        { path: 'doctor', select: 'fullName specialty' },
        { path: 'payment', select: 'status amount paymentMethod' },
        { path: 'package', select: 'sessionType totalSessions sessionsDone' }
      ],
      options: { sort: { date: 1, time: 1 } }
    });
  }

  const today = todayYMD();
  const hm = nowHM();

  const appointments = this.appointments || [];
  const valid = appointments.filter(apt => apt?.operationalStatus !== 'canceled');

  const past = valid
    .filter(apt => {
      const d = (apt.date || '').slice(0, 10);
      if (!d) return false;
      if (d < today) return true;
      if (d > today) return false;
      return (apt.time || '') < hm;
    })
    .sort(cmpDesc);

  const future = valid
    .filter(apt => {
      const d = (apt.date || '').slice(0, 10);
      if (!d) return false;
      if (d > today) return true;
      if (d < today) return false;
      return (apt.time || '') >= hm;
    })
    .sort(cmpAsc);

  return {
    lastAppointment: past[0] || null,
    nextAppointment: future[0] || null
  };
};

// ---------- MÉTODO ESTÁTICO ----------
patientSchema.statics.findWithAppointments = async function (query = {}) {
  let patients = await this.find(query)
    .populate('doctor', 'fullName specialty')
    .populate({
      path: 'appointments',
      populate: [
        { path: 'doctor', select: 'fullName specialty' },
        { path: 'payment', select: 'status amount paymentMethod' },
        { path: 'package', select: 'sessionType totalSessions sessionsDone' }
      ],
      options: { sort: { date: 1, time: 1 } }
    })
    .populate({
      path: 'packages',
      populate: [
        { path: 'doctor', select: 'fullName specialty' },
        { path: 'sessions', select: 'date status' }
      ]
    })
    .lean();

  const today = todayYMD();
  const hm = nowHM();

  patients = patients.map(p => {
    const valid = (p.appointments || []).filter(a => a?.operationalStatus !== 'canceled');

    const past = valid
      .filter(a => {
        const d = (a.date || '').slice(0, 10);
        if (!d) return false;
        if (d < today) return true;
        if (d > today) return false;
        return (a.time || '') < hm;
      })
      .sort(cmpDesc);

    const future = valid
      .filter(a => {
        const d = (a.date || '').slice(0, 10);
        if (!d) return false;
        if (d > today) return true;
        if (d < today) return false;
        return (a.time || '') >= hm;
      })
      .sort(cmpAsc);

    return {
      ...p,
      lastAppointment: past[0] || null,
      nextAppointment: future[0] || null
    };
  });

  return patients;
};

const Patient = mongoose.model('Patient', patientSchema, 'patients');
export default Patient;
