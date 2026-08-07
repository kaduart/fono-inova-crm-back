import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const patient = await Patient.findOne({ fullName: /Nicolas Lucca/i }).select('_id').lean();
  const startApr = new Date('2026-04-01T00:00:00-03:00');
  const endApr = new Date('2026-04-30T23:59:59-03:00');

  const sessions = await Session.find({
    patient: patient._id,
    status: 'completed',
    date: { $gte: startApr, $lte: endApr }
  }).select('appointmentId specialty sessionType').lean();

  console.log('Appointments das sessoes de abril/2026:');
  for (const s of sessions) {
    const appt = await Appointment.findById(s.appointmentId).select('specialty time').lean();
    console.log(`  ${appt?.time || '-'} | session: ${s.specialty || s.sessionType} | appointment: ${appt?.specialty} | ${s.appointmentId}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
