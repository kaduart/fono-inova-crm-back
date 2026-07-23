import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });
dotenv.config();

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!mongoUri) {
  console.error('MONGODB_URI/MONGO_URI não encontrado no .env');
  process.exit(1);
}

await mongoose.connect(mongoUri);
await import('../models/index.js');

const Admin = mongoose.model('User');
const Patient = mongoose.model('Patient');
const Doctor = mongoose.model('Doctor');
const InsuranceGuide = mongoose.model('InsuranceGuide');
const Appointment = mongoose.model('Appointment');
const Session = mongoose.model('Session');
const Payment = mongoose.model('Payment');

const admin = await Admin.findOne({ role: { $in: ['admin', 'secretary'] } }).lean();
const doctor = await Doctor.findOne().lean();
if (!admin || !doctor) {
  console.error('Admin/secretary ou doctor não encontrado');
  process.exit(1);
}

const patient = await Patient.create({
  fullName: 'Paciente Teste Encerrar Guia',
  phone: '61999999999',
  email: 'teste-encerrar-guia@example.com'
});

const now = new Date();
const future10 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 10, 9, 0, 0);
const future15 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 15, 9, 0, 0);
const pastCompleted = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5, 9, 0, 0);

const sessionValue = 140;

const existingGuide = await InsuranceGuide.findOne({ number: 'TESTE-UI-ENCERRAR-001' }).lean();
if (existingGuide) {
  console.log('Limpando guia de teste existente...');
  await Appointment.deleteMany({ insuranceGuide: existingGuide._id });
  await Session.deleteMany({ insuranceGuide: existingGuide._id });
  await Payment.deleteMany({ insuranceGuide: existingGuide._id });
  await InsuranceGuide.deleteOne({ _id: existingGuide._id });
}

const guide = await InsuranceGuide.create({
  number: 'TESTE-UI-ENCERRAR-001',
  patientId: patient._id,
  specialty: 'fonoaudiologia',
  insurance: 'unimed-campinas',
  totalSessions: 10,
  usedSessions: 1,
  billingMode: 'per_month',
  expiresAt: new Date(now.getFullYear(), now.getMonth() + 2, now.getDate()),
  status: 'active',
  createdBy: admin._id
});

const apptCompleted = await Appointment.create({
  date: pastCompleted,
  time: '09:00',
  patient: patient._id,
  doctor: doctor._id,
  specialty: 'fonoaudiologia',
  operationalStatus: 'completed',
  _fromCompleteService: true,
  insuranceGuide: guide._id,
  billingType: 'convenio',
  paymentMethod: 'convenio'
});

const apptScheduled = await Appointment.create({
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

const apptConfirmed = await Appointment.create({
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

// A listagem "A Faturar" busca Session (não Appointment). Precisamos criar as Sessions correspondentes.
const sessionCompleted = await Session.create({
  date: pastCompleted,
  time: '09:00',
  sessionType: 'fonoaudiologia',
  serviceType: 'session',
  doctor: doctor._id,
  patient: patient._id,
  appointmentId: apptCompleted._id,
  insuranceGuide: guide._id,
  paymentMethod: 'convenio',
  status: 'completed',
  sessionValue,
  guideConsumed: true
});

const sessionScheduled = await Session.create({
  date: future10,
  time: '09:00',
  sessionType: 'fonoaudiologia',
  serviceType: 'session',
  doctor: doctor._id,
  patient: patient._id,
  appointmentId: apptScheduled._id,
  insuranceGuide: guide._id,
  paymentMethod: 'convenio',
  status: 'scheduled',
  sessionValue
});

const sessionConfirmed = await Session.create({
  date: future15,
  time: '09:00',
  sessionType: 'fonoaudiologia',
  serviceType: 'session',
  doctor: doctor._id,
  patient: patient._id,
  appointmentId: apptConfirmed._id,
  insuranceGuide: guide._id,
  paymentMethod: 'convenio',
  status: 'scheduled',
  sessionValue
});

// Cria o Payment que o ConvenioHandler teria gerado na completação.
// Sem isso o faturamento guide-based não encontra o que faturar.
const payment = await Payment.create({
  patient: patient._id,
  doctor: doctor._id,
  appointment: apptCompleted._id,
  session: sessionCompleted._id,
  amount: sessionValue,
  paymentDate: pastCompleted,
  serviceDate: pastCompleted,
  paymentMethod: 'convenio',
  status: 'pending',
  billingType: 'convenio',
  financialDate: null,
  insurance: {
    provider: guide.insurance,
    authorizationCode: '',
    status: 'pending_billing',
    grossAmount: sessionValue,
    guideId: guide._id
  },
  insuranceGuide: guide._id,
  description: `Sessão convênio - ${guide.insurance} | Guia ${guide.number} | ${patient.fullName}`,
  createdBy: admin._id,
  kind: 'session_payment',
  source: 'manual_test_setup'
});

// Vincula o Payment no Appointment (igual ao que o handler faz).
apptCompleted.payment = payment._id;
await apptCompleted.save();

console.log('Paciente:', patient._id.toString(), patient.fullName);
console.log('Guia:', guide._id.toString(), guide.number);
console.log('Completed Appointment:', apptCompleted._id.toString(), apptCompleted.date.toISOString());
console.log('Completed Session (aparece na lista A Faturar):', sessionCompleted._id.toString(), sessionCompleted.date.toISOString());
console.log('Payment A Faturar:', payment._id.toString(), `R$ ${payment.amount}`);
console.log('Scheduled Appointment/Session (será cancelado):', apptScheduled._id.toString(), sessionScheduled._id.toString());
console.log('Confirmed Appointment/Session (será cancelado):', apptConfirmed._id.toString(), sessionConfirmed._id.toString());

// Aguarda sincronizações assíncronas (syncService) antes de desconectar.
await new Promise(resolve => setTimeout(resolve, 1500));

await mongoose.disconnect();
