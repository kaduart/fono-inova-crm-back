import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

const adminSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'admin' }
});

adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

adminSchema.pre('save', async function (next) {
  if (this.isModified('password') && this.password) { // Garante que há uma senha para hash e que ela foi modificada
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }
  next();
});

adminSchema.path('password').required(true, 'Senha é obrigatória');
adminSchema.path('password').minlength(6, 'Senha deve ter no mínimo 6 caracteres');

const Admin = mongoose.model('Admin', adminSchema);

export default Admin;
