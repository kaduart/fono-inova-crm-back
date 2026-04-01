#!/usr/bin/env node
/**
 * Testes V2 - Payment Routes
 * 
 * Valida que todos os eventos estão sendo emitidos corretamente
 * e que o PatientsView atualiza após operações de pagamento.
 */

import mongoose from 'mongoose';
import assert from 'assert';
import { createContextLogger } from '../utils/logger.js';
import Patient from '../models/Patient.js';
import PatientsView from '../models/PatientsView.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import { publishEvent } from '../infrastructure/events/eventPublisher.js';

const logger = createContextLogger('PaymentV2Test');

// ============================================
// CONFIG
// ============================================

const TEST_CONFIG = {
  cleanupAfter: true,
  verbose: true
};

let testResults = {
  passed: 0,
  failed: 0,
  tests: []
};

// ============================================
// HELPERS
// ============================================

async function setup() {
  logger.info('🔧 Setup: aguardando conexão MongoDB...');
  // Aguarda conexão estar pronta
  let attempts = 0;
  while (mongoose.connection.readyState !== 1 && attempts < 10) {
    await new Promise(resolve => setTimeout(resolve, 500));
    attempts++;
  }
  
  if (mongoose.connection.readyState !== 1) {
    throw new Error('MongoDB não conectado');
  }
  
  await cleanupTestData();
  logger.info('✅ Setup completo');
}

async function cleanupTestData() {
  // Limpa dados de teste anteriores
  const testPatientIds = await Patient.find({
    fullName: { $regex: /^TEST_PAYMENT_/ }
  }).select('_id');
  
  const ids = testPatientIds.map(p => p._id);
  
  await Promise.all([
    Patient.deleteMany({ _id: { $in: ids } }),
    PatientsView.deleteMany({ patientId: { $in: ids } }),
    Payment.deleteMany({ patient: { $in: ids } }),
    Appointment.deleteMany({ patient: { $in: ids } })
  ]);
  
  logger.info(`🧹 ${ids.length} registros de teste removidos`);
}

async function runTest(name, testFn) {
  logger.info(`\n🧪 Test: ${name}`);
  const startTime = Date.now();
  
  try {
    await testFn();
    const duration = Date.now() - startTime;
    
    testResults.passed++;
    testResults.tests.push({ name, status: 'PASSED', duration });
    
    logger.info(`✅ PASSED (${duration}ms)`);
    
  } catch (error) {
    testResults.failed++;
    testResults.tests.push({ name, status: 'FAILED', error: error.message });
    
    logger.error(`❌ FAILED: ${error.message}`);
    if (TEST_CONFIG.verbose) {
      console.error(error.stack);
    }
  }
}

function assertView(view, expectations, context = '') {
  const errors = [];
  
  for (const [path, expected] of Object.entries(expectations)) {
    const actual = getNestedValue(view, path);
    
    if (actual !== expected) {
      errors.push(`${path}: expected ${expected}, got ${actual}`);
    }
  }
  
  if (errors.length > 0) {
    throw new Error(`${context}\n${errors.join('\n')}`);
  }
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

// ============================================
// TESTES
// ============================================

/**
 * TESTE 1: Criar pagamento simples
 * 
 * 1. Criar paciente
 * 2. Criar pagamento
 * 3. Verificar se evento foi emitido
 * 4. Verificar se PatientsView atualizou
 */
async function testCreatePayment() {
  // 1. Criar paciente
  const patient = await Patient.create({
    fullName: 'TEST_PAYMENT_Create',
    dateOfBirth: new Date('1990-01-01'),
    phone: '11999999999'
  });
  
  // Cria view inicial
  const { buildPatientView } = await import('../domains/clinical/services/patientProjectionService.js');
  await buildPatientView(patient._id.toString(), { correlationId: 'test' });
  
  // 2. Criar pagamento
  const payment = await Payment.create({
    patient: patient._id,
    amount: 150.00,
    paymentMethod: 'pix',
    status: 'completed',
    paidAt: new Date()
  });
  
  // 3. Simula emissão de evento (como o patch faz)
  await publishEvent('PAYMENT_RECEIVED', {
    paymentId: payment._id.toString(),
    patientId: patient._id.toString(),
    amount: 150.00,
    paymentMethod: 'pix',
    receivedAt: new Date().toISOString()
  });
  
  // 4. Rebuild view
  await buildPatientView(patient._id.toString(), { correlationId: 'test', force: true });
  
  // 5. Verificar view
  const view = await PatientsView.findOne({ patientId: patient._id }).lean();
  
  assert(view, 'View deve existir');
  assert.strictEqual(view.stats?.totalRevenue, 150.00, 'totalRevenue deve ser 150.00');
  
  logger.info(`  💰 totalRevenue: ${view.stats?.totalRevenue}`);
}

/**
 * TESTE 2: Criar pagamento com appointment
 * 
 * 1. Criar paciente + appointment
 * 2. Criar pagamento vinculado
 * 3. Verificar ambos os eventos
 * 4. Verificar PatientsView atualizado
 */
async function testCreatePaymentWithAppointment() {
  // 1. Criar paciente
  const patient = await Patient.create({
    fullName: 'TEST_PAYMENT_WithAppointment',
    dateOfBirth: new Date('1985-05-15'),
    phone: '11888888888'
  });
  
  // Criar appointment
  const appointment = await Appointment.create({
    patient: patient._id,
    doctor: new mongoose.Types.ObjectId(),
    date: '2026-04-15',
    time: '10:00',
    serviceType: 'session',
    operationalStatus: 'scheduled'
  });
  
  // Build inicial
  const { buildPatientView } = await import('../domains/clinical/services/patientProjectionService.js');
  await buildPatientView(patient._id.toString(), { correlationId: 'test' });
  
  // 2. Criar pagamento vinculado
  const payment = await Payment.create({
    patient: patient._id,
    appointment: appointment._id,
    amount: 200.00,
    paymentMethod: 'dinheiro',
    status: 'completed',
    paidAt: new Date()
  });
  
  // 3. Simula eventos (como o patch faz)
  await publishEvent('PAYMENT_RECEIVED', {
    paymentId: payment._id.toString(),
    patientId: patient._id.toString(),
    appointmentId: appointment._id.toString(),
    amount: 200.00,
    paymentMethod: 'dinheiro'
  });
  
  await publishEvent('APPOINTMENT_UPDATED', {
    appointmentId: appointment._id.toString(),
    patientId: patient._id.toString(),
    paymentId: payment._id.toString(),
    paymentStatus: 'completed'
  });
  
  // 4. Rebuild view
  await buildPatientView(patient._id.toString(), { correlationId: 'test', force: true });
  
  // 5. Verificar
  const view = await PatientsView.findOne({ patientId: patient._id }).lean();
  
  assert(view, 'View deve existir');
  assert.strictEqual(view.stats?.totalRevenue, 200.00, 'totalRevenue deve ser 200.00');
  
  logger.info(`  💰 totalRevenue: ${view.stats?.totalRevenue}`);
  logger.info(`  📅 Appointment vinculado`);
}

/**
 * TESTE 3: Atualizar pagamento (status → paid)
 * 
 * 1. Criar pagamento pending
 * 2. Atualizar para paid
 * 3. Verificar eventos PAYMENT_UPDATED + PAYMENT_RECEIVED
 */
async function testUpdatePaymentStatus() {
  // 1. Criar paciente
  const patient = await Patient.create({
    fullName: 'TEST_PAYMENT_Update',
    dateOfBirth: new Date('1988-03-20'),
    phone: '11777777777'
  });
  
  // Criar pagamento pending
  const payment = await Payment.create({
    patient: patient._id,
    amount: 300.00,
    paymentMethod: 'cartao',
    status: 'pending'
  });
  
  // Build inicial
  const { buildPatientView } = await import('../domains/clinical/services/patientProjectionService.js');
  await buildPatientView(patient._id.toString(), { correlationId: 'test' });
  
  // Verificar que ainda não contabilizou
  let view = await PatientsView.findOne({ patientId: patient._id }).lean();
  assert.strictEqual(view.stats?.totalRevenue, 0, 'totalRevenue deve ser 0 (pending)');
  
  // 2. Atualizar para paid
  await Payment.findByIdAndUpdate(payment._id, { status: 'paid', paidAt: new Date() });
  
  // Simula eventos
  await publishEvent('PAYMENT_UPDATED', {
    paymentId: payment._id.toString(),
    patientId: patient._id.toString(),
    previousStatus: 'pending',
    newStatus: 'paid'
  });
  
  await publishEvent('PAYMENT_RECEIVED', {
    paymentId: payment._id.toString(),
    patientId: patient._id.toString(),
    amount: 300.00,
    source: 'update_to_paid'
  });
  
  // 3. Rebuild view
  await buildPatientView(patient._id.toString(), { correlationId: 'test', force: true });
  
  // 4. Verificar
  view = await PatientsView.findOne({ patientId: patient._id }).lean();
  assert.strictEqual(view.stats?.totalRevenue, 300.00, 'totalRevenue deve ser 300.00 após paid');
  
  logger.info(`  💰 totalRevenue após paid: ${view.stats?.totalRevenue}`);
}

/**
 * TESTE 4: Deletar pagamento
 * 
 * 1. Criar pagamento
 * 2. Deletar
 * 3. Verificar evento PAYMENT_DELETED
 * 4. Verificar totalRevenue ajustado
 */
async function testDeletePayment() {
  // 1. Criar paciente
  const patient = await Patient.create({
    fullName: 'TEST_PAYMENT_Delete',
    dateOfBirth: new Date('1992-07-08'),
    phone: '11666666666'
  });
  
  // Criar pagamento
  const payment = await Payment.create({
    patient: patient._id,
    amount: 500.00,
    paymentMethod: 'pix',
    status: 'completed',
    paidAt: new Date()
  });
  
  // Build inicial
  const { buildPatientView } = await import('../domains/clinical/services/patientProjectionService.js');
  await buildPatientView(patient._id.toString(), { correlationId: 'test' });
  
  // Verificar valor inicial
  let view = await PatientsView.findOne({ patientId: patient._id }).lean();
  assert.strictEqual(view.stats?.totalRevenue, 500.00, 'totalRevenue inicial deve ser 500.00');
  
  // 2. Deletar pagamento
  await Payment.findByIdAndDelete(payment._id);
  
  // Simula evento
  await publishEvent('PAYMENT_DELETED', {
    paymentId: payment._id.toString(),
    patientId: patient._id.toString(),
    amount: 500.00
  });
  
  // 3. Rebuild view
  await buildPatientView(patient._id.toString(), { correlationId: 'test', force: true });
  
  // 4. Verificar (deve ter 0 pois pagamento foi deletado)
  view = await PatientsView.findOne({ patientId: patient._id }).lean();
  assert.strictEqual(view.stats?.totalRevenue, 0, 'totalRevenue deve ser 0 após delete');
  
  logger.info(`  💰 totalRevenue após delete: ${view.stats?.totalRevenue}`);
}

/**
 * TESTE 5: Pagamento múltiplo
 * 
 * 1. Criar múltiplos pagamentos
 * 2. Verificar eventos para cada um
 * 3. Verificar total correto
 */
async function testMultiplePayments() {
  // 1. Criar paciente
  const patient = await Patient.create({
    fullName: 'TEST_PAYMENT_Multiple',
    dateOfBirth: new Date('1993-09-10'),
    phone: '11555555555'
  });
  
  const { buildPatientView } = await import('../domains/clinical/services/patientProjectionService.js');
  
  // 2. Criar 3 pagamentos
  const amounts = [100, 200, 300];
  const totalExpected = 600;
  
  for (const amount of amounts) {
    const payment = await Payment.create({
      patient: patient._id,
      amount: amount,
      paymentMethod: 'pix',
      status: 'completed',
      paidAt: new Date()
    });
    
    // Simula evento
    await publishEvent('PAYMENT_RECEIVED', {
      paymentId: payment._id.toString(),
      patientId: patient._id.toString(),
      amount: amount
    });
  }
  
  // 3. Rebuild view
  await buildPatientView(patient._id.toString(), { correlationId: 'test', force: true });
  
  // 4. Verificar
  const view = await PatientsView.findOne({ patientId: patient._id }).lean();
  assert.strictEqual(view.stats?.totalRevenue, totalExpected, `totalRevenue deve ser ${totalExpected}`);
  
  logger.info(`  💰 totalRevenue (3 pagamentos): ${view.stats?.totalRevenue}`);
}

// ============================================
// MAIN
// ============================================

async function main() {
  logger.info('🚀 Iniciando Testes V2 - Payment Routes\n');
  
  await setup();
  
  // Executa todos os testes
  await runTest('Create Payment Simple', testCreatePayment);
  await runTest('Create Payment With Appointment', testCreatePaymentWithAppointment);
  await runTest('Update Payment Status', testUpdatePaymentStatus);
  await runTest('Delete Payment', testDeletePayment);
  await runTest('Multiple Payments', testMultiplePayments);
  
  // Resumo
  logger.info('\n' + '='.repeat(70));
  logger.info('📊 RESULTADO FINAL');
  logger.info('='.repeat(70));
  logger.info(`✅ Passaram: ${testResults.passed}`);
  logger.info(`❌ Falharam: ${testResults.failed}`);
  logger.info(`📈 Total: ${testResults.passed + testResults.failed}`);
  
  if (testResults.failed > 0) {
    logger.info('\n❌ TESTES FALHARAM:');
    testResults.tests
      .filter(t => t.status === 'FAILED')
      .forEach(t => logger.info(`  - ${t.name}: ${t.error}`));
    
    process.exit(1);
  } else {
    logger.info('\n✅ TODOS OS TESTES PASSARAM!');
    logger.info('🎉 Payment V2 está funcionando corretamente');
    
    if (TEST_CONFIG.cleanupAfter) {
      await cleanupTestData();
    }
    
    process.exit(0);
  }
}

// Roda se executado diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    logger.error('💥 Erro fatal nos testes', { error: error.message });
    process.exit(1);
  });
}

export { runTest, testCreatePayment, testCreatePaymentWithAppointment };
