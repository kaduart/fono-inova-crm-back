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
  await import('../models/PatientsView.js');
  const Patient = (await import('../models/Patient.js')).default;
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const InsuranceBatch = (await import('../models/InsuranceBatch.js')).default;
  const InsuranceResolverService = (await import('../services/insuranceResolver.service.js')).default;

  const p = await Patient.findOne({ fullName: { $regex: 'Nicolas Lucca', $options: 'i' } }).lean();
  if (!p) { console.error('Paciente não encontrado'); await mongoose.disconnect(); return; }
  const patientId = p._id.toString();
  console.log('Paciente:', patientId, p.fullName);

  for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']) {
    const [y, m] = month.split('-').map(Number);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0, 23, 59, 59, 999);
    const patientOid = new mongoose.Types.ObjectId(patientId);

    const sessionMatch = {
      patient: patientOid,
      status: 'completed',
      date: { $gte: start, $lte: end },
      $or: [
        { billingType: 'convenio' },
        { paymentMethod: 'convenio' },
        { insuranceGuide: { $exists: true, $ne: null } },
        { paymentOrigin: 'convenio' }
      ]
    };

    const [sessions, avulsoPayments] = await Promise.all([
      Session.find(sessionMatch).populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions').lean(),
      Payment.find({
        patient: patientOid,
        billingType: 'convenio',
        package: null,
        serviceDate: { $gte: start, $lte: end },
        status: { $nin: ['cancelled', 'canceled'] }
      }).lean()
    ]);

    const sessionIds = sessions.map(s => s._id);
    const appointmentIds = sessions.map(s => s.appointmentId).filter(Boolean);
    const avulsoAppointmentIds = avulsoPayments.map(p => p.appointment).filter(Boolean);
    const allAppointmentIds = [...new Set([...appointmentIds, ...avulsoAppointmentIds])].map(id => id.toString());

    const [appointments, payments, batches] = await Promise.all([
      allAppointmentIds.length ? Appointment.find({ _id: { $in: allAppointmentIds } }).select('_id patient specialty insuranceProvider insuranceGuide date patientInfo').lean() : Promise.resolve([]),
      sessionIds.length || allAppointmentIds.length ? Payment.find({
        $or: [{ session: { $in: sessionIds } }, { appointment: { $in: allAppointmentIds } }],
        status: { $nin: ['cancelled', 'canceled'] }
      }).lean() : Promise.resolve([]),
      sessionIds.length ? InsuranceBatch.find({ 'sessions.session': { $in: sessionIds } }).select('insuranceProvider status sessions.session sessions.status sessions.grossAmount sessions.appointment').lean() : Promise.resolve([])
    ]);

    const apptById = Object.fromEntries(appointments.map(a => [a._id.toString(), a]));
    const paymentBySession = Object.fromEntries(payments.filter(p => p.session).map(p => [p.session.toString(), p]));
    const paymentByAppointment = Object.fromEntries(payments.filter(p => p.appointment).map(p => [p.appointment.toString(), p]));

    const result = [];
    for (const session of sessions) {
      const sessionId = session._id.toString();
      const appt = apptById[session.appointmentId?.toString()];
      const payment = paymentBySession[sessionId] || paymentByAppointment[session.appointmentId?.toString()];
      const batch = batches.find(b => b.sessions.some(s => s.session?.toString() === sessionId));
      const batchSession = batch?.sessions.find(s => s.session?.toString() === sessionId);

      let billingStatus = 'pending_batch';
      if (payment?.insurance?.status === 'received' || batchSession?.status === 'paid' || batch?.status === 'received') billingStatus = 'received';
      else if (payment?.insurance?.status === 'billed' || batchSession?.status === 'sent' || ['sent', 'processing'].includes(batch?.status)) billingStatus = 'billed';

      const provider = InsuranceResolverService.resolveInsuranceProvider({ payment, session, appointment: appt, batch });

      result.push({
        sessionId,
        date: session.date,
        specialty: session.sessionType || appt?.specialty || session.insuranceGuide?.specialty || 'outros',
        provider,
        guideNumber: session.insuranceGuide?.number || payment?.insurance?.authorizationCode || null,
        value: payment?.insurance?.grossAmount || payment?.amount || session.sessionValue || 0,
        billingStatus
      });
    }

    console.log(`\n${month}: sessions=${sessions.length} result=${result.length}`);
    for (const r of result) {
      console.log('  ', r.date.toISOString().slice(0, 10), r.specialty, r.provider, r.guideNumber, r.billingStatus, 'R$' + r.value);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
