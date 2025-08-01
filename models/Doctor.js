// models/doctorModel.js
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

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
  password: { type: String, required: true },
  specialties: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Specialty'
  }],
  licenseNumber: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  active: { type: String, required: true },
  role: { type: String, default: 'doctor' },
  weeklyAvailability: {
    type: [DailyScheduleSchema], // Array de DailyScheduleSchema
    default: [],
  },
}, { timestamps: true });



doctorSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

const Doctor = mongoose.model('Doctor', doctorSchema);
export default Doctor;
