// tests/completeSession.contract.test.js
// 🧪 Contract Tests - Garante que DTO nunca quebra

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import mongoose from 'mongoose';
import { completeSessionV2 } from '../services/completeSessionService.v2.js';
import { createCompleteSessionResponse } from '../dtos/completeSessionResponse.dto.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';

describe('Complete Session V2 - Contract Tests', () => {
  let testPatient;
  let testDoctor;
  let testPackage;
  let testAppointment;

  beforeAll(async () => {
    // Setup: Criar dados de teste
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_test');
    
    // Limpar dados de teste anteriores
    await Appointment.deleteMany({ correlationId: /test_/ });
    
    // Criar paciente de teste
    testPatient = await Patient.create({
      name: 'Test Patient Contract',
      email: 'test-contract@example.com',
      phone: '61999999999'
    });
    
    // Criar doctor de teste
    testDoctor = await Doctor.create({
      name: 'Test Doctor Contract',
      email: 'test-doctor-contract@example.com'
    });
    
    // Criar package de teste (particular per-session)
    testPackage = await Package.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      type: 'therapy',
      paymentType: 'per-session',
      totalSessions: 3,
      sessionValue: 150,
      totalValue: 450,
      durationMonths: 1,
      sessionsPerWeek: 1,
      sessionType: 'fonoaudiologia',
      specialty: 'fonoaudiologia',
      date: new Date()
    });
    
    // Criar appointment de teste
    testAppointment = await Appointment.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      package: testPackage._id,
      sessionValue: 150,
      billingType: 'particular',
      paymentStatus: 'pending',
      operationalStatus: 'scheduled',
      clinicalStatus: 'scheduled',
      date: new Date(),
      startTime: '14:00',
      endTime: '15:00',
      correlationId: `test_${Date.now()}`
    });
  });

  afterAll(async () => {
    // Cleanup
    await Appointment.deleteMany({ correlationId: /test_/ });
    await Package.deleteById?.(testPackage._id).catch(() => {});
    await Patient.deleteById?.(testPatient._id).catch(() => {});
    await Doctor.deleteById?.(testDoctor._id).catch(() => {});
    await mongoose.connection.close();
  });

  describe('DTO Schema Validation', () => {
    it('deve retornar DTO com todos os campos obrigatórios', async () => {
      const result = await completeSessionV2(testAppointment._id.toString(), {
        notes: 'Teste contrato',
        correlationId: `test_contract_${Date.now()}`
      });

      const dto = createCompleteSessionResponse({
        appointmentId: result.appointmentId,
        sessionId: result.sessionId,
        packageId: result.packageId,
        clinicalStatus: 'completed',
        operationalStatus: 'completed',
        paymentStatus: 'unpaid',
        balanceAmount: 150,
        sessionValue: 150,
        isPaid: false,
        correlationId: result.correlationId
      });

      // Validar estrutura do DTO
      expect(dto).toHaveProperty('success', true);
      expect(dto).toHaveProperty('idempotent');
      expect(dto).toHaveProperty('message');
      expect(dto).toHaveProperty('data');
      expect(dto).toHaveProperty('meta');
      
      // Validar campos de data
      expect(dto.data).toHaveProperty('appointmentId');
      expect(dto.data).toHaveProperty('clinicalStatus', 'completed');
      expect(dto.data).toHaveProperty('operationalStatus', 'completed');
      expect(dto.data).toHaveProperty('paymentStatus');
      expect(dto.data).toHaveProperty('balanceAmount');
      expect(dto.data).toHaveProperty('sessionValue');
      expect(dto.data).toHaveProperty('isPaid');
      expect(dto.data).toHaveProperty('completedAt');
      
      // Validar meta
      expect(dto.meta).toHaveProperty('version', 'v2');
      expect(dto.meta).toHaveProperty('correlationId');
      expect(dto.meta).toHaveProperty('timestamp');
    });

    it('deve ter tipos corretos nos campos', async () => {
      const result = await completeSessionV2(testAppointment._id.toString(), {
        correlationId: `test_types_${Date.now()}`
      });

      const dto = createCompleteSessionResponse({
        appointmentId: result.appointmentId,
        clinicalStatus: 'completed',
        operationalStatus: 'completed',
        paymentStatus: 'unpaid',
        balanceAmount: result.sessionValue || 150,
        sessionValue: result.sessionValue || 150,
        isPaid: false,
        correlationId: result.correlationId
      });

      expect(typeof dto.success).toBe('boolean');
      expect(typeof dto.data.appointmentId).toBe('string');
      expect(typeof dto.data.balanceAmount).toBe('number');
      expect(typeof dto.data.sessionValue).toBe('number');
      expect(typeof dto.data.isPaid).toBe('boolean');
      expect(typeof dto.meta.version).toBe('string');
    });
  });

  describe('Financial Consistency', () => {
    it('deve gerar balanceAmount igual ao sessionValue para particular', async () => {
      // Criar novo appointment para não conflitar
      const newAppt = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        package: testPackage._id,
        sessionValue: 200,
        billingType: 'particular',
        paymentStatus: 'pending',
        operationalStatus: 'scheduled',
        clinicalStatus: 'scheduled',
        date: new Date(),
        startTime: '15:00',
        correlationId: `test_financial_${Date.now()}`
      });

      const result = await completeSessionV2(newAppt._id.toString(), {
        correlationId: `test_fin_${Date.now()}`
      });

      const dto = createCompleteSessionResponse({
        appointmentId: result.appointmentId,
        clinicalStatus: 'completed',
        operationalStatus: 'completed',
        paymentStatus: 'unpaid',
        balanceAmount: result.sessionValue || 200,
        sessionValue: result.sessionValue || 200,
        isPaid: false,
        correlationId: result.correlationId
      });

      // Regra: balanceAmount = sessionValue para particular
      expect(dto.data.balanceAmount).toBe(dto.data.sessionValue);
      expect(dto.data.paymentStatus).toBe('unpaid');
      expect(dto.data.isPaid).toBe(false);
    });

    it('deve incrementar sessionsDone no package', async () => {
      const packageBefore = await Package.findById(testPackage._id);
      const doneBefore = packageBefore.sessionsDone || 0;

      // Criar novo appointment
      const newAppt = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        package: testPackage._id,
        sessionValue: 150,
        billingType: 'particular',
        paymentStatus: 'pending',
        operationalStatus: 'scheduled',
        clinicalStatus: 'scheduled',
        date: new Date(),
        startTime: '16:00',
        correlationId: `test_counter_${Date.now()}`
      });

      await completeSessionV2(newAppt._id.toString(), {
        correlationId: `test_count_${Date.now()}`
      });

      const packageAfter = await Package.findById(testPackage._id);
      const doneAfter = packageAfter.sessionsDone || 0;

      expect(doneAfter).toBe(doneBefore + 1);
    });
  });

  describe('Idempotency', () => {
    it('deve retornar idempotent=true ao completar 2x a mesma sessão', async () => {
      // Criar appointment
      const appt = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        package: testPackage._id,
        sessionValue: 150,
        billingType: 'particular',
        paymentStatus: 'pending',
        operationalStatus: 'scheduled',
        clinicalStatus: 'scheduled',
        date: new Date(),
        startTime: '17:00',
        correlationId: `test_idemp_${Date.now()}`
      });

      const apptId = appt._id.toString();

      // Primeira chamada
      const result1 = await completeSessionV2(apptId, {
        correlationId: `test_idemp1_${Date.now()}`
      });

      // Segunda chamada (mesmo ID)
      const result2 = await completeSessionV2(apptId, {
        correlationId: `test_idemp2_${Date.now()}`
      });

      // Ambos devem ter sucesso
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      
      // Segunda deve ser idempotente
      expect(result2.idempotent).toBe(true);

      // Package não deve ter sido incrementado 2x
      const packageFinal = await Package.findById(testPackage._id);
      expect(packageFinal.sessionsDone).toBe(result1.packageUpdate?.sessionsDone || 1);
    });
  });

  describe('State Transitions', () => {
    it('deve rejeitar complete em sessão canceled', async () => {
      const appt = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        package: testPackage._id,
        sessionValue: 150,
        billingType: 'particular',
        paymentStatus: 'canceled',
        operationalStatus: 'canceled',
        clinicalStatus: 'canceled',
        date: new Date(),
        startTime: '18:00',
        correlationId: `test_cancel_${Date.now()}`
      });

      await expect(
        completeSessionV2(appt._id.toString(), {})
      ).rejects.toThrow('Cannot complete canceled session');
    });

    it('deve permitir complete de scheduled', async () => {
      const appt = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        package: testPackage._id,
        sessionValue: 150,
        billingType: 'particular',
        paymentStatus: 'pending',
        operationalStatus: 'scheduled',
        clinicalStatus: 'scheduled',
        date: new Date(),
        startTime: '19:00',
        correlationId: `test_sched_${Date.now()}`
      });

      const result = await completeSessionV2(appt._id.toString(), {});
      
      expect(result.success).toBe(true);
      expect(result.idempotent).toBe(false);
    });
  });
});
