import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import mongoose, { Schema } from 'mongoose';

const DailyScheduleSchema = new mongoose.Schema({
  day: { type: String, enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], required: true },
  times: { type: [String], default: [] }, // 'HH:mm'
}, { _id: false });

const doctorSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: {
    type: String,
    minlength: 6,
    required: false,
    select: false,
    set: v => (v === '' ? undefined : v)
  },
  specialty: { type: String, required: true, enum: ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia', 'pediatria', 'neuroped', 'psicomotricidade', 'musicoterapia', 'psicopedagogia', 'neuropsicologia'] },
  specialties: { type: [String], default: [] },

  licenseNumber: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  active: { type: Boolean, default: true },
  role: { type: String, default: 'doctor' },

  weeklyAvailability: { type: [DailyScheduleSchema], default: [] },

  // 🆕 Soft delete tracking
  deactivatedAt: { type: Date, default: null },

  // 🆕 Status operacional + vagas
  status: {
    type: String,
    enum: ['ativo', 'ferias', 'afastado', 'inativo'],
    default: 'ativo'
  },
  maxSlots: { type: Number, default: 30, min: 1 },

  // 🔑 reset de senha
  passwordResetToken: { type: String, index: true, select: false },
  passwordResetExpires: { type: Date, select: false },
  // 🆕 Versão das regras de comissão — incrementada a cada alteração
  commissionRuleVersion: {
    type: Number,
    default: 1,
    min: 1
  },

  commissionRules: {
    standardSession: {
      type: Number,
      default: 60,
      min: 0,
      description: 'Valor fixo por sessão regular (ex: R$ 60 ou R$ 65)'
    },
    evaluationSession: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Valor por avaliação (se diferente de sessão padrão)'
    },
    neuropsychEvaluation: {
      type: Number,
      default: 1200,
      min: 0,
      description: 'Valor total ao completar 10 sessões de aval. neuropsicológica'
    },
    // 🆕 REGRAS ESPECÍFICAS POR CONVÊNIO
    byInsurance: {
      type: Map,
      of: Number,
      default: {},
      description: 'Valor por sessão específico para cada convênio (ex: unimed: 50, amil: 55)'
    },
    customRules: [{
      serviceType: { type: String },  // ex: 'tongue_tie_test'
      value: { type: Number },
      condition: { type: String }     // ex: 'per_session', 'per_completed_package'
    }],

    // 🆕 MOTOR DE REGRAS DE COMISSÃO (Sprint 3.7)
    // Array flexível de regras por tipo de atendimento, convênio e período de vigência.
    rules: [{
      _id: { type: Schema.Types.ObjectId, auto: true },
      serviceType: {
        type: String,
        enum: ['session', 'evaluation', 'neuropsychological', 'aba', 'psychology', 'speech'],
        default: 'session'
      },
      billingType: {
        type: String,
        enum: ['particular', 'convenio', 'liminar', 'package'],
        default: 'particular'
      },
      insurance: {
        type: String,
        default: null,
        description: 'Nome do convênio quando billingType = convenio'
      },
      commissionType: {
        type: String,
        enum: ['fixed', 'percentage'],
        default: 'fixed'
      },
      value: {
        type: Number,
        default: 0,
        min: 0
      },
      minValue: {
        type: Number,
        default: null,
        min: 0,
        description: 'Valor mínimo da sessão para que esta regra se aplique (ex: acima de R$ 100)'
      },
      maxValue: {
        type: Number,
        default: null,
        min: 0,
        description: 'Valor máximo da sessão para que esta regra se aplique (ex: até R$ 100)'
      },
      startDate: {
        type: Date,
        default: null
      },
      endDate: {
        type: Date,
        default: null
      },
      effectiveDate: {
        type: Date,
        default: null,
        description: 'Data a partir da qual a regra passa a valer para reajustes futuros'
      },
      active: {
        type: Boolean,
        default: true
      },
      priority: {
        type: Number,
        default: 0,
        description: 'Maior valor = maior prioridade no matching'
      },
      notes: {
        type: String,
        default: ''
      }
    }]
  },

}, { timestamps: true });

// comparar senha
doctorSchema.methods.comparePassword = async function (password) {
  return bcrypt.compare(password, this.password || '');
};

// gerar token de reset e preencher campos do doc
doctorSchema.methods.createPasswordResetToken = function () {
  const resetToken = crypto.randomBytes(32).toString('hex');
  this.passwordResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
  this.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000);
  return resetToken;
};

// hash de senha
doctorSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

const Doctor = mongoose.model('Doctor', doctorSchema);
export default Doctor;
