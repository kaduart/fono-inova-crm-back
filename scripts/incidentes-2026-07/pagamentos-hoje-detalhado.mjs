import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

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
  const Appointment = (await import('../models/Appointment.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const payments = await Payment.find({
    status: { $in: ['paid', 'completed', 'confirmed'] },
    $or: [
      { paidAt: { $gte: TODAY, $lt: TOMORROW } },
      { financialDate: { $gte: TODAY, $lt: TOMORROW } },
      { paymentDate: { $gte: TODAY, $lt: TOMORROW } },
      { createdAt: { $gte: TODAY, $lt: TOMORROW } }
    ]
  })
  .populate('patient', 'fullName')
  .populate('appointment', 'date time specialty operationalStatus paymentStatus')
  .populate('doctor', 'fullName specialty')
  .sort({ paidAt: -1, createdAt: -1 })
  .lean();

  const CASH_EXCLUDED_KINDS = ['monthly_settlement', 'debt_settlement'];
  const cashPayments = payments.filter(p => !CASH_EXCLUDED_KINDS.includes(p.kind));

  const totalCash = cashPayments.reduce((acc, p) => acc + (p.amount || 0), 0);
  const byMethod = {};
  const byKind = {};
  const byPatient = {};
  for (const p of cashPayments) {
    const method = p.paymentMethod || 'unknown';
    const kind = p.kind || 'unknown';
    const patientName = p.patient?.fullName || 'N/A';
    byMethod[method] = (byMethod[method] || 0) + (p.amount || 0);
    byKind[kind] = (byKind[kind] || 0) + (p.amount || 0);
    byPatient[patientName] = (byPatient[patientName] || 0) + (p.amount || 0);
  }

  console.log('══════════════════════════════════════════════════════════');
  console.log('  TODOS OS PAGAMENTOS DE HOJE (27/07/2026)');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`Total de payments (bruto): ${payments.length}`);
  console.log(`Excluídos (monthly_settlement/debt_settlement): ${payments.length - cashPayments.length}`);
  console.log(`Caixa líquido: R$ ${totalCash.toFixed(2)}`);
  console.log('\nPor método:');
  for (const [method, amount] of Object.entries(byMethod)) {
    console.log(`  ${method}: R$ ${amount.toFixed(2)}`);
  }
  console.log('\nPor tipo (kind):');
  for (const [kind, amount] of Object.entries(byKind)) {
    console.log(`  ${kind}: R$ ${amount.toFixed(2)}`);
  }
  console.log('\nPor paciente:');
  for (const [name, amount] of Object.entries(byPatient).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: R$ ${amount.toFixed(2)}`);
  }
  console.log('\n──────────────────────────────────────────────────────────');
  console.log('DETALHAMENTO:');
  console.log('──────────────────────────────────────────────────────────');

  const details = [];
  for (const p of cashPayments) {
    const appt = p.appointment;
    const sessionDate = appt?.date ? new Date(appt.date).toLocaleDateString('pt-BR') : '—';
    const sessionTime = appt?.time || '—';
    const specialty = appt?.specialty || p.specialty || '—';
    const record = {
      id: p._id.toString(),
      patient: p.patient?.fullName || 'N/A',
      patientId: p.patient?._id?.toString(),
      amount: p.amount || 0,
      method: p.paymentMethod || '—',
      status: p.status,
      kind: p.kind || '—',
      billingType: p.billingType || '—',
      paidAt: p.paidAt ? new Date(p.paidAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—',
      financialDate: p.financialDate ? new Date(p.financialDate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—',
      paymentDate: p.paymentDate ? new Date(p.paymentDate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—',
      createdAt: p.createdAt ? new Date(p.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—',
      session: `${sessionDate} ${sessionTime} | ${specialty}`,
      appointmentId: appt?._id?.toString() || '—',
      notes: p.notes || '—'
    };
    details.push(record);
    console.log(`\n  ${record.patient}`);
    console.log(`    ID: ${record.id} | R$ ${record.amount.toFixed(2)} | ${record.method} | ${record.kind}`);
    console.log(`    Sessão: ${record.session}`);
    console.log(`    paidAt: ${record.paidAt} | createdAt: ${record.createdAt}`);
  }

  const outputPath = path.resolve(__dirname, '../../auditoria-output/pagamentos-hoje-2026-07-27.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({
    date: '2026-07-27',
    generatedAt: new Date().toISOString(),
    totalCash,
    byMethod,
    byKind,
    byPatient,
    count: cashPayments.length,
    details
  }, null, 2));
  console.log(`\n📝 Relatório salvo em: ${outputPath}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
