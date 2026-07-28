import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 30000 });
  const Session = mongoose.connection.collection('sessions');
  const Appointment = mongoose.connection.collection('appointments');
  const Payment = mongoose.connection.collection('payments');
  const Doctor = mongoose.connection.collection('doctors');
  const InsuranceGuide = mongoose.connection.collection('insuranceguides');

  const cases = [
    { label: 'GUIA ANTIGA (15924845) - 18:20', appointmentId: '6a0c540466aec15712d6d5cb', sessionId: '6a0c540580cc438aa0b67d3c', guideId: '69c2eb9f5c4ad17fefccc5b8' },
    { label: 'GUIA NOVA (16145509) - 17:00', appointmentId: '6a14ae6ed889944391d295b1', sessionId: '6a14ae6fdf43507213eaa8c0', guideId: '6a14ad99df43507213eaa770' }
  ];

  for (const c of cases) {
    console.log(`\n========== ${c.label} ==========`);
    const appt = await Appointment.findOne({ _id: new mongoose.Types.ObjectId(c.appointmentId) });
    console.log('APPOINTMENT completo:');
    console.log(JSON.stringify(appt, null, 2));

    const session = await Session.findOne({ _id: new mongoose.Types.ObjectId(c.sessionId) });
    const doctor = session?.doctor ? await Doctor.findOne({ _id: session.doctor }) : null;
    console.log('\nTerapeuta:', doctor?.fullName || doctor?.name);
    console.log('Session.package:', session.package);
    console.log('Session.notes:', session.notes);

    const guide = await InsuranceGuide.findOne({ _id: new mongoose.Types.ObjectId(c.guideId) });
    const relatedHistory = (guide?.consumptionHistory || []).filter(h =>
      h.sessionId?.toString() === c.sessionId
    );
    console.log('\nConsumptionHistory da guia referente a essa sessão:', JSON.stringify(relatedHistory, null, 2));
    console.log('Guia.consumptionHistory total de entradas:', (guide?.consumptionHistory || []).length);
  }

  // Payment cancelado - dados para restauração
  console.log('\n========== PAYMENT CANCELADO (reversibilidade) ==========');
  const payment = await Payment.findOne({ _id: new mongoose.Types.ObjectId('6a0c540480cc438aa0b67d36') });
  console.log(JSON.stringify(payment, null, 2));

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
