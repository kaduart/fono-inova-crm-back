import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';

const MONGO_URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

async function main() {
  await mongoose.connect(MONGO_URI);
  const patientId = '685b0cfaaec14c7163585b5b';
  const patientOid = new mongoose.Types.ObjectId(patientId);

  console.log('══════════════════════════════════════════════════════════');
  console.log('  ESTADO ATUAL NO BANCO — ISIS CALDAS REBELATTO');
  console.log('══════════════════════════════════════════════════════════\n');

  // 1. PACOTES PER-SESSION
  const packages = await Package.find({
    patient: patientOid,
    model: 'per_session'
  }).lean();

  console.log('📦 PACOTES PER-SESSION');
  console.log('──────────────────────────────────────────────────────────');
  let totalPackageDebt = 0;
  for (const pkg of packages) {
    const balance = pkg.balance || 0;
    totalPackageDebt += balance;
    console.log('Especialidade:', pkg.specialty || pkg.sessionType);
    console.log('  Valor total:  R$', (pkg.totalValue || 0).toFixed(2));
    console.log('  Total pago:   R$', (pkg.totalPaid || 0).toFixed(2));
    console.log('  Balance:      R$', balance.toFixed(2));
    console.log('  Sessões feitas:', pkg.sessionsDone || 0);
    console.log('  Status:', pkg.status);
    console.log('');
  }

  // 2. PAYMENTS AVULSOS (SEM APPOINTMENT)
  const avulsos = await Payment.find({
    patient: patientOid,
    appointment: { $exists: false },
    package: { $exists: false }
  }).lean();

  console.log('💳 PAYMENTS AVULSOS (SEM APPOINTMENT)');
  console.log('──────────────────────────────────────────────────────────');
  if (avulsos.length === 0) {
    console.log('Nenhum payment avulso.\n');
  } else {
    avulsos.forEach(p => {
      console.log('ID:', p._id.toString(), '|', p.status, '| R$', (p.amount || 0).toFixed(2), '|', p.createdAt);
    });
    console.log('');
  }

  // 3. APPOINTMENTS + PAYMENTS (27/04 a 22/05)
  const start = new Date('2026-04-27T00:00:00-03:00');
  const end = new Date('2026-05-22T23:59:59-03:00');

  const appointments = await Appointment.find({
    patient: patientOid,
    date: { $gte: start, $lte: end }
  }).sort({ date: 1, time: 1 }).lean();

  console.log('📅 ATENDIMENTOS DE 27/04 A 22/05 + PAYMENTS');
  console.log('──────────────────────────────────────────────────────────');
  for (const appt of appointments) {
    const payments = await Payment.find({ appointment: appt._id }).lean();
    const d = new Date(appt.date).toLocaleDateString('pt-BR');
    const hasPkg = appt.package ? 'SIM' : 'NAO';
    const payInfo = payments.map(p => p.status + '=R$' + (p.amount||0)).join(' | ') || 'nenhum';
    console.log(d, appt.time, '|', (appt.specialty||'—').padEnd(22), '|', appt.operationalStatus.padEnd(10), '| pkg:', hasPkg, '|', payInfo);
  }
  console.log('');

  // 4. RESUMO CONSOLIDADO
  const allPendingPayments = await Payment.find({
    patient: patientOid,
    status: 'pending'
  }).lean();

  const totalPendingPayments = allPendingPayments.reduce((s, p) => s + (p.amount || 0), 0);

  console.log('══════════════════════════════════════════════════════════');
  console.log('  RESUMO CONSOLIDADO');
  console.log('══════════════════════════════════════════════════════════');
  console.log('Débito de pacotes (Package.balance):     R$', totalPackageDebt.toFixed(2));
  console.log('Payments pendentes avulsos:              R$', totalPendingPayments.toFixed(2));
  console.log('  →', allPendingPayments.length, 'payments pending');
  allPendingPayments.forEach(p => {
    console.log('     ', p._id.toString(), '| R$', (p.amount||0).toFixed(2), '| appt:', p.appointment?.toString() || 'avulso');
  });
  console.log('──────────────────────────────────────────────────────────');
  console.log('TOTAL DEVIDO REAL:                       R$', (totalPackageDebt + totalPendingPayments).toFixed(2));
  console.log('══════════════════════════════════════════════════════════');

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
