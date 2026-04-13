import mongoose from 'mongoose';
import axios from 'axios';

// ============================================
// CONFIGURAÇÕES
// ============================================
const BASE_URL = 'http://localhost:5000';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4MDZkZDFiYjZmOTI1NTliNDlhOGE5YyIsInJvbGUiOiJhZG1pbiIsIm5hbWUiOiJSaWNhcmRvIE1haWEgQWRtaW4iLCJpYXQiOjE3NzYwOTkwOTIsImV4cCI6MTc3NjE4NTQ5Mn0.pyJovW-uOkvJ0oK6IHlzmPFyQqCdQUnzIutcxpqep6s';
const MONGO_URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test';

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

// Modelos (serão carregados depois de conectar)
let Appointment, Session, Package, Payment, Patient, FinancialLedger;

// ============================================
// HELPERS
// ============================================
function log(title, data) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${title}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  if (data) console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
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
  
  return {
    appointment: appt,
    session: appt?.session || null,
    package: appt?.package || null,
    payment: appt?.payment || null,
    ledgers,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`❌ ASSERT FAILED: ${message}`);
  console.log(`✅ ${message}`);
}

// ============================================
// CENÁRIOS DE TESTE
// ============================================
const tests = [];

// --- CENÁRIO 1: Particular pago no ato (sessionValue > 0) ---
tests.push({
  name: 'Particular pago no ato',
  appointmentId: '69dd2f3b270ffed225b8e9d7',
  payload: { sessionValue: 150 },
  validate: async (before, after, apiRes) => {
    assert(apiRes.success === true, 'API retornou success');
    assert(apiRes.data.paymentStatus === 'paid', 'paymentStatus é paid');
    assert(after.appointment.operationalStatus === 'completed', 'Appointment operationalStatus completed');
    assert(after.session.status === 'completed', 'Session status completed');
    assert(after.session.isPaid === true, 'Session isPaid true');
    assert(after.session.paidAt !== null, 'Session paidAt preenchido');
    assert(after.payment !== null, 'Payment foi criado/encontrado');
    assert(after.payment.status === 'paid', 'Payment status paid');
    assert(after.payment.kind === 'session_payment', 'Payment kind session_payment');
    assert(after.ledgers.some(l => l.type === 'payment_received'), 'Ledger payment_received existe');
  }
});

// --- CENÁRIO 2: Particular fiado (addToBalance) ---
tests.push({
  name: 'Particular fiado (addToBalance)',
  appointmentId: '67fe3cc01e1f62e7d92a1b9e',
  payload: { sessionValue: 250, addToBalance: true },
  validate: async (before, after, apiRes) => {
    assert(apiRes.success === true, 'API retornou success');
    assert(apiRes.data.paymentStatus === 'unpaid', 'paymentStatus é unpaid');
    assert(apiRes.data.balanceAmount === 250, 'balanceAmount 250');
    assert(after.appointment.operationalStatus === 'completed', 'Appointment operationalStatus completed');
    assert(after.payment === null, 'Nenhum Payment criado para fiado');
    assert(after.ledgers.some(l => l.type === 'payment_pending' && l.amount === 250), 'Ledger payment_pending 250 existe');
  }
});

// --- CENÁRIO 3: Pacote prepaid ---
tests.push({
  name: 'Pacote prepaid',
  appointmentId: '67fe34cd1e1f62e7d92a14e8',
  payload: { sessionValue: 0 },
  validate: async (before, after, apiRes) => {
    assert(apiRes.success === true, 'API retornou success');
    assert(apiRes.data.paymentStatus === 'paid', 'paymentStatus é paid (prepaid)');
    assert(after.appointment.operationalStatus === 'completed', 'Appointment operationalStatus completed');
    assert(after.session.isPaid === true, 'Session isPaid true');
    assert(after.package.sessionsDone === (before.package?.sessionsDone || 0) + 1, 'Package sessionsDone incrementado');
    assert(after.ledgers.some(l => l.type === 'package_consumed'), 'Ledger package_consumed existe');
  }
});

// --- CENÁRIO 4: Convênio (valor zero) ---
tests.push({
  name: 'Convênio (valor zero)',
  appointmentId: '69dd2f3b270ffed225b8e9d7',
  payload: { sessionValue: 0 },
  validate: async (before, after, apiRes) => {
    assert(apiRes.success === true, 'API retornou success');
    assert(apiRes.data.paymentStatus === 'paid', 'paymentStatus é paid (convenio)');
    assert(apiRes.data.sessionValue === 0, 'sessionValue 0');
    assert(after.appointment.operationalStatus === 'completed', 'Appointment operationalStatus completed');
    assert(after.payment === null, 'Nenhum Payment criado para convenio zero');
    assert(after.package?.sessionsDone === (before.package?.sessionsDone || 0) + 1, 'Package sessionsDone incrementado');
    assert(after.ledgers.some(l => l.type === 'package_consumed'), 'Ledger package_consumed existe');
  }
});

// --- CENÁRIO 5: Liminar (consome crédito) ---
tests.push({
  name: 'Liminar (consome crédito)',
  appointmentId: '67fe3a891e1f62e7d92a1989',
  payload: { sessionValue: 300 },
  validate: async (before, after, apiRes) => {
    const creditBefore = before.appointment?.patient?.liminarCreditBalance || 0;
    const creditAfter = after.appointment?.patient?.liminarCreditBalance || 0;
    assert(apiRes.success === true, 'API retornou success');
    assert(apiRes.data.paymentStatus === 'paid', 'paymentStatus é paid (liminar)');
    assert(creditAfter === creditBefore - 300, `Crédito liminar reduziu 300 (${creditBefore} -> ${creditAfter})`);
    assert(after.payment === null, 'Nenhum Payment criado para liminar');
    assert(after.ledgers.some(l => l.type === 'package_consumed'), 'Ledger package_consumed existe');
  }
});

// --- CENÁRIO 6: Idempotência ---
tests.push({
  name: 'Idempotência (completar 2x não duplica)',
  appointmentId: '69dd2f3b270ffed225b8e9d7',
  payload: { sessionValue: 0 },
  runTwice: true,
  validate: async (before, after, apiRes, secondRes) => {
    assert(apiRes.success === true, 'Primeira chamada success');
    assert(secondRes.success === true, 'Segunda chamada success');
    assert(secondRes.idempotent === true, 'Segunda chamada retornou idempotent');
    assert(after.package?.sessionsDone === (before.package?.sessionsDone || 0) + 1, 'Package sessionsDone NÃO duplicou');
  }
});

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('🧪 Iniciando testes E2E de /complete por tipo de sessão...');
  
  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB conectado');

  // Carrega modelos dinamicamente
  Appointment = (await import('./models/Appointment.js')).default;
  Session = (await import('./models/Session.js')).default;
  Package = (await import('./models/Package.js')).default;
  Payment = (await import('./models/Payment.js')).default;
  Patient = (await import('./models/Patient.js')).default;
  FinancialLedger = (await import('./models/FinancialLedger.js')).default;

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      log(`▶️ TESTE: ${test.name}`);
      
      // Reset básico: se for reutilizar o mesmo appointment, pode precisar resetar
      // Mas aqui assumimos que cada appointmentId é dedicado ou já está no estado correto
      const before = await fetchState(test.appointmentId);
      
      // Primeira chamada
      const res1 = await completeAppointment(test.appointmentId, test.payload);
      
      // Segunda chamada se idempotência
      let res2 = null;
      if (test.runTwice) {
        res2 = await completeAppointment(test.appointmentId, test.payload);
      }
      
      const after = await fetchState(test.appointmentId);
      
      await test.validate(before, after, res1, res2);
      
      log(`✅ PASSOU: ${test.name}`);
      passed++;
    } catch (err) {
      log(`❌ FALHOU: ${test.name}`, err.message);
      failed++;
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  RESULTADO FINAL: ${passed} passaram, ${failed} falharam`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
