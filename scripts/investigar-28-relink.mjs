import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!mongoUri) {
  console.error('MONGODB_URI/MONGO_URI não encontrado');
  process.exit(1);
}

await mongoose.connect(mongoUri);
const db = mongoose.connection.db;
const payments = db.collection('payments');
const appointments = db.collection('appointments');
const patients = db.collection('patients');
const sessions = db.collection('sessions');
const packages = db.collection('packages');
const users = db.collection('users');

const classificationFile = '../../backups-mongo/paid-orphans-classification-2026-07-29T14-40-20-818Z.json';
const { readFile } = await import('fs/promises');
const data = JSON.parse(await readFile(join(__dirname, classificationFile), 'utf8'));
const items = data.categories?.RELINK_OU_ANONIMIZAR?.items || [];

console.log(`Investigando ${items.length} payments RELINK_OU_ANONIMIZAR...\n`);

for (const p of items) {
  const pay = await payments.findOne({ _id: new mongoose.Types.ObjectId(p._id) });
  const patient = p.refs?.patient?.id
    ? await patients.findOne({ _id: new mongoose.Types.ObjectId(p.refs.patient.id) })
    : null;
  const appointment = p.refs?.appointment?.id
    ? await appointments.findOne({ _id: new mongoose.Types.ObjectId(p.refs.appointment.id) })
    : null;
  const session = p.refs?.session?.id
    ? await sessions.findOne({ _id: new mongoose.Types.ObjectId(p.refs.session.id) })
    : null;
  const pkg = p.refs?.package?.id
    ? await packages.findOne({ _id: new mongoose.Types.ObjectId(p.refs.package.id) })
    : null;

  const createdBy = pay?.createdBy
    ? await users.findOne({ _id: new mongoose.Types.ObjectId(pay.createdBy) })
    : null;

  console.log('══════════════════════════════════════════════════════════');
  console.log(`Payment: ${p._id} | R$ ${p.amount} | ${p.kind} | ${p.paymentMethod}`);
  console.log(`  status: ${pay?.status}`);
  console.log(`  createdAt: ${pay?.createdAt}`);
  console.log(`  paidAt: ${pay?.paidAt}`);
  console.log(`  financialDate: ${pay?.financialDate}`);
  console.log(`  paymentDate: ${pay?.paymentDate}`);
  console.log(`  createdBy: ${createdBy?.name || createdBy?.email || pay?.createdBy || '-'}`);
  console.log(`  origin: ${pay?.origin || '-'}`);
  console.log(`  reason: ${pay?.reason || '-'}`);
  console.log(`  description: ${pay?.description || '-'}`);
  console.log(`  notes: ${pay?.notes || '-'}`);
  console.log(`  patientId (no payment): ${pay?.patient || pay?.patientId || '-'}`);
  console.log(`  appointmentId (no payment): ${pay?.appointment || pay?.appointmentId || '-'}`);
  console.log(`  sessionId (no payment): ${pay?.session || pay?.sessionId || '-'}`);
  console.log(`  packageId (no payment): ${pay?.package || pay?.packageId || '-'}`);

  if (patient) {
    console.log(`  PATIENT EXISTE: ${patient.fullName} (${patient.phone || 'sem phone'})`);
  } else {
    console.log(`  PATIENT: INEXISTENTE`);
  }

  if (appointment) {
    console.log(`  APPOINTMENT: ${appointment.date} ${appointment.time} | status=${appointment.operationalStatus} | patientId=${appointment.patient || appointment.patientId} | billingType=${appointment.billingType}`);
  } else {
    console.log(`  APPOINTMENT: inexistente`);
  }

  if (session) {
    console.log(`  SESSION: ${session.date} ${session.time} | status=${session.status} | patientId=${session.patient || session.patientId} | sessionValue=${session.sessionValue} | guideConsumed=${session.guideConsumed}`);
  } else {
    console.log(`  SESSION: inexistente`);
  }

  if (pkg) {
    console.log(`  PACKAGE: ${pkg.specialty} | totalValue=${pkg.totalValue} | patientId=${pkg.patientId || pkg.patient} | status=${pkg.status}`);
  } else {
    console.log(`  PACKAGE: inexistente`);
  }

  console.log('');
}

await mongoose.disconnect();
