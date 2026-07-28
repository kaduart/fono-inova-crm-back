import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não configurada'); process.exit(1); }

const PATIENT_ID = '685b0cfaaec14c7163585b5b';
const PATIENT_OID = new mongoose.Types.ObjectId(PATIENT_ID);

// Hoje no fuso de Brasília
const TODAY = new Date('2026-07-27T00:00:00-03:00');
const TOMORROW = new Date('2026-07-28T00:00:00-03:00');

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log(`🔌 Conectado: ${mongoose.connection.db.databaseName}`);
  console.log(`📅 Consulta: Isis Caldas Rebelatto | pagamentos em ${TODAY.toLocaleDateString('pt-BR')}\n`);

  const Payment = (await import('../models/Payment.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const patient = await Patient.findById(PATIENT_OID).lean();
  console.log('👤 Paciente:', patient?.fullName || 'NÃO ENCONTRADO', '| ID:', PATIENT_ID);
  console.log('══════════════════════════════════════════════════════════\n');

  // Critérios: pagamentos que entraram hoje em qualquer data relevante
  const orQuery = [
    { paidAt: { $gte: TODAY, $lt: TOMORROW } },
    { financialDate: { $gte: TODAY, $lt: TOMORROW } },
    { paymentDate: { $gte: TODAY, $lt: TOMORROW } },
    { createdAt: { $gte: TODAY, $lt: TOMORROW } }
  ];

  const payments = await Payment.find({
    patient: PATIENT_OID,
    status: { $in: ['paid', 'completed', 'confirmed'] },
    $or: orQuery
  })
  .populate('appointment', 'date time specialty serviceType sessionValue paymentStatus operationalStatus')
  .populate('doctor', 'fullName specialty')
  .populate('package', 'specialty totalValue balance status')
  .sort({ paidAt: -1, createdAt: -1 })
  .lean();

  console.log(`💰 Pagamentos pagos hoje encontrados: ${payments.length}`);
  console.log('──────────────────────────────────────────────────────────');

  let total = 0;
  for (const p of payments) {
    total += p.amount || 0;
    const appt = p.appointment;
    const apptDate = appt?.date
      ? new Date(appt.date).toLocaleDateString('pt-BR')
      : '—';
    const apptTime = appt?.time || '—';
    const specialty = appt?.specialty || p.specialty || p.package?.specialty || '—';
    const method = p.paymentMethod || '—';
    const kind = p.kind || '—';

    console.log(`\n  ID Payment:  ${p._id.toString()}`);
    console.log(`  Valor:       R$ ${(p.amount || 0).toFixed(2)}`);
    console.log(`  Status:      ${p.status}`);
    console.log(`  Método:      ${method}`);
    console.log(`  Tipo:        ${kind}`);
    console.log(`  paidAt:      ${p.paidAt ? new Date(p.paidAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'}`);
    console.log(`  financialDate: ${p.financialDate ? new Date(p.financialDate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'}`);
    console.log(`  paymentDate: ${p.paymentDate ? new Date(p.paymentDate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'}`);
    console.log(`  createdAt:   ${p.createdAt ? new Date(p.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'}`);
    console.log(`  Sessão:      ${apptDate} ${apptTime} | ${specialty}`);
    if (appt) {
      console.log(`  Appt Status: ${appt.operationalStatus} / ${appt.paymentStatus}`);
      console.log(`  Appt ID:     ${appt._id.toString()}`);
    }
    if (p.package) {
      console.log(`  Pacote:      ${p.package._id.toString()} | balanço R$ ${(p.package.balance || 0).toFixed(2)}`);
    }
    if (p.notes) console.log(`  Notas:       ${p.notes}`);
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  TOTAL PAGO HOJE: R$ ${total.toFixed(2)}`);
  console.log('══════════════════════════════════════════════════════════');

  // Bônus: payments criados hoje em qualquer status (inclusive pendentes) para detectar problemas
  const allToday = await Payment.find({
    patient: PATIENT_OID,
    createdAt: { $gte: TODAY, $lt: TOMORROW }
  })
  .populate('appointment', 'date time specialty operationalStatus paymentStatus')
  .sort({ createdAt: -1 })
  .lean();

  if (allToday.length > payments.length) {
    console.log('\n⚠️  ATENÇÃO: Existem payments CRIADOS hoje que não estão "paid":');
    for (const p of allToday.filter(p => !['paid', 'completed', 'confirmed'].includes(p.status))) {
      const appt = p.appointment;
      console.log(`\n  ID: ${p._id.toString()} | Status: ${p.status} | R$ ${(p.amount || 0).toFixed(2)} | ${p.paymentMethod || '—'}`);
      console.log(`  createdAt: ${new Date(p.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
      if (appt) {
        console.log(`  Sessão: ${new Date(appt.date).toLocaleDateString('pt-BR')} ${appt.time} | ${appt.operationalStatus} / ${appt.paymentStatus}`);
      }
    }
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
