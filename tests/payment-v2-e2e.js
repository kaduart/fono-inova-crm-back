#!/usr/bin/env node
/**
 * 🧪 TESTE E2E COMPLETO - Payment V2
 * Testa o fluxo: API → Evento → Worker → Projeção
 * 
 * Uso: node tests/payment-v2-e2e.js
 * Ou: npm run test:payment-v2
 */

import mongoose from 'mongoose';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import PatientsView from '../models/PatientsView.js';
import EventStore from '../models/EventStore.js';
import { publishEvent } from '../infrastructure/events/eventPublisher.js';
import { EventTypes } from '../infrastructure/events/eventPublisher.js';

// ============================================
// CONFIG
// ============================================

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function log(step, msg, color = 'reset') {
  console.log(`${colors[color]}[${step}]${colors.reset} ${msg}`);
}

// ============================================
// TEST 1: Criar pagamento individual_session
// ============================================

async function testIndividualSession() {
  log('TEST-1', '🧪 Pagamento com individual_session', 'cyan');
  
  // 1. Criar dados
  const patient = await Patient.create({
    fullName: 'TEST_E2E_INDIVIDUAL',
    dateOfBirth: new Date('1990-01-01'),
    phone: '11999999999'
  });
  
  const doctor = await Doctor.create({
    name: 'TEST_DOCTOR',
    specialty: 'Psicologia'
  });
  
  log('SETUP', `Paciente: ${patient._id}`, 'blue');
  log('SETUP', `Médico: ${doctor._id}`, 'blue');
  
  // 2. Criar pagamento
  const payment = await Payment.create({
    patient: patient._id,
    doctor: doctor._id,
    serviceType: 'individual_session',
    sessionType: 'sessao_individual',
    amount: 250.00,
    paymentMethod: 'pix',
    status: 'paid',
    paidAt: new Date()
  });
  
  log('CREATE', `Pagamento: ${payment._id}`, 'green');
  
  // 3. Criar sessão (simula worker)
  const session = await Session.create({
    serviceType: 'individual_session',
    patient: patient._id,
    doctor: doctor._id,
    status: 'completed',
    paymentStatus: 'paid',
    paidAt: new Date()
  });
  
  log('WORKER', `Sessão criada: ${session._id}`, 'green');
  
  // 4. Emitir evento
  const eventResult = await publishEvent(
    EventTypes.PAYMENT_COMPLETED,
    {
      paymentId: payment._id.toString(),
      patientId: patient._id.toString(),
      doctorId: doctor._id.toString(),
      amount: 250.00,
      serviceType: 'individual_session',
      sessionId: session._id.toString()
    },
    {
      aggregateType: 'payment',
      aggregateId: payment._id.toString(),
      correlationId: `test_${Date.now()}`
    }
  );
  
  log('EVENT', `Evento: ${eventResult.eventId}`, 'green');
  
  // 5. Aguardar projeção
  await new Promise(r => setTimeout(r, 1000));
  
  // 6. Verificar
  const view = await PatientsView.findOne({ patientId: patient._id });
  
  // Cleanup
  await cleanup({ patient, doctor, payment, session });
  
  if (!view) {
    log('ASSERT', '❌ View não encontrada', 'red');
    return false;
  }
  
  log('ASSERT', `✅ View atualizada: R$ ${view.stats?.totalRevenue || 0}`, 'green');
  return true;
}

// ============================================
// TEST 2: Validação de campos obrigatórios
// ============================================

async function testValidation() {
  log('TEST-2', '🧪 Validação de campos obrigatórios', 'cyan');
  
  try {
    // Tentar criar pagamento inválido
    await Payment.create({
      amount: -100, // Inválido
      paymentMethod: 'pix'
    });
    
    log('ASSERT', '❌ Deveria ter falhado', 'red');
    return false;
  } catch (error) {
    log('ASSERT', '✅ Validação funcionou (rejeitou)', 'green');
    return true;
  }
}

// ============================================
// TEST 3: Advance Payment
// ============================================

async function testAdvancePayment() {
  log('TEST-3', '🧪 Advance Payment (sessões futuras)', 'cyan');
  
  const patient = await Patient.create({
    fullName: 'TEST_E2E_ADVANCE',
    dateOfBirth: new Date('1990-01-01'),
    phone: '11999999999'
  });
  
  const doctor = await Doctor.create({
    name: 'TEST_DOCTOR_ADV',
    specialty: 'Psicologia'
  });
  
  // Criar 2 sessões futuras
  const sessions = await Promise.all([
    Session.create({
      date: new Date('2026-04-15'),
      time: '10:00',
      sessionType: 'sessao_individual',
      patient: patient._id,
      doctor: doctor._id,
      status: 'scheduled',
      isPaid: true,
      isAdvance: true
    }),
    Session.create({
      date: new Date('2026-04-22'),
      time: '10:00',
      sessionType: 'sessao_individual',
      patient: patient._id,
      doctor: doctor._id,
      status: 'scheduled',
      isPaid: true,
      isAdvance: true
    })
  ]);
  
  // Criar pagamento com advance
  const payment = await Payment.create({
    patient: patient._id,
    doctor: doctor._id,
    serviceType: 'individual_session',
    amount: 500.00,
    paymentMethod: 'dinheiro',
    status: 'paid',
    isAdvance: true,
    coveredSessions: sessions.map(s => ({
      sessionId: s._id,
      used: false,
      scheduledDate: s.date
    }))
  });
  
  log('CREATE', `Advance Payment: ${payment._id}`, 'green');
  log('CREATE', `Sessões futuras: ${sessions.length}`, 'green');
  
  // Verificar
  const savedPayment = await Payment.findById(payment._id);
  
  await cleanup({ patient, doctor, payment, sessions });
  
  if (savedPayment?.coveredSessions?.length === 2) {
    log('ASSERT', '✅ Sessões vinculadas corretamente', 'green');
    return true;
  }
  
  log('ASSERT', '❌ Sessões não vinculadas', 'red');
  return false;
}

// ============================================
// HELPERS
// ============================================

async function cleanup(data) {
  const { patient, doctor, payment, session, sessions } = data;
  
  if (payment) await Payment.findByIdAndDelete(payment._id);
  if (patient) await Patient.findByIdAndDelete(patient._id);
  if (doctor) await Doctor.findByIdAndDelete(doctor._id);
  if (session) await Session.findByIdAndDelete(session._id);
  if (sessions) await Session.deleteMany({ _id: { $in: sessions.map(s => s._id) } });
  
  if (patient) {
    await PatientsView.deleteOne({ patientId: patient._id });
    await EventStore.deleteMany({ 'payload.patientId': patient._id.toString() });
  }
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log(`${colors.bold}${colors.cyan}`);
  console.log('═══════════════════════════════════════════');
  console.log('   🧪 TESTES E2E - PAYMENT V2');
  console.log('═══════════════════════════════════════════');
  console.log(`${colors.reset}\n`);
  
  // Conectar ao MongoDB
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica';
    await mongoose.connect(mongoUri);
    log('CONN', 'MongoDB conectado ✅', 'green');
  } catch (err) {
    log('ERROR', `Falha ao conectar MongoDB: ${err.message}`, 'red');
    process.exit(1);
  }
  
  console.log();
  
  const tests = [
    { name: 'Individual Session', fn: testIndividualSession },
    { name: 'Validação', fn: testValidation },
    { name: 'Advance Payment', fn: testAdvancePayment }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    try {
      const result = await test.fn();
      if (result) passed++;
      else failed++;
    } catch (err) {
      log('ERROR', `${test.name}: ${err.message}`, 'red');
      failed++;
    }
    console.log();
  }
  
  console.log(`${colors.bold}═══════════════════════════════════════════${colors.reset}`);
  log('RESULT', `${colors.green}${passed} passaram${colors.reset} | ${colors.red}${failed} falharam${colors.reset}`);
  console.log(`${colors.bold}═══════════════════════════════════════════${colors.reset}\n`);
  
  await mongoose.disconnect();
  log('CLEANUP', 'MongoDB desconectado', 'blue');
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${colors.red}💥 ERRO FATAL:${colors.reset}`, err.message);
  process.exit(1);
});
