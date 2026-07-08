// tests/completeSession.api.test.js
// 🧪 API Integration Tests - Testa endpoint PATCH /v2/appointments/:id/complete
//
// PR 3.2-A.2: O backend assumiu o roteamento financeiro. Este arquivo valida
// que PATCH /complete roteia corretamente para particular, pacote, convênio e
// liminar sem depender de decisão do frontend.

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../server.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import LiminarContract from '../models/LiminarContract.js';

function makeDate(time = '14:00') {
  const d = new Date();
  d.setHours(parseInt(time.split(':')[0], 10), parseInt(time.split(':')[1], 10), 0, 0);
  return d;
}

async function createSession(appointment, overrides = {}) {
  return Session.create({
    patient: appointment.patient,
    doctor: appointment.doctor,
    date: appointment.date,
    time: appointment.startTime || appointment.time,
    sessionType: appointment.sessionType || 'fonoaudiologia',
    sessionValue: appointment.sessionValue || 0,
    appointmentId: appointment._id,
    status: 'scheduled',
    paymentStatus: appointment.paymentStatus || 'pending',
    ...overrides
  });
}

async function completeViaApi(appointmentId, payload = {}) {
  return request(app)
    .patch(`/api/v2/appointments/${appointmentId}/complete`)
    .set('Authorization', `Bearer ${process.env.TEST_TOKEN || 'test-token'}`)
    .send(payload);
}

function expectCompleteContract(body) {
  expect(body).toHaveProperty('success', true);
  expect(body).toHaveProperty('appointment');
  expect(body).toHaveProperty('processing');
  expect(body).toHaveProperty('billing');
  expect(body.processing).toHaveProperty('async');
  expect(body.processing).toHaveProperty('status');
  expect(['completed', 'processing']).toContain(body.processing.status);
  expect(['particular', 'convenio', 'liminar']).toContain(body.billing.type);
}

describe('Complete Appointment API V2', () => {
  let testPatient;
  let testDoctor;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_test');

    testPatient = await Patient.create({
      fullName: 'API Test Patient',
      email: `api-test-${Date.now()}@example.com`,
      phone: '61988888888',
      dateOfBirth: new Date('1990-01-01')
    });

    testDoctor = await Doctor.create({
      fullName: 'API Test Doctor',
      email: `api-test-doctor-${Date.now()}@example.com`,
      specialty: 'fonoaudiologia'
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  describe('PATCH /v2/appointments/:id/complete', () => {
    it('particular: retorna contrato normalizado e cria Payment', async () => {
      const appt = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        sessionValue: 150,
        billingType: 'particular',
        paymentMethod: 'pix',
        paymentStatus: 'pending',
        operationalStatus: 'scheduled',
        clinicalStatus: 'pending',
        date: makeDate(),
        startTime: '14:00',
        correlationId: `api_particular_${Date.now()}`
      });

      await createSession(appt);

      const response = await completeViaApi(appt._id, { notes: 'Teste particular' });

      expect(response.status).toBe(200);
      expectCompleteContract(response.body);
      expect(response.body.billing.type).toBe('particular');
      expect(response.body.appointment.operationalStatus).toBe('completed');

      const payment = await Payment.findOne({ appointment: appt._id });
      expect(payment).toBeTruthy();
    });

    it('pacote: consome sessão do pacote sem criar Payment duplicado', async () => {
      const pkg = await Package.create({
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

      const appt = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        package: pkg._id,
        sessionValue: 150,
        billingType: 'particular',
        paymentStatus: 'pending',
        operationalStatus: 'scheduled',
        clinicalStatus: 'pending',
        date: makeDate('15:00'),
        startTime: '15:00',
        correlationId: `api_package_${Date.now()}`
      });

      await createSession(appt);

      const response = await completeViaApi(appt._id, {});

      expect(response.status).toBe(200);
      expectCompleteContract(response.body);
      expect(response.body.billing.type).toBe('particular');

      const updatedPackage = await Package.findById(pkg._id);
      expect(updatedPackage.sessionsDone).toBe(1);

      const payments = await Payment.find({ appointment: appt._id });
      expect(payments.length).toBeLessThanOrEqual(1);
    });

    it('convênio: roteia para orquestrador e consome guia', async () => {
      const guide = await InsuranceGuide.create({
        patientId: testPatient._id,
        number: `GUIA-API-${Date.now()}`,
        specialty: 'fonoaudiologia',
        insurance: 'unimed',
        totalSessions: 10,
        usedSessions: 0,
        status: 'active',
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
      });

      const appt = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        date: makeDate('16:00'),
        startTime: '16:00',
        specialty: 'fonoaudiologia',
        serviceType: 'convenio_session',
        paymentMethod: 'convenio',
        billingType: 'convenio',
        insuranceGuide: guide._id,
        insuranceProvider: 'unimed',
        insuranceValue: 350,
        sessionValue: 350,
        operationalStatus: 'scheduled',
        clinicalStatus: 'pending',
        paymentStatus: 'pending_receipt',
        correlationId: `api_convenio_${Date.now()}`
      });

      await createSession(appt, { paymentMethod: 'convenio', paymentStatus: 'pending_receipt' });

      const response = await completeViaApi(appt._id, { notes: 'Teste convênio' });

      expect(response.status).toBe(200);
      expectCompleteContract(response.body);
      expect(response.body.billing.type).toBe('convenio');
      expect(response.body.appointment.operationalStatus).toBe('completed');
      expect(response.body.transitions.length).toBeGreaterThan(0);

      const updatedGuide = await InsuranceGuide.findById(guide._id);
      expect(updatedGuide.usedSessions).toBe(1);

      const session = await Session.findOne({ appointmentId: appt._id });
      expect(session.guideConsumed).toBe(true);
    });

    it('liminar: debita contrato judicial sem criar Payment particular', async () => {
      const contract = await LiminarContract.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        processNumber: `PROC-API-${Date.now()}`,
        court: '1ª Vara Federal',
        totalCredit: 1000,
        creditBalance: 1000,
        usedCredit: 0,
        status: 'active'
      });

      const appt = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        date: makeDate('17:00'),
        startTime: '17:00',
        specialty: 'fonoaudiologia',
        serviceType: 'liminar_session',
        paymentMethod: 'liminar_credit',
        billingType: 'liminar',
        liminarContract: contract._id,
        sessionValue: 450,
        operationalStatus: 'scheduled',
        clinicalStatus: 'pending',
        paymentStatus: 'pending',
        correlationId: `api_liminar_${Date.now()}`
      });

      await createSession(appt, { paymentMethod: 'liminar_credit' });

      const response = await completeViaApi(appt._id, {});

      expect(response.status).toBe(200);
      expectCompleteContract(response.body);
      expect(response.body.billing.type).toBe('liminar');
      expect(response.body.appointment.operationalStatus).toBe('completed');

      const updatedContract = await LiminarContract.findById(contract._id);
      expect(updatedContract.usedCredit).toBe(450);
      expect(updatedContract.creditBalance).toBe(550);

      const payments = await Payment.find({ appointment: appt._id });
      expect(payments.length).toBe(0);
    });

    it('retorna sucesso idempotente ao completar 2x', async () => {
      const appt = await Appointment.create({
        patient: testPatient._id,
        doctor: testDoctor._id,
        sessionValue: 150,
        billingType: 'particular',
        paymentMethod: 'pix',
        paymentStatus: 'pending',
        operationalStatus: 'scheduled',
        clinicalStatus: 'pending',
        date: makeDate('18:00'),
        startTime: '18:00',
        correlationId: `api_idemp_${Date.now()}`
      });

      await createSession(appt);

      const res1 = await completeViaApi(appt._id, {});
      expect(res1.status).toBe(200);
      expectCompleteContract(res1.body);

      const res2 = await completeViaApi(appt._id, {});
      expect(res2.status).toBe(200);
      expectCompleteContract(res2.body);
      expect(res2.body.appointment.operationalStatus).toBe('completed');
    });

    it('retorna 404 para appointment não encontrado', async () => {
      const fakeId = new mongoose.Types.ObjectId();

      const response = await completeViaApi(fakeId, {});

      expect(response.status).toBe(404);
    });
  });
});
