import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'fs';

dotenv.config();

function serialize(doc) {
  return JSON.stringify(doc, (key, value) => {
    if (value instanceof Date) return { $date: value.toISOString() };
    if (value && value._bsontype === 'ObjectId') return { $oid: value.toString() };
    return value;
  }, 2);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Session = (await import('../models/Session.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const patient = await Patient.findOne({ fullName: /Nicolas Lucca/i }).select('_id').lean();
  const guides = await InsuranceGuide.find({ patientId: patient._id, number: { $in: ['15650231', '15655250'] } }).lean();
  const sessions = await Session.find({ patient: patient._id, insuranceGuide: { $in: guides.map(g => g._id) } }).lean();
  const payments = await Payment.find({ session: { $in: sessions.map(s => s._id) } }).lean();
  const appointments = await Appointment.find({ _id: { $in: sessions.map(s => s.appointmentId).filter(Boolean) } }).lean();

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = `/home/user/projetos/crm/backups-mongo/nicolas-pre-fix-${ts}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/guides.json`, guides.map(serialize).join('\n'));
  writeFileSync(`${dir}/sessions.json`, sessions.map(serialize).join('\n'));
  writeFileSync(`${dir}/payments.json`, payments.map(serialize).join('\n'));
  writeFileSync(`${dir}/appointments.json`, appointments.map(serialize).join('\n'));
  console.log('Backup Nicolas salvo em:', dir);
  console.log(`Guias: ${guides.length}, Sessoes: ${sessions.length}, Payments: ${payments.length}, Appointments: ${appointments.length}`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
