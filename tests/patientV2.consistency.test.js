#!/usr/bin/env node
/**
 * Teste de Consistência - Patients V2
 * 
 * Valida que o PatientsView está sempre correto após eventos.
 * Cenários reais de produção simulados.
 */

import mongoose from 'mongoose';
import assert from 'assert';
import { createContextLogger } from '../utils/logger.js';
import Patient from '../models/Patient.js';
import PatientsView from '../models/PatientsView.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import { buildPatientView } from '../domains/clinical/services/patientProjectionService.js';
import { patientProjectionWorker } from '../domains/clinical/workers/patientProjectionWorker.js';

const logger = createContextLogger('ConsistencyTest');

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
  logger.info('🔧 Setup: conectando ao MongoDB...');
  // Assume que já está conectado (rodar em ambiente de teste)
  
  // Limpa dados de teste anteriores
  await cleanup();
  
  logger.info('✅ Setup completo');
}

async function cleanup() {
  const testPatientIds = await Patient.find({
    fullName: { $regex: /^TEST_/ }
  }).select('_id');
  
  const ids = testPatientIds.map(p => p._id);
  
  await Promise.all([
    Patient.deleteMany({ _id: { $in: ids } }),
    PatientsView.deleteMany({ patientId: { $in: ids } }),
    Appointment.deleteMany({ patient: { $in: ids } }),
    Payment.deleteMany({ patient: { $in: ids } })
  ]);
  
  logger.info(`🧹 Cleanup: ${ids.length} registros de teste removidos`);
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
 * TESTE 1: Cenário Completo de Vida do Paciente
 * 
 * 1. Criar paciente
 * 2. Criar 3 appointments
 * 3. Completar 1 appointment
 * 4. Criar pagamento
 * 5. Verificar view
 */
async function testPatientLifecycle() {
  // 1. Cria paciente
  const patient = await Patient.create({
    fullName: 'TEST_Lifecycle Patient',
    dateOfBirth: new Date('1990-01-01'),
    phone: '11999999999',
    email: 'test.lifecycle@example.com'
  });
  
  // Simula evento PATIENT_CREATED
  await patientProjectionWorker.processJob({
    data: {
      eventType: 'PATIENT_CREATED',
      payload: { patientId: patient._id.toString() },
      correlationId: 'test-lifecycle-1'
    }
  });
  
  // 2. Cria 3 appointments
  const appointments = await Promise.all([
    Appointment.create({
      patient: patient._id,
      doctor: new mongoose.Types.ObjectId(),
      date: '2026-04-01',
      time: '10:00',
      serviceType: 'evaluation',
      operationalStatus: 'scheduled',
      paymentStatus: 'pending'
    }),
    Appointment.create({
      patient: patient._id,
      doctor: new mongoose.Types.ObjectId(),
      date: '2026-04-05',
      time: '14:00',
      serviceType: 'session',
      operationalStatus: 'scheduled',
      paymentStatus: 'pending'
    }),
    Appointment.create({
      patient: patient._id,
      doctor: new mongoose.Types.ObjectId(),
      date: '2026-03-28', // passado
      time: '09:00',
      serviceType: 'session',
      operationalStatus: 'scheduled',
      paymentStatus: 'pending'
    })
  ]);
  
  // Simula eventos APPOINTMENT_SCHEDULED
  for (const apt of appointments) {
    await patientProjectionWorker.processJob({
      data: {
        eventType: 'APPOINTMENT_SCHEDULED',
        payload: { patientId: patient._id.toString(), appointmentId: apt._id.toString() },
        correlationId: 'test-lifecycle-2'
      }
    });
  }
  
  // 3. Completar 1 appointment
  await Appointment.findByIdAndUpdate(appointments[2]._id, {
    operationalStatus: 'completed',
    clinicalStatus: 'completed'
  });
  
  await patientProjectionWorker.processJob({
    data: {
      eventType: 'APPOINTMENT_COMPLETED',
      payload: { patientId: patient._id.toString(), appointmentId: appointments[2]._id.toString() },
      correlationId: 'test-lifecycle-3'
    }
  });
  
  // 4. Criar pagamento
  await Payment.create({
    patient: patient._id,
    appointment: appointments[2]._id,
    amount: 150.00,
    status: 'completed',
    paymentMethod: 'pix',
    paidAt: new Date()
  });
  
  await patientProjectionWorker.processJob({
    data: {
      eventType: 'PAYMENT_COMPLETED',
      payload: { patientId: patient._id.toString(), amount: 150.00 },
      correlationId: 'test-lifecycle-4'
    }
  });
  
  // 5. Verifica view
  const view = await PatientsView.findOne({ patientId: patient._id }).lean();
  
  assert(view, 'View deve existir');
  
  assertView(view, {
    'stats.totalAppointments': 3,
    'stats.totalCompleted': 1,
    'stats.totalRevenue': 150.00,
    'fullName': 'TEST_Lifecycle Patient'
  }, 'Após ciclo completo');
  
  // Verifica last/next appointment
  assert(view.lastAppointment, 'Deve ter lastAppointment');
  assert.strictEqual(view.lastAppointment.date, '2026-03-28', 'Last deve ser o passado');
  
  assert(view.nextAppointment, 'Deve ter nextAppointment');
  assert.strictEqual(view.nextAppointment.date, '2026-04-01', 'Next deve ser o mais próximo futuro');
}

/**
 * TESTE 2: Ordem de Eventos (CRÍTICO)
 * 
 * Eventos chegam fora de ordem:
 * 1. PAYMENT_RECEIVED (antes do appointment existir)
 * 2. APPOINTMENT_COMPLETED (depois)
 * 
 * Resultado deve ser consistente.
 */
async function testEventOrderResilience() {
  const patient = await Patient.create({
    fullName: 'TEST_Order Patient',
    dateOfBirth: new Date('1985-05-15'),
    phone: '11888888888'
  });
  
  const patientId = patient._id.toString();
  
  // Cria appointment primeiro (mas não processa evento ainda)
  const appointment = await Appointment.create({
    patient: patient._id,
    doctor: new mongoose.Types.ObjectId(),
    date: '2026-04-10',
    time: '15:00',
    serviceType: 'session',
    operationalStatus: 'completed', // já completo
    paymentStatus: 'completed'
  });
  
  // Cria pagamento
  await Payment.create({
    patient: patient._id,
    appointment: appointment._id,
    amount: 200.00,
    status: 'completed',
    paymentMethod: 'dinheiro'
  });
  
  // 🔥 Processa PAYMENT ANTES do APPOINTMENT (ordem errada)
  await patientProjectionWorker.processJob({
    data: {
      eventType: 'PAYMENT_COMPLETED',
      payload: { patientId, amount: 200.00 },
      correlationId: 'test-order-1'
    }
  });
  
  // Depois processa APPOINTMENT
  await patientProjectionWorker.processJob({
    data: {
      eventType: 'APPOINTMENT_COMPLETED',
      payload: { patientId, appointmentId: appointment._id.toString() },
      correlationId: 'test-order-2'
    }
  });
  
  // Verifica - deve estar correto mesmo com ordem errada
  const view = await PatientsView.findOne({ patientId: patient._id }).lean();
  
  assert(view, 'View deve existir');
  assertView(view, {
    'stats.totalAppointments': 1,
    'stats.totalCompleted': 1,
    'stats.totalRevenue': 200.00
  }, 'Mesmo com ordem errada');
}

/**
 * TESTE 3: Idempotência (CRÍTICO)
 * 
 * Mesmo evento processado 2x não deve duplicar dados.
 */
async function testIdempotency() {
  const patient = await Patient.create({
    fullName: 'TEST_Idempotency Patient',
    dateOfBirth: new Date('1995-12-25'),
    phone: '11777777777'
  });
  
  const patientId = patient._id.toString();
  
  // Processa PATIENT_CREATED 2x
  for (let i = 0; i < 2; i++) {
    await patientProjectionWorker.processJob({
      data: {
        eventType: 'PATIENT_CREATED',
        payload: { patientId },
        correlationId: `test-idem-${i}`
      }
    });
  }
  
  // Cria 1 appointment
  const appointment = await Appointment.create({
    patient: patient._id,
    doctor: new mongoose.Types.ObjectId(),
    date: '2026-04-15',
    time: '10:00',
    serviceType: 'session',
    operationalStatus: 'completed'
  });
  
  // Processa APPOINTMENT_COMPLETED 3x
  for (let i = 0; i < 3; i++) {
    await patientProjectionWorker.processJob({
      data: {
        eventType: 'APPOINTMENT_COMPLETED',
        payload: { patientId, appointmentId: appointment._id.toString() },
        correlationId: `test-idem-apt-${i}`
      }
    });
  }
  
  const view = await PatientsView.findOne({ patientId: patient._id }).lean();
  
  assert(view, 'View deve existir');
  assertView(view, {
    'stats.totalAppointments': 1,
    'stats.totalCompleted': 1
  }, 'Não deve duplicar apesar de múltiplos eventos');
  
  // Verifica que só tem 1 versão (não criou múltiplas views)
  const viewCount = await PatientsView.countDocuments({ patientId: patient._id });
  assert.strictEqual(viewCount, 1, 'Deve ter exatamente 1 view');
}

/**
 * TESTE 4: Staleness Detection
 * 
 * View fica stale após threshold.
 */
async function testStaleness() {
  const patient = await Patient.create({
    fullName: 'TEST_Stale Patient',
    dateOfBirth: new Date('1988-03-20'),
    phone: '11666666666'
  });
  
  // Build inicial
  await buildPatientView(patient._id.toString(), { correlationId: 'test-stale-1' });
  
  // Manipula data para simular view antiga
  await PatientsView.findOneAndUpdate(
    { patientId: patient._id },
    { 
      'snapshot.calculatedAt': new Date(Date.now() - 10 * 60 * 1000), // 10 min atrás
      'snapshot.isStale': false
    }
  );
  
  // Busca view
  const view = await PatientsView.getFullView(patient._id.toString());
  
  assert(view.snapshot.isStale, 'View deve estar marcada como stale');
}

/**
 * TESTE 5: Fallback Inteligente
 * 
 * Se view não existe, deve criar on-the-fly.
 */
async function testFallback() {
  const patient = await Patient.create({
    fullName: 'TEST_Fallback Patient',
    dateOfBirth: new Date('1992-07-08'),
    phone: '11555555555'
  });
  
  // Cria appointment SEM processar evento (view não existe)
  await Appointment.create({
    patient: patient._id,
    doctor: new mongoose.Types.ObjectId(),
    date: '2026-04-20',
    time: '14:00',
    serviceType: 'evaluation',
    operationalStatus: 'scheduled'
  });
  
  // Busca view (deve criar automaticamente)
  const view = await buildPatientView(patient._id.toString(), { 
    correlationId: 'test-fallback' 
  });
  
  assert(view, 'View deve ser criada via fallback');
  assert.strictEqual(view.stats.totalAppointments, 1, 'Deve ter 1 appointment');
}

/**
 * TESTE 6: Deleção em Cascata
 * 
 * Ao deletar paciente, view deve ser removida.
 */
async function testDeletion() {
  const patient = await Patient.create({
    fullName: 'TEST_Delete Patient',
    dateOfBirth: new Date('1993-09-10'),
    phone: '11444444444'
  });
  
  const patientId = patient._id.toString();
  
  // Cria view
  await buildPatientView(patientId, { correlationId: 'test-delete-1' });
  
  // Verifica que existe
  let view = await PatientsView.findOne({ patientId: patient._id });
  assert(view, 'View deve existir antes da deleção');
  
  // Processa deleção
  await patientProjectionWorker.processJob({
    data: {
      eventType: 'PATIENT_DELETED',
      payload: { patientId },
      correlationId: 'test-delete-2'
    }
  });
  
  // Verifica que foi removida
  view = await PatientsView.findOne({ patientId: patient._id });
  assert(!view, 'View deve ser removida após deleção');
  
  // Limpa paciente também (senão fica orphan)
  await Patient.findByIdAndDelete(patient._id);
}

// ============================================
// MAIN
// ============================================

async function main() {
  logger.info('🚀 Iniciando Testes de Consistência - Patients V2\n');
  
  await setup();
  
  // Executa todos os testes
  await runTest('Patient Lifecycle', testPatientLifecycle);
  await runTest('Event Order Resilience', testEventOrderResilience);
  await runTest('Idempotency', testIdempotency);
  await runTest('Staleness Detection', testStaleness);
  await runTest('Fallback Creation', testFallback);
  await runTest('Deletion Cascade', testDeletion);
  
  // Resumo
  logger.info('\n' + '='.repeat(50));
  logger.info('📊 RESULTADO FINAL');
  logger.info('='.repeat(50));
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
    logger.info('🎉 Patients V2 está consistente e pronto para produção');
    
    if (TEST_CONFIG.cleanupAfter) {
      await cleanup();
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

export { runTest, testPatientLifecycle, testEventOrderResilience, testIdempotency };
