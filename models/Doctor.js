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
  specialty: { type: String, required: true, enum: ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia', 'pediatria', 'neuroped'] },
  specialties: { type: [String], default: [] },

  licenseNumber: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  active: { type: Boolean, default: true },
  role: { type: String, default: 'doctor' },

  weeklyAvailability: { type: [DailyScheduleSchema], default: [] },

  // 🔑 reset de senha
  passwordResetToken: { type: String, index: true, select: false },
  passwordResetExpires: { type: Date, select: false },
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
    customRules: [{
      serviceType: { type: String },  // ex: 'tongue_tie_test'
      value: { type: Number },
      condition: { type: String }     // ex: 'per_session', 'per_completed_package'
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
