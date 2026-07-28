import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não configurada'); process.exit(1); }

const TODAY = new Date('2026-07-27T00:00:00-03:00');
const TOMORROW = new Date('2026-07-28T00:00:00-03:00');

async function main() {
  await mongoose.connect(MONGO_URI);
  const Payment = (await import('../models/Payment.js')).default;
  const Patient = (await import('../models/Patient.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;

  const payments = await Payment.find({
    status: { $in: ['paid', 'completed', 'confirmed'] },
    $or: [
      { paidAt: { $gte: TODAY, $lt: TOMORROW } },
      { financialDate: { $gte: TODAY, $lt: TOMORROW } },
      { createdAt: { $gte: TODAY, $lt: TOMORROW } }
    ]
  })
  .populate('patient', 'fullName')
  .populate('appointment', 'date time specialty operationalStatus')
  .sort({ paidAt: -1 })
  .lean();

  console.log('══════════════════════════════════════════════════════════');
  console.log('  TODOS OS PAYMENTS PAGOS HOJE (27/07/2026)');
  console.log('══════════════════════════════════════════════════════════\n');
  console.log(`Total encontrado: ${payments.length}\n`);

  // Agrupar por paciente
  const byPatient = {};
  for (const p of payments) {
    const name = p.patient?.fullName || 'N/A';
    if (!byPatient[name]) byPatient[name] = [];
    byPatient[name].push(p);
  }

  for (const [name, list] of Object.entries(byPatient)) {
    console.log(`\n👤 ${name} (${list.length} payments):`);
    let total = 0;
    for (const p of list) {
      total += p.amount || 0;
      const appt = p.appointment;
      console.log(`   ${p._id.toString()} | R$ ${(p.amount || 0).toFixed(2)} | ${p.kind} | ${p.paymentMethod} | ${p.status} | ${appt?.date ? new Date(appt.date).toLocaleDateString('pt-BR') : '—'} ${appt?.time || ''}`);
    }
    console.log(`   Subtotal: R$ ${total.toFixed(2)}`);
  }

  // Verificar duplicidades por appointment
  console.log('\n\n🔍 DUPLICIDADES POR APPOINTMENT (mais de 1 payment pago hoje):');
  const byAppt = {};
  for (const p of payments) {
    if (!p.appointment) continue;
    const id = p.appointment._id.toString();
    if (!byAppt[id]) byAppt[id] = [];
    byAppt[id].push(p);
  }
  let foundDup = false;
  for (const [id, list] of Object.entries(byAppt)) {
    if (list.length > 1) {
      foundDup = true;
      const appt = list[0].appointment;
      console.log(`\n  Appt ${id} | ${new Date(appt.date).toLocaleDateString('pt-BR')} ${appt.time} | ${appt.specialty}`);
      for (const p of list) {
        console.log(`    → ${p._id.toString()} | R$ ${(p.amount || 0).toFixed(2)} | ${p.kind} | ${p.patient?.fullName}`);
      }
    }
  }
  if (!foundDup) console.log('  Nenhuma duplicidade por appointment encontrada.');

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
