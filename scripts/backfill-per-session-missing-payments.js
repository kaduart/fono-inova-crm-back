import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });
dotenv.config();

const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) { console.error('No MONGO_URI'); process.exit(1); }
  await mongoose.connect(mongoUri);

  const Appointment = (await import('../models/Appointment.js')).default;
  const Payment = (await import('../models/Payment.js')).default;
  const Package = (await import('../models/Package.js')).default;
  const Session = (await import('../models/Session.js')).default;

  const pipeline = [
    { $match: { clinicalStatus: 'completed', package: { $exists: true, $ne: null } } },
    { $lookup: { from: 'packages', localField: 'package', foreignField: '_id', as: 'pkg' } },
    { $unwind: '$pkg' },
    { $match: { $or: [{ 'pkg.paymentType': 'per-session' }, { 'pkg.model': 'per_session' }] } },
    { $lookup: { from: 'payments', localField: '_id', foreignField: 'appointment', as: 'payments' } },
    { $match: { payments: { $size: 0 } } },
    { $project: { _id: 1, date: 1, time: 1, operationalStatus: 1, clinicalStatus: 1, paymentStatus: 1, serviceType: 1, sessionValue: 1, session: 1, package: 1, patient: 1, patientInfo: 1, completedAt: 1 } },
    { $sort: { date: -1 } }
  ];

  const missing = await Appointment.aggregate(pipeline);
  console.log(`Encontrados ${missing.length} per-session completados sem Payment`);
  if (missing.length === 0) { await mongoose.disconnect(); return; }

  let created = 0;
  for (const a of missing) {
    const patientId = a.patient || a.patientInfo?._id;
    if (!patientId) {
      console.log(`⚠️ Skipping ${a._id}: sem patient`);
      continue;
    }
    const sessionDoc = a.session ? await Session.findById(a.session).lean() : null;
    const pkgDoc = await Package.findById(a.package).lean();
    const amount = a.sessionValue || pkgDoc?.sessionValue || 0;
    const sessionDate = a.date ? moment.tz(a.date, 'America/Sao_Paulo').startOf('day').toDate() : new Date();
    const financialDate = a.completedAt ? new Date(a.completedAt) : sessionDate;

    console.log(`${DRY_RUN ? '[DRY-RUN]' : '[APPLY]'} ${a._id} | ${sessionDate.toISOString().split('T')[0]} ${a.time} | R$ ${amount} | ${a.serviceType} | patient=${patientId}`);

    if (!DRY_RUN) {
      const payment = new Payment({
        patient: patientId,
        patientId: patientId.toString(),
        appointment: a._id,
        appointmentId: a._id.toString(),
        session: a.session || null,
        package: a.package || null,
        amount,
        paymentMethod: 'pix',
        paymentDate: sessionDate,
        financialDate,
        paidAt: financialDate,
        status: 'paid',
        billingType: 'particular',
        source: 'backfill_per_session',
        kind: 'session_payment',
        serviceType: a.serviceType || 'session',
        isFromPackage: a.serviceType === 'package_session' || !!a.package,
        description: `Backfill: pagamento per-session referente ao agendamento ${a._id}`
      });
      await payment.save();
      await Appointment.updateOne({ _id: a._id }, { $set: { payment: payment._id } });
      created++;
    }
  }

  console.log(`\n${DRY_RUN ? 'Dry-run concluído' : `Payments criados: ${created}`}`);
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
