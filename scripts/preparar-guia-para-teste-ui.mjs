import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { assertNotProductionDb } from '../utils/assertNotProductionDb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });
dotenv.config();

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;

// 🔒 ADR-016 — guard OBRIGATÓRIO antes de qualquer conexão.
// Este script criou 28 pacientes "Paciente Teste Encerrar Guia" em produção
// (limpeza em 2026-08-05 e de novo em 2026-08-07).
assertNotProductionDb({ mongoUri, scriptName: 'preparar-guia-para-teste-ui.mjs', writes: true });

const KEEP = process.argv.includes('--keep');
const testRunId = randomUUID();

// Rastreio determinístico do que foi criado, para limpar no finally.
// Não uso marcador `_testData` no documento porque os schemas rodam em modo
// strict — Mongoose descartaria o campo silenciosamente e a limpeza viraria no-op.
const criados = { Patient: [], InsuranceGuide: [], Appointment: [], Session: [], Payment: [] };
const rastrear = (modelo, doc) => { criados[modelo].push(doc._id); return doc; };

console.log(`testRunId: ${testRunId}${KEEP ? ' (--keep: não vai limpar)' : ''}`);

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

// ⚠️ A partir daqui tudo escreve. O bloco está em try/finally: qualquer exceção
// no meio ainda dispara a limpeza, senão sobra meia trinca no banco.
try {

const patient = await Patient.create({
  fullName: 'Paciente Teste Encerrar Guia',
  phone: '61999999999',
  email: 'teste-encerrar-guia@example.com'
});
criados.Patient.push(patient._id);

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
criados.InsuranceGuide.push(guide._id);

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
criados.Appointment.push(apptCompleted._id);

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
criados.Appointment.push(apptScheduled._id);

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
criados.Appointment.push(apptConfirmed._id);

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
criados.Session.push(sessionCompleted._id);

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
criados.Session.push(sessionScheduled._id);

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
criados.Session.push(sessionConfirmed._id);

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
criados.Payment.push(payment._id);

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

} finally {
  // Limpeza SEMPRE — inclusive quando o bloco acima estourou no meio.
  // Ordem inversa da criação, para não deixar referência pendurada.
  if (KEEP) {
    console.log('\n--keep: dado de teste MANTIDO. Limpe manualmente quando terminar:');
    console.log(`   ${JSON.stringify(criados, null, 2)}`);
  } else {
    const ordem = ['Payment', 'Session', 'Appointment', 'InsuranceGuide', 'Patient'];
    for (const modelo of ordem) {
      const ids = criados[modelo];
      if (!ids.length) continue;
      try {
        const r = await mongoose.model(modelo).deleteMany({ _id: { $in: ids } });
        console.log(`   limpeza ${modelo}: ${r.deletedCount}/${ids.length}`);
      } catch (err) {
        console.error(`   ⚠️  limpeza ${modelo} falhou: ${err.message} — ids: ${ids.join(', ')}`);
      }
    }
  }
  await mongoose.disconnect();
}
