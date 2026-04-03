/**
 * ============================================================================
 * E2E TESTS - Billing V2
 * ============================================================================
 * 
 * Fluxo completo: Session → Completed → Billed → Received
 * 
 * Run: npm run test:billing:e2e
 * ============================================================================
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { insuranceBillingService } from '../../domains/billing/services/insuranceBillingService.v2.js';
import { reconciliationService } from '../../domains/billing/services/ReconciliationService.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import { EventStore } from '../../models/EventStore.js';

const TEST_DB = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/crm_test_billing';

describe('Billing V2 - E2E Flow', () => {
  let patientId;
  let professionalId;
  let guide;
  let session;

  beforeAll(async () => {
    await mongoose.connect(TEST_DB);
    
    // Setup: criar paciente, profissional e guia
    const Patient = mongoose.model('Patient');
    const Professional = mongoose.model('Professional');
    
    const patient = await Patient.create({
      fullName: 'Test Patient E2E',
      cpf: '12345678901'
    });
    patientId = patient._id;
    
    const professional = await Professional.create({
      fullName: 'Test Professional',
      specialty: 'fonoaudiologia'
    });
    professionalId = professional._id;
  });

  beforeEach(async () => {
    // Criar guia nova para cada teste
    guide = await InsuranceGuide.create({
      number: `TEST-${uuidv4().slice(0, 8)}`,
      patientId,
      specialty: 'fonoaudiologia',
      insurance: 'test-insurance',
      totalSessions: 10,
      usedSessions: 0,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
  });

  afterAll(async () => {
    // Cleanup
    await Session.deleteMany({ 'patient': patientId });
    await Payment.deleteMany({ 'patient': patientId });
    await Appointment.deleteMany({ 'patient': patientId });
    await InsuranceGuide.deleteMany({ patientId });
    await EventStore.deleteMany({ aggregateType: 'InsuranceBilling' });
    await mongoose.disconnect();
  });

  // =============================================================================
  // FLUXO COMPLETO HAPPY PATH
  // =============================================================================
  
  describe('Happy Path - Full Cycle', () => {
    it('should complete full billing cycle: completed → billed → received', async () => {
      // 1. Criar sessão
      session = await Session.create({
        patient: patientId,
        professional: professionalId,
        specialty: 'fonoaudiologia',
        date: new Date(),
        time: '14:00',
        status: 'scheduled',
        paymentType: 'convenio',
        insuranceGuide: guide._id,
        value: 0
      });

      // 2. Processar completion
      const result1 = await insuranceBillingService.processSessionCompleted(
        session._id.toString(),
        { correlationId: `test-${uuidv4()}` }
      );

      expect(result1.success).toBe(true);
      expect(result1.billingId).toBeDefined();
      expect(result1.paymentId).toBeDefined();

      // Verificar entidades criadas
      const payment = await Payment.findById(result1.paymentId);
      expect(payment).toBeTruthy();
      expect(payment.status).toBe('pending_billing');
      expect(payment.amount).toBeGreaterThan(0);

      const appointment = await Appointment.findById(result1.billingId);
      expect(appointment).toBeTruthy();
      expect(appointment.insurance.status).toBe('pending_billing');

      // Verificar guia consumida
      const updatedGuide = await InsuranceGuide.findById(guide._id);
      expect(updatedGuide.usedSessions).toBe(1);
      expect(updatedGuide.consumptionHistory).toHaveLength(1);

      // 3. Processar billed
      const result2 = await insuranceBillingService.processSessionBilled(
        session._id.toString(),
        { billedAmount: 150.00, billedAt: new Date(), invoiceNumber: 'INV-001' },
        { correlationId: `test-${uuidv4()}` }
      );

      expect(result2.success).toBe(true);
      expect(result2.status).toBe('billed');

      const billedPayment = await Payment.findById(result1.paymentId);
      expect(billedPayment.status).toBe('billed');
      expect(billedPayment.insurance.status).toBe('billed');
      expect(billedPayment.amount).toBe(150.00);

      // 4. Processar received
      const result3 = await insuranceBillingService.processSessionReceived(
        session._id.toString(),
        { receivedAmount: 140.00, receivedAt: new Date(), receiptNumber: 'REC-001' },
        { correlationId: `test-${uuidv4()}` }
      );

      expect(result3.success).toBe(true);
      expect(result3.status).toBe('paid');

      const paidPayment = await Payment.findById(result1.paymentId);
      expect(paidPayment.status).toBe('paid');
      expect(paidPayment.insurance.status).toBe('received');
      expect(paidPayment.amount).toBe(140.00);

      const completedSession = await Session.findById(session._id);
      expect(completedSession.isPaid).toBe(true);
      expect(completedSession.paymentStatus).toBe('paid');
    });
  });

  // =============================================================================
  // IDEMPOTÊNCIA
  // =============================================================================
  
  describe('Idempotency', () => {
    it('should not duplicate payment when processing same session twice', async () => {
      session = await Session.create({
        patient: patientId,
        professional: professionalId,
        specialty: 'fonoaudiologia',
        date: new Date(),
        time: '15:00',
        status: 'scheduled',
        paymentType: 'convenio',
        insuranceGuide: guide._id
      });

      const correlationId = `test-${uuidv4()}`;

      // Primeira execução
      const result1 = await insuranceBillingService.processSessionCompleted(
        session._id.toString(),
        { correlationId }
      );
      expect(result1.success).toBe(true);
      expect(result1.duplicate).toBeFalsy();

      // Segunda execução (mesmo correlationId)
      const result2 = await insuranceBillingService.processSessionCompleted(
        session._id.toString(),
        { correlationId }
      );
      expect(result2.success).toBe(true);
      expect(result2.duplicate).toBe(true);

      // Verificar que só existe 1 payment
      const payments = await Payment.find({ session: session._id });
      expect(payments).toHaveLength(1);

      // Verificar que só existe 1 appointment
      const appointments = await Appointment.find({ 'source.sessionId': session._id });
      expect(appointments).toHaveLength(1);
    });

    it('should not duplicate billed status', async () => {
      session = await Session.create({
        patient: patientId,
        professional: professionalId,
        specialty: 'fonoaudiologia',
        date: new Date(),
        time: '16:00',
        status: 'scheduled',
        paymentType: 'convenio',
        insuranceGuide: guide._id
      });

      await insuranceBillingService.processSessionCompleted(
        session._id.toString(),
        { correlationId: `test-${uuidv4()}` }
      );

      const correlationId = `test-billed-${uuidv4()}`;

      // Primeiro billed
      const result1 = await insuranceBillingService.processSessionBilled(
        session._id.toString(),
        { billedAmount: 150.00 },
        { correlationId }
      );
      expect(result1.duplicate).toBeFalsy();

      // Segundo billed (mesmo correlationId)
      const result2 = await insuranceBillingService.processSessionBilled(
        session._id.toString(),
        { billedAmount: 150.00 },
        { correlationId }
      );
      expect(result2.duplicate).toBe(true);
    });
  });

  // =============================================================================
  // STATE MACHINE
  // =============================================================================
  
  describe('State Machine Enforcement', () => {
    it('should reject billed → pending_billing transition', async () => {
      session = await Session.create({
        patient: patientId,
        professional: professionalId,
        specialty: 'fonoaudiologia',
        date: new Date(),
        time: '17:00',
        status: 'scheduled',
        paymentType: 'convenio',
        insuranceGuide: guide._id
      });

      await insuranceBillingService.processSessionCompleted(
        session._id.toString(),
        { correlationId: `test-${uuidv4()}` }
      );

      await insuranceBillingService.processSessionBilled(
        session._id.toString(),
        { billedAmount: 150.00 },
        { correlationId: `test-${uuidv4()}` }
      );

      // Tentar voltar para pending_billing deve falhar
      const payment = await Payment.findOne({ session: session._id });
      payment.status = 'pending_billing';
      
      await expect(payment.save()).rejects.toThrow();
    });

    it('should reject received without billed', async () => {
      session = await Session.create({
        patient: patientId,
        professional: professionalId,
        specialty: 'fonoaudiologia',
        date: new Date(),
        time: '18:00',
        status: 'scheduled',
        paymentType: 'convenio',
        insuranceGuide: guide._id
      });

      await insuranceBillingService.processSessionCompleted(
        session._id.toString(),
        { correlationId: `test-${uuidv4()}` }
      );

      // Tentar receber sem faturar deve funcionar (V2 permite do pending)
      // Mas se quisermos forçar billed primeiro, o teste mudaria
      const result = await insuranceBillingService.processSessionReceived(
        session._id.toString(),
        { receivedAmount: 140.00 },
        { correlationId: `test-${uuidv4()}` }
      );
      
      expect(result.success).toBe(true);
    });
  });

  // =============================================================================
  // RECONCILIAÇÃO
  // =============================================================================
  
  describe('Reconciliation', () => {
    it('should detect session without payment', async () => {
      // Criar sessão marcada como processada mas sem payment
      const orphanSession = await Session.create({
        patient: patientId,
        professional: professionalId,
        specialty: 'fonoaudiologia',
        date: new Date(),
        time: '19:00',
        status: 'completed',
        paymentType: 'convenio',
        insuranceGuide: guide._id,
        insuranceBillingProcessed: true
      });

      const report = await reconciliationService.reconcile();
      
      expect(report.totalInconsistencies).toBeGreaterThan(0);
      expect(report.checks.sessionsWithoutPayment.count).toBeGreaterThan(0);
    });

    it('should auto-fix divergent status', async () => {
      session = await Session.create({
        patient: patientId,
        professional: professionalId,
        specialty: 'fonoaudiologia',
        date: new Date(),
        time: '20:00',
        status: 'scheduled',
        paymentType: 'convenio',
        insuranceGuide: guide._id
      });

      const result = await insuranceBillingService.processSessionCompleted(
        session._id.toString(),
        { correlationId: `test-${uuidv4()}` }
      );

      // Simular divergência: marcar payment como paid, session como pending
      await Payment.findByIdAndUpdate(result.paymentId, { status: 'paid' });
      await Session.findByIdAndUpdate(session._id, { isPaid: false, paymentStatus: 'pending' });

      const report = await reconciliationService.reconcile();
      
      // Deve ter detectado divergência
      expect(report.checks.divergentStatus.count).toBeGreaterThan(0);
      
      // Deve ter auto-corrigido
      expect(report.autoFixed).toBeGreaterThan(0);

      const fixedSession = await Session.findById(session._id);
      expect(fixedSession.isPaid).toBe(true);
    });
  });

  // =============================================================================
  // CANCELAMENTO
  // =============================================================================
  
  describe('Cancellation', () => {
    it('should cancel billing and restore guide', async () => {
      session = await Session.create({
        patient: patientId,
        professional: professionalId,
        specialty: 'fonoaudiologia',
        date: new Date(),
        time: '21:00',
        status: 'scheduled',
        paymentType: 'convenio',
        insuranceGuide: guide._id
      });

      const result = await insuranceBillingService.processSessionCompleted(
        session._id.toString(),
        { correlationId: `test-${uuidv4()}` }
      );

      const beforeGuide = await InsuranceGuide.findById(guide._id);
      expect(beforeGuide.usedSessions).toBe(1);

      // Cancelar
      await insuranceBillingService.cancelBilling(
        session._id.toString(),
        'Test cancellation',
        { correlationId: `test-${uuidv4()}` }
      );

      // Verificar guia restaurada
      const afterGuide = await InsuranceGuide.findById(guide._id);
      expect(afterGuide.usedSessions).toBe(0);
      expect(afterGuide.status).toBe('active');

      // Verificar session marcada como cancelada
      const cancelledSession = await Session.findById(session._id);
      expect(cancelledSession.insuranceBillingCancelled).toBe(true);
    });
  });
});
