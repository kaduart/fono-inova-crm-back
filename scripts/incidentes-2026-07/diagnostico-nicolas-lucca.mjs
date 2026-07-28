import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não configurada'); process.exit(1); }

async function main() {
  await mongoose.connect(MONGO_URI);
  await import('../models/PatientsView.js'); // registrar schema antes de outros models
  const Patient = (await import('../models/Patient.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;

  const p = await Patient.findOne({ fullName: { $regex: 'Nicolas Lucca', $options: 'i' } }).lean();
  console.log('Paciente:', p ? { id: p._id.toString(), nome: p.fullName } : 'NÃO ENCONTRADO');
  if (!p) { await mongoose.disconnect(); return; }
  const patientId = p._id;

  const appts = await Appointment.find({ patient: patientId }).sort({ date: -1 }).lean();
  console.log('\nTotal appointments:', appts.length);
  for (const a of appts) {
    const sessions = await Session.find({ appointment: a._id }).lean();
    const payments = await Payment.find({ appointment: a._id }).lean();
    console.log('Appt:', a._id.toString(), '|', a.date, a.time, '| specialty:', a.specialty, '| status:', a.operationalStatus, '| paymentStatus:', a.paymentStatus, '| insuranceGuide:', a.insuranceGuide?.toString() || 'null', '| sessions:', sessions.length, '| payments:', payments.map(p => ({ status: p.status, kind: p.kind, amount: p.amount })));
  }

  const guides = await InsuranceGuide.find({ patientId: patientId }).lean();
  console.log('\nGuias por patientId:', guides.length);
  for (const g of guides) {
    console.log('Guia:', g._id.toString(), '|', g.number || g.guideNumber, '| status:', g.status, '| totalSessions:', g.totalSessions, '| usedSessions:', g.usedSessions, '| specialty:', g.specialty, '| patientId:', g.patientId?.toString());
  }

  // Buscar guias pelos IDs referenciados nos appointments
  const guideIds = [...new Set(appts.map(a => a.insuranceGuide?.toString()).filter(Boolean))];
  console.log('\nGuia IDs referenciados em appointments:', guideIds.length);
  const guidesById = await InsuranceGuide.find({ _id: { $in: guideIds.map(id => new mongoose.Types.ObjectId(id)) } }).lean();
  for (const g of guidesById) {
    console.log('Guia:', g._id.toString(), '|', g.number || g.guideNumber, '| status:', g.status, '| totalSessions:', g.totalSessions, '| usedSessions:', g.usedSessions, '| specialty:', g.specialty, '| patientId:', g.patientId?.toString(), '| expectedPatient:', g.expectedPatient?.toString());
  }

  // Verificar sessões do paciente
  const sessions = await Session.find({ patient: patientId }).sort({ date: -1 }).lean();
  console.log('\nTotal sessões com patient=', patientId.toString(), ':', sessions.length);
  for (const s of sessions.slice(0, 10)) {
    console.log('Session:', s._id.toString(), '| date:', s.date, '| time:', s.time, '| specialty:', s.sessionType || s.specialty, '| status:', s.status, '| insuranceGuide:', s.insuranceGuide?.toString(), '| appointmentId:', s.appointmentId?.toString(), '| billingType:', s.billingType, '| paymentMethod:', s.paymentMethod);
  }
  const sessionsWithGuide = sessions.filter(s => s.insuranceGuide);
  console.log('Sessões com insuranceGuide:', sessionsWithGuide.length);

  // Verificar se há sessões com appointment do paciente mas patient null
  const apptIds = appts.map(a => a._id);
  const sessionsByAppt = await Session.find({ appointmentId: { $in: apptIds } }).lean();
  console.log('\nTotal sessões por appointmentId:', sessionsByAppt.length);
  const sessionsWithPatientNull = sessionsByAppt.filter(s => !s.patient);
  console.log('Sessões por appointmentId com patient null:', sessionsWithPatientNull.length);
  for (const s of sessionsByAppt.slice(0, 10)) {
    console.log('Session:', s._id.toString(), '| patient:', s.patient?.toString(), '| date:', s.date, '| status:', s.status, '| insuranceGuide:', s.insuranceGuide?.toString(), '| appointmentId:', s.appointmentId?.toString());
  }

  // Análise por mês: appointments completed vs sessions completed (Julho 2026)
  const startJul = new Date(2026, 6, 1);
  const endJul = new Date(2026, 7, 0, 23, 59, 59, 999);
  const julAppts = appts.filter(a => a.date >= startJul && a.date <= endJul);
  const julSessions = sessions.filter(s => s.date >= startJul && s.date <= endJul);
  console.log('\n=== JULHO 2026 ===');
  console.log('Appointments em julho:', julAppts.length);
  console.log('Appointments completed em julho:', julAppts.filter(a => a.operationalStatus === 'completed').length);
  console.log('Appointments scheduled em julho:', julAppts.filter(a => a.operationalStatus === 'scheduled').length);
  console.log('Appointments pre_agendado em julho:', julAppts.filter(a => a.operationalStatus === 'pre_agendado').length);
  console.log('Sessões em julho:', julSessions.length);
  console.log('Sessões completed em julho:', julSessions.filter(s => s.status === 'completed').length);
  console.log('Sessões scheduled em julho:', julSessions.filter(s => s.status === 'scheduled').length);
  console.log('Sessões com insuranceGuide em julho:', julSessions.filter(s => s.insuranceGuide).length);

  // Cruzar appointment vs session status
  console.log('\n=== Cruzamento Appointment vs Session status (Julho 2026) ===');
  for (const a of julAppts.slice(0, 30)) {
    const sess = sessionsByAppt.find(s => s.appointmentId?.toString() === a._id.toString());
    console.log('Appt:', a._id.toString(), a.date, a.time, 'apptStatus:', a.operationalStatus, 'sessionStatus:', sess ? sess.status : 'NO_SESSION', 'sessionId:', sess?._id?.toString() || 'n/a', 'insuranceGuide:', a.insuranceGuide?.toString());
  }

  // Verificar quais sessões de julho completed NÃO têm insuranceGuide
  const julCompletedNoGuide = julSessions.filter(s => s.status === 'completed' && !s.insuranceGuide);
  console.log('\nSessões completed em julho SEM insuranceGuide:', julCompletedNoGuide.length);

  // Verificar se getPatientInsuranceSessions retornaria algo para julho
  const julCompletedWithGuide = julSessions.filter(s => s.status === 'completed' && s.insuranceGuide);
  console.log('Sessões completed em julho COM insuranceGuide:', julCompletedWithGuide.length);
  for (const s of julCompletedWithGuide) {
    const appt = appts.find(a => a._id.toString() === s.appointmentId?.toString());
    console.log('  Session', s._id.toString(), 'date:', s.date, 'apptStatus:', appt?.operationalStatus, 'paymentStatus:', appt?.paymentStatus, 'guide:', s.insuranceGuide?.toString());
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
