import mongoose from 'mongoose';

const patientSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true },
  dateOfBirth: { type: Date, required: false, default: null },
  birthCertificate: { type: String },
  doctor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    index: true,
    validate: {
      validator: function (v) {
        if (!v) return true;
        return v instanceof mongoose.Types.ObjectId ||
          mongoose.Types.ObjectId.isValid(v);
      },
      message: 'ID do médico inválido'
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
    // Código IBGE do município (7 dígitos) — Anexo I exige end/endNac/cMun, não o nome da cidade
    // em texto livre. Opcional: se ausente, o módulo fiscal assume o mesmo município da clínica
    // (FiscalProfile.municipioIBGE) — cobre o caso comum (paciente local); pacientes de outro
    // município precisam preencher explicitamente.
    municipioIBGE: { type: String, trim: true },
  },
  phone: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  cpf: { type: String, trim: true },
  // Tomador Pessoa Jurídica (decisoes_fiscais_clinica.md #4) — quando a nota fiscal deve sair no
  // CNPJ de um convênio/empresa em vez do CPF do paciente. Preenchido só quando aplicável; o
  // DpsBuilder prefere CNPJ sobre CPF quando ambos existem (grupo `toma` é choice, não os dois).
  cnpj: { type: String, trim: true },
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

  // Parabéns de aniversário (services/birthday/birthdayMessageService.js): trava de 1 envio
  // por paciente por ano, gravada de forma atômica ANTES de enfileirar — vale tanto pro cron
  // das 10h quanto pro botão manual do dashboard, então os dois nunca mandam duas vezes.
  birthdayMessageSentYear: { type: Number, default: null },
  birthdayMessageSentAt: { type: Date, default: null },
  // Como o parabéns do ano foi resolvido: 'auto' (cron/botão, enfileirado no WhatsApp da clínica)
  // ou 'manual' (a equipe deu parabéns por fora, ex.: link do WhatsApp de um aniversário que passou).
  birthdayMessageSentVia: { type: String, enum: ['auto', 'manual', null], default: null },

  // ─── DUPLICIDADE (03/11/2026) ─────────────────────────────
  // Origem do cadastro (erp, agenda_externa, agenda_v2, lead, ...). Antes era enviado por
  // alguns fluxos mas descartado pelo schema — não dava para saber de onde vinha o duplicado.
  source: { type: String, trim: true, default: null },
  // Cadastros parecidos encontrados no momento da criação (utils/patientDuplicateCheck.js).
  // Preenchido quando o fluxo não pôde perguntar ao usuário (agenda, lead) ou quando o usuário
  // confirmou "é outra pessoa" — alimenta o relatório GET /api/patients/duplicates/report.
  possibleDuplicateOf: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Patient' }],
  duplicateReview: {
    confirmedDistinct: { type: Boolean, default: false },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    confirmedAt: { type: Date, default: null },
  },

  // ─── FUNIL CRM ─────────────────────────────────────────────
  status: {
    type: String,
    enum: ['lead', 'active', 'inactive'],
    default: 'active'
  },
  // Inativação manual pela recepção, com motivo, para campanhas de retorno
  // (Kadu, 09/11/2026). Ver PATCH /api/v2/patients/:id/status.
  inactivation: {
    reason: { type: String, default: null },
    note: { type: String, default: null },
    at: { type: Date, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: null },
    reactivatedAt: { type: Date, default: null },
    reactivatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  isLead: {
    type: Boolean,
    default: false
  },
  createdFromLead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lead',
    default: null
  },
  convertedAt: {
    type: Date,
    default: null
  },
  firstSessionAt: {
    type: Date,
    default: null
  },
  lastSessionAt: {
    type: Date,
    default: null
  },
  // Secretaria marca quando a familia JA avaliou no Google (ou pediu p/ nao receber):
  // a automacao de pedido de avaliacao pos-sessao pula esse paciente.
  reviewOptOut: {
    type: Boolean,
    default: false
  }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  timestamps: true
});

// ---------- ÍNDICES ÚNICOS (após consolidar duplicados) ----------
// Estes índices impedem a criação de duplicados futuros
// Comentados até consolidar os dados existentes:
// patientSchema.index({ cpf: 1 }, { unique: true, sparse: true });
// patientSchema.index({ email: 1 }, { unique: true, sparse: true });
// patientSchema.index({ rg: 1 }, { unique: true, sparse: true });

// Índice composto para busca rápida de duplicados
patientSchema.index({ fullName: 1, dateOfBirth: 1 });
patientSchema.index({ phone: 1 });

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
