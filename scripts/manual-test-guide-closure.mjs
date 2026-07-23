#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });
dotenv.config();

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
const jwtSecret = process.env.JWT_SECRET;

async function main() {
  if (!mongoUri || !jwtSecret) {
    console.error('MONGODB_URI/MONGO_URI e JWT_SECRET são obrigatórios no .env');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Conectado ao MongoDB');

  // Import models after connection
  await import('../models/index.js');
  const { default: Admin } = await import('../models/Admin.js');
  const { default: Patient } = await import('../models/Patient.js');
  const { default: Doctor } = await import('../models/Doctor.js');
  const { default: InsuranceGuide } = await import('../models/InsuranceGuide.js');
  const { default: Appointment } = await import('../models/Appointment.js');

  // Encontrar um admin/secretary ativo
  const admin = await Admin.findOne({ role: { $in: ['admin', 'secretary'] } }).lean();
  if (!admin) {
    console.error('Nenhum admin/secretary encontrado');
    process.exit(1);
  }
  console.log('Usuário de teste:', admin._id.toString(), admin.role, admin.fullName);

  // Gerar token JWT
  console.log('Admin ID:', admin._id.toString());
  const token = jwt.sign(
    { id: admin._id.toString(), role: admin.role, name: admin.fullName },
    jwtSecret,
    { expiresIn: '1h' }
  );
  console.log('Token gerado');

  // Encontrar um paciente
  const patient = await Patient.findOne().lean();
  if (!patient) {
    console.error('Nenhum paciente encontrado');
    process.exit(1);
  }
  console.log('Paciente:', patient._id.toString(), patient.fullName);

  // Encontrar um doctor
  const doctor = await Doctor.findOne().lean();
  if (!doctor) {
    console.error('Nenhum doctor encontrado');
    process.exit(1);
  }
  console.log('Doctor:', doctor._id.toString(), doctor.fullName);

  // Buscar um convênio com billingMode per_month (pode ser qualquer código, ex: unimed-campinas)
  const convenioCode = 'unimed-campinas';
  const existingGuide = await InsuranceGuide.findOne({ number: 'TESTE-ENCERRAR-001' }).lean();
  if (existingGuide) {
    console.log('Limpando guia de teste existente...');
    await Appointment.deleteMany({ insuranceGuide: existingGuide._id });
    await InsuranceGuide.deleteOne({ _id: existingGuide._id });
  }

  const now = new Date();
  const future10 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 10, 9, 0, 0);
  const future15 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 15, 9, 0, 0);
  const expiresAt = new Date(now.getFullYear(), now.getMonth() + 2, now.getDate());

  const guide = await InsuranceGuide.create({
    number: 'TESTE-ENCERRAR-001',
    patientId: patient._id,
    specialty: 'fonoaudiologia',
    insurance: convenioCode,
    totalSessions: 10,
    usedSessions: 0,
    billingMode: 'per_month',
    expiresAt,
    status: 'active',
    createdBy: admin._id
  });
  console.log('Guia criada:', guide._id.toString(), guide.number);

  const appt1 = await Appointment.create({
    date: future10,
    time: '09:00',
    patient: patient._id,
    doctor: doctor._id,
    specialty: 'fonoaudiologia',
    operationalStatus: 'scheduled',
    insuranceGuide: guide._id,
    billingType: 'convenio',
    paymentMethod: 'convenio'
  });
  console.log('Appointment 1 (scheduled) criado:', appt1._id.toString(), appt1.date.toISOString());

  const appt2 = await Appointment.create({
    date: future15,
    time: '09:00',
    patient: patient._id,
    doctor: doctor._id,
    specialty: 'fonoaudiologia',
    operationalStatus: 'confirmed',
    insuranceGuide: guide._id,
    billingType: 'convenio',
    paymentMethod: 'convenio'
  });
  console.log('Appointment 2 (confirmed) criado:', appt2._id.toString(), appt2.date.toISOString());

  // Chamar API de encerramento
  const response = await fetch('http://localhost:5000/api/v2/financial/convenio/encerrar-guia', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ guideId: guide._id.toString() })
  });
  const data = await response.json();
  console.log('\nResposta da API:', response.status, JSON.stringify(data, null, 2));

  // Verificar banco
  let reloadedAppt1 = await Appointment.findById(appt1._id).lean();
  let reloadedAppt2 = await Appointment.findById(appt2._id).lean();
  let reloadedGuide = await InsuranceGuide.findById(guide._id).lean();

  console.log('\n=== Validação ===');
  console.log('Appointment 1:', reloadedAppt1.operationalStatus, reloadedAppt1.cancelReason, reloadedAppt1.cancelSource);
  console.log('Appointment 2:', reloadedAppt2.operationalStatus, reloadedAppt2.cancelReason, reloadedAppt2.cancelSource);
  console.log('Guia closedAt:', reloadedGuide.closedAt, 'closedBy:', reloadedGuide.closedBy?.toString());

  let ok =
    reloadedAppt1.operationalStatus === 'canceled' &&
    reloadedAppt1.cancelReason === 'guide_cycle_closed' &&
    reloadedAppt1.cancelSource === 'guide_closure' &&
    reloadedAppt2.operationalStatus === 'canceled' &&
    reloadedAppt2.cancelReason === 'guide_cycle_closed' &&
    reloadedAppt2.cancelSource === 'guide_closure' &&
    reloadedGuide.closedAt != null &&
    reloadedGuide.closedBy?.toString() === admin._id.toString();

  if (!ok) {
    console.log('\n❌ TESTE FALHOU na primeira validação');
    process.exit(1);
  }

  // Idempotência: chamar novamente não deve duplicar efeito nem erro
  const response2 = await fetch('http://localhost:5000/api/v2/financial/convenio/encerrar-guia', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ guideId: guide._id.toString() })
  });
  const data2 = await response2.json();
  console.log('\nResposta da API (2ª chamada):', response2.status, JSON.stringify(data2, null, 2));

  reloadedAppt1 = await Appointment.findById(appt1._id).lean();
  reloadedAppt2 = await Appointment.findById(appt2._id).lean();
  reloadedGuide = await InsuranceGuide.findById(guide._id).lean();

  const ok2 =
    response2.status === 200 &&
    data2.data.canceled === 0 &&
    reloadedAppt1.operationalStatus === 'canceled' &&
    reloadedAppt2.operationalStatus === 'canceled';

  if (ok2) {
    console.log('\n✅ TESTE PASSOU (incluindo idempotência)');
  } else {
    console.log('\n❌ TESTE FALHOU na idempotência');
    process.exit(1);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
