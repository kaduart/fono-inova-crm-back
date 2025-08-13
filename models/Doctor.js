// models/doctorModel.js
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import mongoose, { Schema } from 'mongoose';

const DailyScheduleSchema = new mongoose.Schema({
  day: {
    type: String,
    enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    required: true,
  },
  times: {
    type: [String], // Array de strings no formato 'HH:mm'
    default: [],
  },
}, { _id: false });

const doctorSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: false },
  specialty: {
    type: String,
    required: true,
    enum: [
      'fonoaudiologia',
      'terapia_ocupacional',
      'psicologia',
      'fisioterapia',
      'pediatria',
      'neuroped'
    ],
  },
  specialties: [{
    type: Schema.Types.ObjectId,
    ref: 'Specialty' // Ou o modelo correto
  }],
  // ======================================================================
  licenseNumber: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  active: { type: Boolean, default: true }, // === MUDANÇA AQUI: de String para Boolean ===
  role: { type: String, default: 'doctor' },
  weeklyAvailability: {
    type: [DailyScheduleSchema], // Array de DailyScheduleSchema
    default: [],
  },
  password: { type: String },
  passwordResetToken: String,
  passwordResetExpires: Date
}, { timestamps: true });

// Método para comparar senhas (único método necessário no model)
doctorSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

// Método para gerar token de reset (armazena no model)
doctorSchema.methods.createPasswordResetToken = function () {
  const resetToken = crypto.randomBytes(32).toString('hex');

  this.passwordResetToken = crypto.createHash('sha256')
    .update(resetToken)
    .digest('hex');

  this.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10min

  return resetToken;
};

doctorSchema.pre('save', async function (next) {
  if (this.isModified('password') && this.password) { // Garante que há uma senha para hash e que ela foi modificada
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }
  next();
});


const Doctor = mongoose.model('Doctor', doctorSchema);
export default Doctor;