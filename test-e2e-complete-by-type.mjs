import mongoose from 'mongoose';
import axios from 'axios';

const BASE_URL = 'http://localhost:5000';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4MDZkZDFiYjZmOTI1NTliNDlhOGE5YyIsInJvbGUiOiJhZG1pbiIsIm5hbWUiOiJSaWNhcmRvIE1haWEgQWRtaW4iLCJpYXQiOjE3NzYwOTkwOTIsImV4cCI6MTc3NjE4NTQ5Mn0.pyJovW-uOkvJ0oK6IHlzmPFyQqCdQUnzIutcxpqep6s';
const MONGO_URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test';

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

let Appointment, Session, Package, Payment, Patient, Doctor, Specialty, FinancialLedger;

function log(title, data) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${title}`);
  if (data) console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

async function loadModels() {
  Appointment = (await import('./models/Appointment.js')).default;
  Session = (await import('./models/Session.js')).default;
  Package = (await import('./models/Package.js')).default;
  Payment = (await import('./models/Payment.js')).default;
  Patient = (await import('./models/Patient.js')).default;
  Doctor = (await import('./models/Doctor.js')).default;
  Specialty = (await import('./models/Specialty.js')).default;
  FinancialLedger = (await import('./models/FinancialLedger.js')).default;
}

async function getOrCreateDoctor() {
  let doc = await Doctor.findOne().lean();
  if (doc) return doc._id;
  doc = await Doctor.create({ name: 'Dr. Teste', email: 'dr.teste@e2e.com', password: '123456' });
  return doc._id;
}

async function getOrCreateSpecialty() {
  let spec = await Specialty.findOne().lean();
  if (spec) return spec._id;
  spec = await Specialty.create({ name: 'Fonoaudiologia' });
  return spec._id;
}

async function createPatient(overrides = {}) {
  const count = Math.floor(Math.random() * 100000);
  return Patient.create({
    name: `Paciente Teste ${count}`,
    fullName: `Paciente Teste Completo ${count}`,
    phone: `1199999${count.toString().padStart(4, '0')}`,
    dateOfBirth: new Date('1990-01-01'),
    ...overrides
  });
}

async function createPackage(patientId, overrides = {}) {
  const doctorId = await getOrCreateDoctor();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return Package.create({
    patient: patientId,
    doctor: doctorId,
    specialty: 'fonoaudiologia',
    sessionType: 'fonoaudiologia',
    date: tomorrow,
    totalSessions: 10,
    sessionsDone: 0,
    totalValue: 1000,
    totalPaid: 0,
    balance: 1000,
    status: 'active',
    model: 'prepaid',
    type: 'therapy',
    paymentType: 'full',
    sessionsPerWeek: 1,
    durationMonths: 3,
    ...overrides
  });
}

async function createAppointmentAndSession(patientId, overrides = {}) {
  const doctorId = await getOrCreateDoctor();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];

  const appt = await Appointment.create({
    patient: patientId,
    doctor: doctorId,
    date: tomorrow,
    time: '09:00',
    status: 'scheduled',
    clinicalStatus: 'scheduled',
    paymentStatus: 'pending',
    operationalStatus: 'scheduled',
    specialty: 'fonoaudiologia',
    kind: 'particular',
    billingType: 'particular',
    ...overrides.appointment
  });

  const sess = await Session.create({
    appointmentId: appt._id,
    patient: patientId,
    doctor: doctorId,
    date: tomorrow,
    time: '09:00',
    status: 'scheduled',
    isPaid: false,
    sessionType: 'fonoaudiologia',
    ...overrides.session
  });

  appt.session = sess._id;
  await appt.save();

  return { appointment: appt, session: sess };
}

async function completeAppointment(appointmentId, payload = {}) {
  const url = `${BASE_URL}/api/v2/appointments/${appointmentId}/complete`;
  const res = await axios.patch(url, payload, { headers });
  return res.data;
}

async function fetchState(appointmentId) {
  const appt = await Appointment.findById(appointmentId)
    .populate('session patient doctor package payment')
    .lean();
  const ledgers = await FinancialLedger.find({ appointment: appointmentId }).lean();
  return { appointment: appt, session: appt?.session, package: appt?.package, payment: appt?.payment, ledgers };
}

function assert(condition, message) {
  if (!condition) throw new Error(`❌ ASSERT FAILED: ${message}`);
  console.log(`✅ ${message}`);
}

// ============================================
// TESTES
// ============================================
async function testParticularPaid() {
  log('▶️ TESTE: Particular pago no ato');
  const patient = await createPatient();
  const { appointment } = await createAppointmentAndSession(patient._id, {
    appointment: { sessionValue: 150 }
  });
  
  const res = await completeAppointment(appointment._id);
  const after = await fetchState(appointment._id);
  
  assert(res.success === true, 'API retornou success');
  assert(res.data.paymentStatus === 'paid', 'paymentStatus é paid');
  assert(after.appointment.operationalStatus === 'completed', 'Appointment operationalStatus completed');
  assert(after.session.status === 'completed', 'Session status completed');
  assert(after.session.isPaid === true, 'Session isPaid true');
  assert(after.session.paidAt != null, 'Session paidAt preenchido');
  assert(after.payment != null, 'Payment foi criado');
  assert(after.payment.status === 'paid', 'Payment status paid');
  assert(after.payment.kind === 'session_payment', 'Payment kind session_payment');
  assert(after.ledgers.some(l => l.type === 'payment_received'), 'Ledger payment_received existe');
  
  log('✅ PASSOU: Particular pago no ato');
}

async function testParticularFiado() {
  log('▶️ TESTE: Particular fiado (addToBalance)');
  const patient = await createPatient();
  const { appointment } = await createAppointmentAndSession(patient._id, {
    appointment: { sessionValue: 250 }
  });
  
  const res = await completeAppointment(appointment._id, { addToBalance: true });
  const after = await fetchState(appointment._id);
  
  assert(res.success === true, 'API retornou success');
  assert(res.data.paymentStatus === 'unpaid', 'paymentStatus é unpaid');
  assert(res.data.balanceAmount === 250, 'balanceAmount 250');
  assert(after.appointment.operationalStatus === 'completed', 'Appointment operationalStatus completed');
  assert(after.payment == null, 'Nenhum Payment criado para fiado');
  assert(after.ledgers.some(l => l.type === 'payment_pending' && l.amount === 250), 'Ledger payment_pending 250 existe');
  
  log('✅ PASSOU: Particular fiado');
}

async function testPrepaid() {
  log('▶️ TESTE: Pacote prepaid');
  const patient = await createPatient();
  const pkg = await createPackage(patient._id, { model: 'prepaid', type: 'therapy', paymentType: 'full', totalSessions: 5, sessionsDone: 0, sessionValue: 200 });
  const { appointment } = await createAppointmentAndSession(patient._id, {
    appointment: { package: pkg._id, kind: 'particular', billingType: 'particular' },
    session: {}
  });
  
  const beforePkg = await Package.findById(pkg._id).lean();
  const res = await completeAppointment(appointment._id);
  const after = await fetchState(appointment._id);
  const afterPkg = await Package.findById(pkg._id).lean();
  
  assert(res.success === true, 'API retornou success');
  assert(res.data.paymentStatus === 'paid', 'paymentStatus é paid (prepaid)');
  assert(after.appointment.operationalStatus === 'completed', 'Appointment operationalStatus completed');
  assert(after.session.isPaid === true, 'Session isPaid true');
  assert(afterPkg.sessionsDone === beforePkg.sessionsDone + 1, 'Package sessionsDone incrementado');
  assert(after.ledgers.some(l => l.type === 'package_consumed'), 'Ledger package_consumed existe');
  
  log('✅ PASSOU: Pacote prepaid');
}

async function testConvenio() {
  log('▶️ TESTE: Convênio (valor zero)');
  const patient = await createPatient();
  const pkg = await createPackage(patient._id, { model: 'convenio', type: 'convenio', totalSessions: 5, sessionsDone: 0, sessionValue: 0 });
  const { appointment } = await createAppointmentAndSession(patient._id, {
    appointment: { package: pkg._id, kind: 'convenio', billingType: 'convenio' },
    session: {}
  });
  
  const beforePkg = await Package.findById(pkg._id).lean();
  const res = await completeAppointment(appointment._id);
  const after = await fetchState(appointment._id);
  const afterPkg = await Package.findById(pkg._id).lean();
  
  assert(res.success === true, 'API retornou success');
  assert(res.data.paymentStatus === 'paid', 'paymentStatus é paid (convenio)');
  assert(res.data.sessionValue === 0, 'sessionValue 0');
  assert(after.appointment.operationalStatus === 'completed', 'Appointment operationalStatus completed');
  assert(after.payment == null, 'Nenhum Payment criado para convenio zero');
  assert(afterPkg.sessionsDone === beforePkg.sessionsDone + 1, 'Package sessionsDone incrementado');
  assert(after.ledgers.some(l => l.type === 'package_consumed'), 'Ledger package_consumed existe');
  
  log('✅ PASSOU: Convênio');
}

async function testLiminar() {
  log('▶️ TESTE: Liminar (consome crédito)');
  const patient = await createPatient();
  const pkg = await createPackage(patient._id, { model: 'liminar', type: 'liminar', totalSessions: 5, sessionsDone: 0, liminarCreditBalance: 600, sessionValue: 300 });
  const { appointment } = await createAppointmentAndSession(patient._id, {
    appointment: { package: pkg._id, kind: 'liminar', billingType: 'liminar' },
    session: {}
  });
  
  const beforePkg = await Package.findById(pkg._id).lean();
  const res = await completeAppointment(appointment._id);
  const after = await fetchState(appointment._id);
  const afterPkg = await Package.findById(pkg._id).lean();
  
  assert(res.success === true, 'API retornou success');
  assert(res.data.paymentStatus === 'paid', 'paymentStatus é paid (liminar)');
  assert(afterPkg.liminarCreditBalance === beforePkg.liminarCreditBalance - 300, `Crédito liminar reduziu 300 (${beforePkg.liminarCreditBalance} -> ${afterPkg.liminarCreditBalance})`);
  assert(after.payment == null, 'Nenhum Payment criado para liminar');
  assert(after.ledgers.some(l => l.type === 'package_consumed'), 'Ledger package_consumed existe');
  
  log('✅ PASSOU: Liminar');
}

async function testIdempotency() {
  log('▶️ TESTE: Idempotência');
  const patient = await createPatient();
  const pkg = await createPackage(patient._id, { totalSessions: 5, sessionsDone: 0, sessionValue: 100 });
  const { appointment } = await createAppointmentAndSession(patient._id, {
    appointment: { package: pkg._id, billingType: 'particular' },
    session: {}
  });
  
  const res1 = await completeAppointment(appointment._id);
  const pkgAfter1 = await Package.findById(pkg._id).lean();
  
  const res2 = await completeAppointment(appointment._id);
  const pkgAfter2 = await Package.findById(pkg._id).lean();
  
  assert(res1.success === true, 'Primeira chamada success');
  assert(res2.success === true, 'Segunda chamada success');
  assert(res2.idempotent === true, 'Segunda chamada retornou idempotent');
  assert(pkgAfter2.sessionsDone === pkgAfter1.sessionsDone, 'Package sessionsDone NÃO duplicou');
  
  log('✅ PASSOU: Idempotência');
}

async function testPackageLimit() {
  log('▶️ TESTE: Limite de pacote esgotado');
  const patient = await createPatient();
  const pkg = await createPackage(patient._id, { totalSessions: 1, sessionsDone: 1, sessionValue: 100 });
  const { appointment } = await createAppointmentAndSession(patient._id, {
    appointment: { package: pkg._id, billingType: 'particular' },
    session: {}
  });
  
  try {
    await completeAppointment(appointment._id);
    assert(false, 'Deveria ter lançado erro PACKAGE_LIMIT_REACHED');
  } catch (err) {
    assert(err.response?.status === 500 || err.response?.data?.message?.includes('PACKAGE_LIMIT_REACHED'), `Erro correto retornado: ${err.response?.data?.message || err.message}`);
  }
  
  log('✅ PASSOU: Limite de pacote esgotado');
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('🧪 Iniciando testes E2E de /complete por tipo de sessão...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB conectado');
  await loadModels();

  const tests = [
    testParticularPaid,
    testParticularFiado,
    testPrepaid,
    testConvenio,
    testLiminar,
    testIdempotency,
    testPackageLimit,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      log(`❌ FALHOU: ${test.name}`, err.message);
      if (err.response) {
        console.log('API Response:', JSON.stringify(err.response.data, null, 2));
      }
      failed++;
    }
  }

  log(`RESULTADO FINAL: ${passed} passaram, ${failed} falharam`);
  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
