// tests/completeSession.api.test.js
// 🧪 API Integration Tests - Testa endpoint HTTP completo

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../server.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';

describe('Complete Session API V2', () => {
  let authToken;
  let testPatient;
  let testDoctor;
  let testPackage;

  beforeAll(async () => {
    // Conectar ao banco de teste
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_test');
    
    // Obter token de autenticação (ou criar mock)
    authToken = process.env.TEST_TOKEN || 'test-token';
    
    // Criar dados base
    testPatient = await Patient.create({
      name: 'API Test Patient',
      email: 'api-test@example.com',
      phone: '61988888888'
    });
    
    testDoctor = await Doctor.create({
      name: 'API Test Doctor',
      email: 'api-test-doctor@example.com'
    });
    
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
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('PATCH /v2/appointments/:id/complete', () => {
    it('deve retornar DTO completo com status 200', async () => {
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
        startTime: '14:00',
        correlationId: `api_test_${Date.now()}`
      });

      const response = await request(app)
        .patch(`/api/v2/appointments/${appt._id}/complete?v2=true`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          notes: 'Teste API',
          evolution: 'Paciente evoluiu bem'
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta');
      
      // Validar campos do DTO
      expect(response.body.data).toHaveProperty('appointmentId', appt._id.toString());
      expect(response.body.data).toHaveProperty('clinicalStatus', 'completed');
      expect(response.body.data).toHaveProperty('operationalStatus', 'completed');
      expect(response.body.data).toHaveProperty('paymentStatus');
      expect(response.body.data).toHaveProperty('balanceAmount');
      expect(response.body.data).toHaveProperty('sessionValue');
      expect(response.body.data).toHaveProperty('isPaid');
      
      // Validar meta
      expect(response.body.meta).toHaveProperty('version', 'v2');
      expect(response.body.meta).toHaveProperty('correlationId');
      expect(response.body.meta).toHaveProperty('timestamp');
    });

    it('deve retornar 200 com idempotent=true ao completar 2x', async () => {
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
        startTime: '15:00',
        correlationId: `api_idemp_${Date.now()}`
      });

      // Primeira chamada
      const res1 = await request(app)
        .patch(`/api/v2/appointments/${appt._id}/complete?v2=true`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(res1.body.idempotent).toBeFalsy();

      // Segunda chamada
      const res2 = await request(app)
        .patch(`/api/v2/appointments/${appt._id}/complete?v2=true`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(res2.body.idempotent).toBe(true);
      expect(res2.body.message).toContain('já estava completada');
    });

    it('deve retornar campos financeiros corretos para particular', async () => {
      const appt = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        package: testPackage._id,
        sessionValue: 200,
        billingType: 'particular',
        paymentStatus: 'pending',
        operationalStatus: 'scheduled',
        clinicalStatus: 'scheduled',
        date: new Date(),
        startTime: '16:00',
        correlationId: `api_financial_${Date.now()}`
      });

      const response = await request(app)
        .patch(`/api/v2/appointments/${appt._id}/complete?v2=true`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(response.body.data.balanceAmount).toBe(200);
      expect(response.body.data.sessionValue).toBe(200);
      expect(response.body.data.isPaid).toBe(false);
      expect(response.body.data.paymentStatus).toBe('unpaid');
    });
  });

  describe('Contrato de Erros', () => {
    it('deve retornar 400 para appointment não encontrado', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      
      const response = await request(app)
        .patch(`/api/v2/appointments/${fakeId}/complete?v2=true`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });
});
