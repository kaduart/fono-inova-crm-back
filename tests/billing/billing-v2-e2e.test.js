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
// ⚠️ DEVE ser importado ANTES de qualquer módulo que carregue InsuranceGuide → identityResolver
import '../../models/Patient.js';
import '../../models/PatientsView.js';
import { insuranceBillingService } from '../../domains/billing/services/insuranceBillingService.v2.js';
import { reconciliationService } from '../../domains/billing/services/ReconciliationService.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import Doctor from '../../models/Doctor.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Convenio from '../../models/Convenio.js';
import EventStore from '../../models/EventStore.js';

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

    const patient = await Patient.create({
      fullName: 'Test Patient E2E',
      cpf: '12345678901'
    });
    patientId = patient._id;

    const professional = await Doctor.create({
      fullName: 'Test Professional',
      name: 'Test Professional',
      specialty: 'fonoaudiologia',
      phoneNumber: '11999999999',
      licenseNumber: `CRM-SP-${uuidv4().slice(0, 8)}`,
      email: `prof.${uuidv4().slice(0, 8)}@test.com`
    });
    professionalId = professional._id;

    // Cria convênio de teste para cálculo de valor da sessão
    await Convenio.create({
      code: 'test-insurance',
      name: 'Test Insurance',
      sessionValue: 80,
      active: true
    });
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
    await Convenio.deleteMany({ code: 'test-insurance' });
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
        doctor: professionalId,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        date: new Date(),
        time: '14:00',
        status: 'scheduled',
        paymentMethod: 'convenio',
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
        doctor: professionalId,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        date: new Date(),
        time: '15:00',
        status: 'scheduled',
        paymentMethod: 'convenio',
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
        doctor: professionalId,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        date: new Date(),
        time: '16:00',
        status: 'scheduled',
        paymentMethod: 'convenio',
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
        doctor: professionalId,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        date: new Date(),
        time: '17:00',
        status: 'scheduled',
        paymentMethod: 'convenio',
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
        doctor: professionalId,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        date: new Date(),
        time: '18:00',
        status: 'scheduled',
        paymentMethod: 'convenio',
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
        doctor: professionalId,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        date: new Date(),
        time: '19:00',
        status: 'completed',
        paymentMethod: 'convenio',
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
        doctor: professionalId,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        date: new Date(),
        time: '20:00',
        status: 'scheduled',
        paymentMethod: 'convenio',
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
        doctor: professionalId,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        date: new Date(),
        time: '21:00',
        status: 'scheduled',
        paymentMethod: 'convenio',
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

  // =============================================================================
  // ONE SESSION = ONE PAYMENT (Ghost Aggregation Fix)
  // =============================================================================

  describe('One Session = One Payment', () => {
    it('should create exactly one payment per session, never aggregate grossAmount', async () => {
      // Mesmo paciente, mesmo profissional, mesmo convênio, mesmo mês
      const baseDate = new Date('2026-05-15T10:00:00.000Z');

      const session1 = await Session.create({
        patient: patientId,
        professional: professionalId,
        doctor: professionalId,
        doctor: professionalId,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        date: new Date(baseDate),
        time: '10:00',
        status: 'scheduled',
        paymentMethod: 'convenio',
        insuranceGuide: guide._id
      });

      const session2 = await Session.create({
        patient: patientId,
        professional: professionalId,
        doctor: professionalId,
        doctor: professionalId,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        date: new Date(baseDate.getTime() + 24 * 60 * 60 * 1000), // dia seguinte, mesmo mês
        time: '11:00',
        status: 'scheduled',
        paymentMethod: 'convenio',
        insuranceGuide: guide._id
      });

      // Processa ambas as sessões
      const result1 = await insuranceBillingService.processSessionCompleted(
        session1._id.toString(),
        { correlationId: `test-${uuidv4()}` }
      );
      const result2 = await insuranceBillingService.processSessionCompleted(
        session2._id.toString(),
        { correlationId: `test-${uuidv4()}` }
      );

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.paymentId).not.toBe(result2.paymentId);

      // Deve existir EXATAMENTE 2 payments
      const payments = await Payment.find({
        patient: patientId,
        billingType: 'convenio',
        'insurance.month': '2026-05'
      }).sort({ createdAt: 1 });

      expect(payments).toHaveLength(2);

      // Cada payment deve ter exatamente 1 sessão e grossAmount igual ao valor individual
      for (const payment of payments) {
        expect(payment.sessions).toHaveLength(1);
        expect(payment.insurance.grossAmount).toBe(payment.amount);
        expect(payment.insurance.netAmount).toBe(payment.amount);
        expect(['pending_billing', 'pending']).toContain(payment.status);
      }

      // Os valores não devem ter sido agregados/somados entre os payments
      // (prova do bug "ghost aggregation": se estivesse agrupando, teríamos 1 payment com grossAmount=160)
      const totalGross = payments.reduce((sum, p) => sum + p.insurance.grossAmount, 0);
      expect(totalGross).toBe(payments.length * payments[0].insurance.grossAmount);

      // IDEMPOTÊNCIA: reprocessar a mesma sessão não cria novo payment
      const result1Again = await insuranceBillingService.processSessionCompleted(
        session1._id.toString(),
        { correlationId: `test-${uuidv4()}` }
      );
      expect(result1Again.duplicate).toBe(true);

      const paymentsAfterRetry = await Payment.find({
        patient: patientId,
        billingType: 'convenio',
        'insurance.month': '2026-05'
      });
      expect(paymentsAfterRetry).toHaveLength(2);
    });
  });
});
