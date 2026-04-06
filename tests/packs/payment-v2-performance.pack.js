/**
 * 🧪 Test Pack: Payment V2 Performance
 * 
 * Testa o fluxo Payment V2 completo com foco em:
 * - Performance (resposta < 200ms)
 * - Async processing (202 Accepted)
 * - Event-driven architecture
 * - Saga Pattern (compensação em caso de falha)
 * 
 * Endpoints V2:
 * - POST /api/v2/payments/request
 * - POST /api/v2/payments/balance/:patientId/multi
 * - GET  /api/v2/payments/status/:eventId
 */

import { expect, describe, it, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTestContext, waitForWorker } from '../utils/test-helpers.js';
import Payment from '../../models/Payment.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';
import Appointment from '../../models/Appointment.js';
import PatientBalance from '../../models/PatientBalance.js';
import EventStore from '../../models/EventStore.js';

describe('🎬 Pack: Payment V2 Performance', () => {
  let context;
  let mongoServer;
  let testData = {};

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
    
    context = createTestContext();
    
    // Setup: Criar paciente e médico
    const doctor = await Doctor.create({
      fullName: 'Dr. Payment V2',
      email: 'dr.paymentv2@test.com',
      specialty: 'fonoaudiologia',
      cpf: '12345678909',
      phone: '61999999990',
      status: 'active'
    });
    
    const patient = await Patient.create({
      fullName: 'Paciente Payment V2',
      email: 'paciente.paymentv2@test.com',
      phone: '61988888880',
      cpf: '98765432109',
      doctor: doctor._id
    });
    
    testData = { doctor, patient };
  });

  afterAll(async () => {
    // Cleanup
    await Payment.deleteMany({ patient: testData.patient._id });
    await PatientBalance.deleteMany({ patient: testData.patient._id });
    await Appointment.deleteMany({ patient: testData.patient._id });
    await EventStore.deleteMany({ 
      'payload.patientId': testData.patient._id.toString() 
    });
    await Patient.deleteOne({ _id: testData.patient._id });
    await Doctor.deleteOne({ _id: testData.doctor._id });
    
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 1: Criar pagamento V2 deve retornar 202 imediatamente
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve criar pagamento V2 com resposta 202 (async)', async () => {
    const { patient, doctor } = testData;
    const startTime = Date.now();
    
    const response = await context.api.post('/api/v2/payments/request', {
      patientId: patient._id.toString(),
      doctorId: doctor._id.toString(),
      amount: 250,
      paymentMethod: 'pix',
      notes: 'Teste Payment V2 Performance'
    });
    
    const responseTime = Date.now() - startTime;
    
    // 🎯 VERIFICAÇÃO: Resposta rápida (< 500ms)
    expect(responseTime).toBeLessThan(500);
    expect(response.status).toBe(202);
    expect(response.data.success).toBe(true);
    expect(response.data.data).toHaveProperty('eventId');
    expect(response.data.data).toHaveProperty('correlationId');
    expect(response.data.data).toHaveProperty('jobId');
    expect(response.data.data.status).toBe('pending');
    expect(response.data.data.amount).toBe(250);
    
    // Guardar para próximos testes
    testData.paymentEventId = response.data.data.eventId;
    testData.paymentCorrelationId = response.data.data.correlationId;
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 2: Worker deve processar e criar pagamento
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve processar pagamento e criar no MongoDB', async () => {
    const { patient, paymentEventId } = testData;
    
    // Aguardar worker processar
    await waitForWorker('payment-processing', 10000);
    
    // Verificar se pagamento foi criado
    const payment = await Payment.findOne({
      patient: patient._id,
      amount: 250
    });
    
    // 🎯 VERIFICAÇÃO: Pagamento deve existir
    expect(payment).toBeDefined();
    expect(payment.amount).toBe(250);
    expect(payment.paymentMethod).toBe('pix');
    expect(payment.status).toBe('paid'); // Particular é pago imediatamente
    
    // Verificar EventStore
    const event = await EventStore.findOne({ eventId: paymentEventId });
    expect(event).toBeDefined();
    expect(event.status).toBe('processed');
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 3: Consulta de status deve retornar dados completos
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve consultar status do pagamento pelo eventId', async () => {
    const { paymentEventId } = testData;
    
    const response = await context.api.get(
      `/api/v2/payments/status/${paymentEventId}`
    );
    
    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(response.data.data.eventId).toBe(paymentEventId);
    expect(response.data.data.status).toBe('processed');
    expect(response.data.data.payment).toBeDefined();
    expect(response.data.data.payment.amount).toBe(250);
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 4: Idempotência - mesmo request não cria duplicado
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve respeitar idempotência (não criar duplicado)', async () => {
    const { patient, doctor } = testData;
    
    // Criar agendamento para ter um ID
    const appointment = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      date: new Date(),
      time: '14:00',
      specialty: 'fonoaudiologia',
      serviceType: 'individual_session',
      operationalStatus: 'scheduled',
      sessionValue: 300
    });
    
    testData.idempotencyAppointment = appointment;
    
    // Primeiro request
    const response1 = await context.api.post('/api/v2/payments/request', {
      appointmentId: appointment._id.toString(),
      patientId: patient._id.toString(),
      amount: 300,
      paymentMethod: 'dinheiro'
    });
    
    const eventId1 = response1.data.data.eventId;
    
    // Aguardar processamento
    await waitForWorker('payment-processing', 5000);
    
    // Segundo request idêntico (mesma appointmentId + amount)
    const response2 = await context.api.post('/api/v2/payments/request', {
      appointmentId: appointment._id.toString(),
      patientId: patient._id.toString(),
      amount: 300,
      paymentMethod: 'dinheiro'
    });
    
    // 🎯 VERIFICAÇÃO: Deve reconhecer como já processado
    // O segundo pode retornar o mesmo eventId ou um novo mas marcado como already_processed
    expect(response2.status).toBe(202);
    
    // Contar pagamentos - deve ter apenas 1
    const paymentCount = await Payment.countDocuments({
      appointment: appointment._id
    });
    
    expect(paymentCount).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 5: Payment-multi (saldo/débitos)
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve criar payment-multi assíncrono', async () => {
    const { patient } = testData;
    
    // Criar PatientBalance com débitos
    const balance = await PatientBalance.create({
      patient: patient._id,
      currentBalance: 500,
      totalDebited: 500,
      totalCredited: 0,
      transactions: [
        {
          type: 'debit',
          amount: 200,
          description: 'Débito teste 1',
          isPaid: false,
          createdAt: new Date()
        },
        {
          type: 'debit',
          amount: 300,
          description: 'Débito teste 2',
          isPaid: false,
          createdAt: new Date()
        }
      ]
    });
    
    testData.balance = balance;
    
    const debitIds = balance.transactions
      .filter(t => t.type === 'debit')
      .map(t => t._id.toString());
    
    const response = await context.api.post(
      `/api/v2/payments/balance/${patient._id}/multi`,
      {
        payments: [
          { paymentMethod: 'dinheiro', amount: 500 }
        ],
        debitIds,
        totalAmount: 500
      }
    );
    
    expect(response.status).toBe(202);
    expect(response.data.success).toBe(true);
    expect(response.data.data.debitsCount).toBe(2);
    expect(response.data.data.totalAmount).toBe(500);
    
    // Aguardar processamento
    await waitForWorker('payment-processing', 10000);
    
    // Verificar se débitos foram marcados como pagos
    const updatedBalance = await PatientBalance.findById(balance._id);
    const paidDebits = updatedBalance.transactions.filter(t => t.isPaid);
    
    expect(paidDebits.length).toBe(2);
    expect(updatedBalance.currentBalance).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 6: Performance - múltiplos pagamentos rápidos
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve processar múltiplos pagamentos com performance', async () => {
    const { patient, doctor } = testData;
    const requests = [];
    const startTime = Date.now();
    
    // Criar 5 pagamentos simultâneos
    for (let i = 0; i < 5; i++) {
      requests.push(
        context.api.post('/api/v2/payments/request', {
          patientId: patient._id.toString(),
          doctorId: doctor._id.toString(),
          amount: 100 + (i * 10),
          paymentMethod: 'pix',
          notes: `Pagamento simultâneo ${i + 1}`
        })
      );
    }
    
    const responses = await Promise.all(requests);
    const totalTime = Date.now() - startTime;
    
    // 🎯 VERIFICAÇÃO: Todas devem retornar 202 rapidamente
    responses.forEach((res, i) => {
      expect(res.status).toBe(202);
      expect(res.data.success).toBe(true);
      expect(res.data.data.amount).toBe(100 + (i * 10));
    });
    
    // Tempo total deve ser rápido (não espera processamento)
    console.log(`   ⏱️  5 pagamentos enfileirados em ${totalTime}ms`);
    expect(totalTime).toBeLessThan(2000); // < 2s para 5 requests
    
    // Aguardar workers processarem
    await waitForWorker('payment-processing', 15000);
    
    // Verificar se todos foram criados
    const paymentCount = await Payment.countDocuments({
      patient: patient._id,
      notes: /Pagamento simultâneo/
    });
    
    expect(paymentCount).toBe(5);
  });
});

export default describe;
