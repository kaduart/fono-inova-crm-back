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
  password: { type: String, required: false, minlength: 6 }, // pode ser criado sem senha e definida depois
  specialty: { type: String, required: true, enum: ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia', 'pediatria', 'neuroped'] },
  specialties: [{ type: Schema.Types.ObjectId, ref: 'Specialty' }],

  licenseNumber: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  active: { type: Boolean, default: true },
  role: { type: String, default: 'doctor' },

  weeklyAvailability: { type: [DailyScheduleSchema], default: [] },

  // 🔑 reset de senha
  passwordResetToken: { type: String, index: true, select: false },
  passwordResetExpires: { type: Date, select: false },
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
