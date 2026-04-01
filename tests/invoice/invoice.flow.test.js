// tests/invoice/invoice.flow.test.js
/**
 * Testes de Fluxo de Invoice
 * 
 * Cenários testados:
 * 1. Sessão normal (completa)
 * 2. Pagamento parcial
 * 3. Fatura de pacote
 * 4. Recálculo após alteração
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Invoice from '../../models/Invoice.js';
import Payment from '../../models/Payment.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Package from '../../models/Package.js';
import { 
  createInvoice, 
  createPerSessionInvoice,
  addPaymentToInvoice,
  cancelInvoice,
  recalculateInvoice 
} from '../../domain/invoice/index.js';

// Configuração de teste
const TEST_CONFIG = {
  patientName: 'Paciente Teste Invoice',
  doctorName: 'Doutor Teste',
  sessionValue: 200,
  mongoUri: process.env.MONGO_URI || process.env.MONGODB_URI
};

// Setup inicial
async function setupTestData() {
  console.log('🧪 Criando dados de teste...\n');

  // Cria paciente
  const patient = await Patient.create({
    fullName: TEST_CONFIG.patientName,
    dateOfBirth: new Date('1990-01-01'),
    phone: '11999999999',
    email: 'teste@invoice.com'
  });

  // Cria médico
  const doctor = await Doctor.create({
    fullName: TEST_CONFIG.doctorName,
    email: `teste.${Date.now()}@doctor.com`,
    specialty: 'psicologia',
    licenseNumber: `CRM-${Date.now()}`,
    phoneNumber: '11988888888'
  });

  // Cria pacote
  const pkg = await Package.create({
    patient: patient._id,
    doctor: doctor._id,
    durationMonths: 1,
    sessionsPerWeek: 1,
    totalSessions: 10,
    sessionsDone: 0,
    totalValue: 2000,
    totalPaid: 0,
    sessionValue: 200,
    paymentType: 'per-session',
    specialty: 'psicologia',
    sessionType: 'psicologia',
    date: new Date()
  });

  // Cria agendamento
  const appointment = await Appointment.create({
    patient: patient._id,
    doctor: doctor._id,
    package: pkg._id,
    date: new Date(),
    time: '10:00',
    specialty: 'psicologia',
    sessionValue: 200,
    clinicalStatus: 'completed',
    operationalStatus: 'confirmed',
    paymentOrigin: 'auto_per_session'
  });

  // Cria sessão
  const session = await Session.create({
    patient: patient._id,
    doctor: doctor._id,
    package: pkg._id,
    appointment: appointment._id,
    date: new Date(),
    time: '10:00',
    specialty: 'psicologia',
    sessionValue: 200,
    status: 'completed',
    isPaid: false,
    paymentStatus: 'pending'
  });

  return { patient, doctor, pkg, appointment, session };
}

// Cleanup
async function cleanupTestData() {
  console.log('\n🧹 Limpando dados de teste...');
  await Invoice.deleteMany({ patient: { $ne: null } });
  await Payment.deleteMany({ patient: { $ne: null } });
  await Appointment.deleteMany({});
  await Session.deleteMany({});
  await Package.deleteMany({});
  await Patient.deleteMany({ fullName: TEST_CONFIG.patientName });
  await Doctor.deleteMany({ name: TEST_CONFIG.doctorName });
}

// Helper: Cria payment
async function createTestPayment(data) {
  return await Payment.create({
    patient: data.patientId,
    doctor: data.doctorId,
    appointment: data.appointmentId,
    amount: data.amount,
    paymentMethod: data.method || 'pix',
    status: data.status || 'paid',
    paymentOrigin: data.origin || 'auto_per_session',
    serviceDate: data.serviceDate || new Date(),
    paidAt: data.status === 'paid' ? new Date() : null,
    createdAt: new Date()
  });
}

// ==================== TESTES ====================

async function test1_SessionNormal() {
  console.log('🧪 TESTE 1: Sessão Normal (Pagamento Completo)\n');

  const { patient, doctor, appointment, session } = await setupTestData();

  try {
    // 1. Cria invoice
    const invoiceResult = await createPerSessionInvoice({
      patientId: patient._id,
      appointmentId: appointment._id,
      sessionValue: 200
    });

    console.log('✅ Invoice criada:', invoiceResult.invoice.invoiceNumber);
    console.log('   Total:', invoiceResult.total);
    console.log('   Status:', invoiceResult.invoice.status);

    // 2. Cria payment
    const payment = await createTestPayment({
      patientId: patient._id,
      doctorId: doctor._id,
      appointmentId: appointment._id,
      amount: 200,
      status: 'paid'
    });

    console.log('✅ Payment criado:', payment._id.toString());

    // 3. Adiciona payment à invoice
    const addResult = await addPaymentToInvoice({
      invoiceId: invoiceResult.invoice._id,
      paymentId: payment._id
    });

    console.log('✅ Payment adicionado:');
    console.log('   Paid Amount:', addResult.paidAmount);
    console.log('   Balance:', addResult.balance);
    console.log('   Status:', addResult.status);

    // Validações
    if (addResult.status !== 'paid') {
      throw new Error(`❌ Esperado status='paid', recebido='${addResult.status}'`);
    }
    if (addResult.balance !== 0) {
      throw new Error(`❌ Esperado balance=0, recebido=${addResult.balance}`);
    }
    if (addResult.paidAmount !== 200) {
      throw new Error(`❌ Esperado paidAmount=200, recebido=${addResult.paidAmount}`);
    }

    console.log('\n✅ TESTE 1 PASSOU!\n');
    return true;

  } catch (error) {
    console.error('❌ TESTE 1 FALHOU:', error.message);
    return false;
  }
}

async function test2_PagamentoParcial() {
  console.log('🧪 TESTE 2: Pagamento Parcial\n');

  const { patient, doctor, appointment } = await setupTestData();

  try {
    // 1. Cria invoice de 200
    const invoiceResult = await createPerSessionInvoice({
      patientId: patient._id,
      appointmentId: appointment._id,
      sessionValue: 200
    });

    console.log('✅ Invoice criada, Total:', invoiceResult.total);

    // 2. Cria payment de 80 (parcial)
    const payment = await createTestPayment({
      patientId: patient._id,
      doctorId: doctor._id,
      appointmentId: appointment._id,
      amount: 80,
      status: 'paid'
    });

    // 3. Adiciona payment
    const addResult = await addPaymentToInvoice({
      invoiceId: invoiceResult.invoice._id,
      paymentId: payment._id
    });

    console.log('✅ Payment parcial adicionado:');
    console.log('   Paid Amount:', addResult.paidAmount);
    console.log('   Balance:', addResult.balance);
    console.log('   Status:', addResult.status);

    // Validações
    if (addResult.status !== 'partial') {
      throw new Error(`❌ Esperado status='partial', recebido='${addResult.status}'`);
    }
    if (addResult.balance !== 120) {
      throw new Error(`❌ Esperado balance=120, recebido=${addResult.balance}`);
    }
    if (addResult.paidAmount !== 80) {
      throw new Error(`❌ Esperado paidAmount=80, recebido=${addResult.paidAmount}`);
    }

    console.log('\n✅ TESTE 2 PASSOU!\n');
    return true;

  } catch (error) {
    console.error('❌ TESTE 2 FALHOU:', error.message);
    return false;
  }
}

async function test3_FaturaPacote() {
  console.log('🧪 TESTE 3: Fatura de Pacote\n');

  const { patient, doctor, pkg } = await setupTestData();

  try {
    // 1. Cria invoice do pacote
    const invoiceResult = await createInvoice({
      patientId: patient._id,
      type: 'patient',
      origin: 'package',
      packageId: pkg._id,
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    console.log('✅ Invoice de pacote criada:', invoiceResult.invoice.invoiceNumber);
    console.log('   Tipo:', invoiceResult.invoice.type);
    console.log('   Origem:', invoiceResult.invoice.origin);
    console.log('   Total:', invoiceResult.total);

    // Validações
    if (invoiceResult.invoice.type !== 'patient') {
      throw new Error(`❌ Esperado type='patient', recebido='${invoiceResult.invoice.type}'`);
    }
    if (invoiceResult.invoice.origin !== 'package') {
      throw new Error(`❌ Esperado origin='package', recebido='${invoiceResult.invoice.origin}'`);
    }
    if (invoiceResult.total !== 2000) {
      throw new Error(`❌ Esperado total=2000, recebido=${invoiceResult.total}`);
    }

    console.log('\n✅ TESTE 3 PASSOU!\n');
    return true;

  } catch (error) {
    console.error('❌ TESTE 3 FALHOU:', error.message);
    return false;
  }
}

async function test4_Recalculo() {
  console.log('🧪 TESTE 4: Recálculo após Alteração\n');

  const { patient, doctor, appointment } = await setupTestData();

  try {
    // 1. Cria invoice
    const invoiceResult = await createPerSessionInvoice({
      patientId: patient._id,
      appointmentId: appointment._id,
      sessionValue: 200
    });

    // 2. Cria e adiciona payment
    const payment = await createTestPayment({
      patientId: patient._id,
      doctorId: doctor._id,
      appointmentId: appointment._id,
      amount: 200,
      status: 'paid'
    });

    await addPaymentToInvoice({
      invoiceId: invoiceResult.invoice._id,
      paymentId: payment._id
    });

    console.log('✅ Invoice paga, status: paid');

    // 3. Simula "remoção" do payment (altera status para canceled)
    await Payment.findByIdAndUpdate(payment._id, { status: 'canceled' });
    console.log('✅ Payment cancelado (simulação)');

    // 4. Recalcula invoice
    const recalcResult = await recalculateInvoice({
      invoiceId: invoiceResult.invoice._id
    });

    console.log('✅ Invoice recalculada:');
    console.log('   Paid Amount:', recalcResult.invoice.paidAmount);
    console.log('   Balance:', recalcResult.invoice.balance);
    console.log('   Status:', recalcResult.invoice.status);

    // Validações: payment cancelado não conta
    if (recalcResult.invoice.paidAmount !== 0) {
      throw new Error(`❌ Esperado paidAmount=0 após cancelamento, recebido=${recalcResult.invoice.paidAmount}`);
    }
    if (recalcResult.invoice.balance !== 200) {
      throw new Error(`❌ Esperado balance=200, recebido=${recalcResult.invoice.balance}`);
    }

    console.log('\n✅ TESTE 4 PASSOU!\n');
    return true;

  } catch (error) {
    console.error('❌ TESTE 4 FALHOU:', error.message);
    return false;
  }
}

async function test5_CancelProtecao() {
  console.log('🧪 TESTE 5: Proteção contra Cancelamento\n');

  const { patient, doctor, appointment } = await setupTestData();

  try {
    // 1. Cria invoice e paga
    const invoiceResult = await createPerSessionInvoice({
      patientId: patient._id,
      appointmentId: appointment._id,
      sessionValue: 200
    });

    const payment = await createTestPayment({
      patientId: patient._id,
      doctorId: doctor._id,
      appointmentId: appointment._id,
      amount: 200,
      status: 'paid'
    });

    await addPaymentToInvoice({
      invoiceId: invoiceResult.invoice._id,
      paymentId: payment._id
    });

    console.log('✅ Invoice paga');

    // 2. Tenta cancelar (deve falhar)
    try {
      await cancelInvoice({
        invoiceId: invoiceResult.invoice._id,
        reason: 'Tentativa inválida'
      });
      throw new Error('❌ Deveria ter lançado erro ao cancelar fatura paga');
    } catch (error) {
      if (error.message === 'CANNOT_CANCEL_PAID_INVOICE') {
        console.log('✅ Proteção funcionou: não permitiu cancelar fatura paga');
      } else {
        throw error;
      }
    }

    console.log('\n✅ TESTE 5 PASSOU!\n');
    return true;

  } catch (error) {
    console.error('❌ TESTE 5 FALHOU:', error.message);
    return false;
  }
}

// ==================== MAIN ====================

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     🧪 TESTES DE FLUXO DE INVOICE - INICIANDO          ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  // Conecta ao MongoDB
  try {
    await mongoose.connect(TEST_CONFIG.mongoUri);
    console.log('✅ Conectado ao MongoDB:', TEST_CONFIG.mongoUri, '\n');
  } catch (error) {
    console.error('❌ Erro ao conectar ao MongoDB:', error.message);
    process.exit(1);
  }

  const results = [];

  try {
    results.push({ test: 'Sessão Normal', passed: await test1_SessionNormal() });
    await cleanupTestData();

    results.push({ test: 'Pagamento Parcial', passed: await test2_PagamentoParcial() });
    await cleanupTestData();

    results.push({ test: 'Fatura de Pacote', passed: await test3_FaturaPacote() });
    await cleanupTestData();

    results.push({ test: 'Recálculo', passed: await test4_Recalculo() });
    await cleanupTestData();

    results.push({ test: 'Proteção Cancel', passed: await test5_CancelProtecao() });
    await cleanupTestData();

  } catch (error) {
    console.error('❌ Erro durante testes:', error);
  } finally {
    await cleanupTestData();
    await mongoose.connection.close();
    console.log('🔌 Desconectado do MongoDB\n');
  }

  // Relatório final
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║              📊 RELATÓRIO DE TESTES                    ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  results.forEach(r => {
    const icon = r.passed ? '✅' : '❌';
    console.log(`║  ${icon} ${r.test.padEnd(45)} ║`);
  });

  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  TOTAL: ${passed}/${total} testes passaram${' '.repeat(28 - String(passed).length - String(total).length)}║`);
  console.log('╚════════════════════════════════════════════════════════╝\n');

  if (passed === total) {
    console.log('🎉 TODOS OS TESTES PASSARAM! Sistema pronto para produção.\n');
    process.exit(0);
  } else {
    console.log('⚠️  ALGUNS TESTES FALHARAM. Revise antes de subir.\n');
    process.exit(1);
  }
}

// Roda se for executado diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests();
}

export { runAllTests };
