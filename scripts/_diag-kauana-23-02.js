import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const patient = await Patient.findOne({ fullName: /Kauana Queiroz/i }).select('_id').lean();
  const guide2027 = await InsuranceGuide.findOne({ number: '2027', patientId: patient._id }).select('_id specialty').lean();
  const guide2028 = await InsuranceGuide.findOne({ number: '2028', patientId: patient._id }).select('_id specialty').lean();

  console.log('=== 23/02 14:00 Thayna ===');
  const thayna14 = await Session.find({
    patient: patient._id,
    status: 'completed',
    date: { $gte: new Date('2026-02-23T00:00:00-03:00'), $lte: new Date('2026-02-23T23:59:59-03:00') }
  })
    .populate('appointmentId', 'time specialty doctor')
    .populate('doctor', 'fullName')
    .populate('insuranceGuide', 'number specialty')
    .lean();

  for (const s of thayna14) {
    if (s.doctor?.fullName?.includes('Thayna') || s.appointmentId?.doctor) {
      const payments = await Payment.find({ session: s._id }).lean();
      console.log(`Session ${s._id} | time:${s.appointmentId?.time} | doctor:${s.doctor?.fullName} | guide:${s.insuranceGuide?.number}(${s.insuranceGuide?.specialty}) | specialty:${s.specialty} | apptSpecialty:${s.appointmentId?.specialty}`);
      for (const p of payments) {
        console.log(`  Payment ${p._id} | status:${p.status} | insurance.status:${p.insurance?.status} | amount:${p.amount}`);
      }
    }
  }

  console.log('\n=== 23/02 14:40 Lorrany ===');
  const lorrany14 = await Session.find({
    patient: patient._id,
    status: 'completed',
    date: { $gte: new Date('2026-02-23T00:00:00-03:00'), $lte: new Date('2026-02-23T23:59:59-03:00') }
  })
    .populate('appointmentId', 'time specialty')
    .populate('doctor', 'fullName')
    .populate('insuranceGuide', 'number specialty')
    .lean();

  for (const s of lorrany14) {
    if (s.doctor?.fullName?.includes('Lorrany')) {
      const payments = await Payment.find({ session: s._id }).lean();
      console.log(`Session ${s._id} | time:${s.appointmentId?.time} | doctor:${s.doctor?.fullName} | guide:${s.insuranceGuide?.number}(${s.insuranceGuide?.specialty}) | specialty:${s.specialty} | apptSpecialty:${s.appointmentId?.specialty}`);
      for (const p of payments) {
        console.log(`  Payment ${p._id} | status:${p.status} | insurance.status:${p.insurance?.status} | amount:${p.amount}`);
      }
    }
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
