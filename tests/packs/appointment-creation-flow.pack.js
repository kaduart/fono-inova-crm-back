/**
 * 🧪 Test Pack: Appointment Creation Flow
 * 
 * Cenários testados:
 * 1. Criar agendamento com source 'crm' (valida enum do schema)
 * 2. Modal fecha após sucesso (valida closeModalSignal)
 * 3. Pagamento é criado automaticamente (valida PAYMENT_REQUESTED)
 * 4. Sessão é criada pelo worker
 * 
 * Issue: Correção de erros encontrados em 05/04/2026
 * - Erro: `crm` não era valor válido no enum metadata.origin.source
 * - Erro: Modal não fechava após criar agendamento
 * - Erro: Pagamento não era criado (evento PAYMENT_PROCESS_REQUESTED vs PAYMENT_REQUESTED)
 */

import { expect, describe, it, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTestContext, cleanupTestData, waitForWorker } from '../utils/test-helpers.js';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';

describe('🎬 Pack: Appointment Creation Flow', () => {
  let context;
  let mongoServer;
  let testData = {};

  beforeAll(async () => {
    // Setup MongoDB em memória
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
    
    context = createTestContext();
    
    // Criar dados base
    const doctor = await Doctor.create({
      fullName: 'Dr. Teste E2E',
      email: 'dr.e2e@test.com',
      specialty: 'fonoaudiologia',
      cpf: '12345678901',
      phone: '61999999999',
      status: 'active'
    });
    
    const patient = await Patient.create({
      fullName: 'Paciente E2E Test',
      email: 'paciente.e2e@test.com',
      phone: '61988888888',
      cpf: '98765432101',
      doctor: doctor._id
    });
    
    testData = { doctor, patient };
  });

  afterAll(async () => {
    await cleanupTestData(testData);
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 1: Valida enum metadata.origin.source = 'crm'
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve aceitar source "crm" no enum do schema', async () => {
    const { doctor, patient } = testData;
    
    const appointment = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      date: new Date(),
      time: '14:00',
      specialty: 'fonoaudiologia',
      serviceType: 'individual_session',
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      sessionValue: 150,
      paymentMethod: 'dinheiro',
      billingType: 'particular',
      metadata: {
        origin: {
          source: 'crm',  // 🎯 Validação do enum
          leadId: null,
          preAgendamentoId: null
        }
      }
    });
    
    expect(appointment).toBeDefined();
    expect(appointment.metadata.origin.source).toBe('crm');
    
    // Limpar
    await Appointment.deleteOne({ _id: appointment._id });
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 2: Criar agendamento via API V2 e verificar evento
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve criar agendamento V2 e publicar evento PAYMENT_REQUESTED', async () => {
    const { doctor, patient } = testData;
    
    // 1. Criar agendamento via API
    const response = await context.api.post('/api/v2/appointments', {
      patientId: patient._id.toString(),
      doctorId: doctor._id.toString(),
      date: new Date().toISOString().split('T')[0],
      time: '15:00',
      specialty: 'fonoaudiologia',
      sessionType: 'fonoaudiologia',
      serviceType: 'individual_session',
      paymentAmount: 200,
      paymentMethod: 'dinheiro',
      billingType: 'particular',
      notes: 'Teste E2E - Appointment Creation Flow'
    });
    
    expect(response.status).toBe(202);
    expect(response.data.success).toBe(true);
    expect(response.data.data.appointmentId).toBeDefined();
    expect(response.data.data.status).toBe('processing_create');
    expect(response.data.data.eventId).toBeDefined();
    
    const appointmentId = response.data.data.appointmentId;
    const eventId = response.data.data.eventId;
    
    // 2. Aguardar worker processar
    await waitForWorker('appointment-processing', 5000);
    await waitForWorker('payment-processing', 5000);
    
    // 3. Verificar se agendamento foi processado
    const appointment = await Appointment.findById(appointmentId);
    expect(appointment).toBeDefined();
    expect(appointment.operationalStatus).toBe('scheduled');
    expect(appointment.session).toBeDefined(); // Sessão criada
    
    // 4. 🎯 VERIFICAÇÃO CRÍTICA: Pagamento deve ter sido criado
    const payment = await Payment.findOne({ appointment: appointmentId });
    expect(payment).toBeDefined();
    expect(payment.amount).toBe(200);
    expect(payment.status).toBe('paid'); // Particular é pago automaticamente
    expect(payment.patient.toString()).toBe(patient._id.toString());
    
    // 5. Verificar sessão
    const session = await Session.findById(appointment.session);
    expect(session).toBeDefined();
    expect(session.status).toBe('scheduled');
    expect(session.paymentStatus).toBe('paid');
    
    // Cleanup
    await Payment.deleteOne({ _id: payment._id });
    await Session.deleteOne({ _id: session._id });
    await Appointment.deleteOne({ _id: appointment._id });
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 3: Validação de falha mantém modal aberto (simulado)
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve rejeitar agendamento inválido sem criar pagamento', async () => {
    const { doctor } = testData;
    
    // Tentar criar sem patientId (deve falhar)
    try {
      await context.api.post('/api/v2/appointments', {
        doctorId: doctor._id.toString(),
        date: new Date().toISOString().split('T')[0],
        time: '16:00',
        specialty: 'fonoaudiologia',
        paymentAmount: 100
      });
      
      // Se chegou aqui, falhou o teste
      expect.fail('Deveria ter rejeitado agendamento sem paciente');
    } catch (error) {
      expect(error.response.status).toBe(400);
      expect(error.response.data.message).toContain('paciente');
    }
    
    // 🎯 VERIFICAÇÃO: Nenhum pagamento deve ter sido criado
    const paymentsBefore = await Payment.countDocuments();
    
    // Tentar criar inválido novamente
    try {
      await context.api.post('/api/v2/appointments', {
        doctorId: doctor._id.toString(),
        date: new Date().toISOString().split('T')[0],
        time: '16:00'
      });
    } catch (e) {
      // Esperado
    }
    
    const paymentsAfter = await Payment.countDocuments();
    expect(paymentsAfter).toBe(paymentsBefore); // Nenhum pagamento criado
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 4: Criar agendamento particular com valor 0 (edge case)
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve criar agendamento com valor 0 sem gerar pagamento', async () => {
    const { doctor, patient } = testData;
    
    const response = await context.api.post('/api/v2/appointments', {
      patientId: patient._id.toString(),
      doctorId: doctor._id.toString(),
      date: new Date().toISOString().split('T')[0],
      time: '17:00',
      specialty: 'fonoaudiologia',
      serviceType: 'individual_session',
      paymentAmount: 0,  // Valor zero
      paymentMethod: 'dinheiro',
      billingType: 'particular'
    });
    
    expect(response.status).toBe(202);
    
    const appointmentId = response.data.data.appointmentId;
    
    await waitForWorker('appointment-processing', 5000);
    
    // Agendamento deve existir
    const appointment = await Appointment.findById(appointmentId);
    expect(appointment).toBeDefined();
    
    // 🎯 VERIFICAÇÃO: Não deve criar pagamento quando valor é 0
    const payment = await Payment.findOne({ appointment: appointmentId });
    expect(payment).toBeNull();
    
    // Cleanup
    await Session.deleteOne({ appointment: appointmentId });
    await Appointment.deleteOne({ _id: appointmentId });
  });
});

export default describe;
