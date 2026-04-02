/**
 * 🧪 E2E Test - Convênio Flow
 * 
 * Fluxo: Create InsuranceGuide → Create Session → Complete → Validate guide.usedSessions
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';
import Appointment from '../../../models/Appointment.js';
import Patient from '../../../models/Patient.js';
import Doctor from '../../../models/Doctor.js';
import InsuranceGuide from '../../../models/InsuranceGuide.js';
import { startAllWorkers, stopAllWorkers } from '../../../workers/index.js';
import { startRedis } from '../../../services/redisClient.js';
import { v4 as uuidv4 } from 'uuid';

// Test data
let createdPatientId;
let createdGuideId;
let createdAppointmentId;
let testDoctorId;

const timestamp = Date.now();
const testContext = `[conv_e2e_${timestamp}]`;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

describe('🧪 V2 E2E - Convênio Flow', () => {
  beforeAll(async () => {
    console.log(`${testContext} Conectando ao Atlas...`);
    await mongoose.connect(MONGO_URI);
    
    // Inicia Redis
    await startRedis();
    
    // Inicia workers
    console.log(`${testContext} Iniciando workers...`);
    startAllWorkers();
    
    // Aguarda workers iniciarem
    await new Promise(r => setTimeout(r, 2000));
    
    // Create test patient
    const patient = await Patient.create({
      fullName: `E2E Convenio Patient ${timestamp}`,
      phone: `11988${timestamp.toString().slice(-6)}`,
      email: `e2e.convenio.${timestamp}@test.com`,
      dateOfBirth: new Date('1990-01-01')
    });
    createdPatientId = patient._id;
    
    // Use existing doctor or create one
    const doctor = await Doctor.findOne() || await Doctor.create({
      name: 'Dr. E2E Test',
      email: `dr.e2e.${timestamp}@test.com`,
      specialty: 'fonoaudiologia'
    });
    testDoctorId = doctor._id;
    
    console.log(`${testContext} Setup:`, {
      patientId: createdPatientId.toString(),
      doctorId: testDoctorId.toString()
    });
  }, 30000);

  afterAll(async () => {
    console.log(`${testContext} Cleanup...`);
    if (createdAppointmentId) await Appointment.deleteOne({ _id: createdAppointmentId });
    if (createdGuideId) await InsuranceGuide.deleteOne({ _id: createdGuideId });
    if (createdPatientId) await Patient.deleteOne({ _id: createdPatientId });
    
    // Para workers
    await stopAllWorkers();
    
    await mongoose.disconnect();
    console.log(`${testContext} Cleanup e desconectado`);
  }, 30000);

  it('1. Cria guia de convênio', async () => {
    const guideId = new mongoose.Types.ObjectId();
    createdGuideId = guideId;
    
    const guideData = {
      _id: guideId,
      patientId: createdPatientId,
      number: `GUIA-E2E-${timestamp}`,
      specialty: 'fonoaudiologia',
      insurance: 'unimed',
      totalSessions: 10,
      usedSessions: 0,
      status: 'active',
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    };
    
    const guide = await InsuranceGuide.create(guideData);
    
    expect(guide).toBeTruthy();
    expect(guide.number).toBe(`GUIA-E2E-${timestamp}`);
    expect(guide.totalSessions).toBe(10);
    expect(guide.usedSessions).toBe(0);
    
    console.log(`${testContext} ✅ Guia criada:`, {
      guideId: guide._id.toString(),
      number: guide.number,
      totalSessions: guide.totalSessions
    });
  }, 10000);

  it('2. Cria agendamento de convênio', async () => {
    const requestId = uuidv4();
    const appointmentId = new mongoose.Types.ObjectId();
    createdAppointmentId = appointmentId;
    
    console.log(`${testContext} Criando agendamento convênio...`);
    
    // Cria appointment direto
    const appointment = await Appointment.create({
      _id: appointmentId,
      patient: createdPatientId,
      doctor: testDoctorId,
      date: '2026-04-25',
      time: '15:00',
      specialty: 'fonoaudiologia',
      serviceType: 'convenio_session',
      paymentMethod: 'convenio',
      billingType: 'convenio',
      insuranceGuide: createdGuideId,
      insuranceProvider: 'unimed',
      insuranceValue: 350,
      sessionValue: 350,
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      paymentStatus: 'pending_receipt'
    });
    
    expect(appointment).toBeTruthy();
    expect(appointment.serviceType).toBe('convenio_session');
    expect(appointment.billingType).toBe('convenio');
    
    console.log(`${testContext} ✅ Agendamento criado:`, {
      appointmentId: appointment._id.toString(),
      status: appointment.operationalStatus
    });
  }, 10000);

  it('3. Completa e consome guia', async () => {
    const requestId = uuidv4();
    
    console.log(`${testContext} Completando agendamento convênio...`);
    
    const event = await publishEvent(
      'APPOINTMENT_COMPLETE_REQUESTED',
      {
        appointmentId: createdAppointmentId.toString(),
        insuranceGuideId: createdGuideId.toString(),
        doctorId: testDoctorId.toString(),
        patientId: createdPatientId.toString(),
        completedAt: new Date().toISOString(),
        notes: 'Sessão convênio completada - E2E',
        isConvenio: true,
        requestId
      },
      { requestId }
    );
    
    console.log(`${testContext} Evento complete publicado:`, event.eventId);
    
    // Aguarda processamento (simply wait)
    await new Promise(r => setTimeout(r, 8000));
    
    // Verifica agendamento
    const apt = await Appointment.findById(createdAppointmentId);
    console.log(`${testContext} Appointment status:`, apt?.operationalStatus);
    console.log(`${testContext} Appointment billingType:`, apt?.billingType);
    console.log(`${testContext} Appointment insuranceGuide:`, apt?.insuranceGuide);
    expect(apt).toBeTruthy();
    expect(apt.operationalStatus).toBe('completed');
    
    // Verifica guia
    const guide = await InsuranceGuide.findById(createdGuideId);
    console.log(`${testContext} Guide usedSessions:`, guide?.usedSessions);
    expect(guide).toBeTruthy();
    expect(guide.usedSessions).toBe(1);
    
    console.log(`${testContext} ✅ Complete realizado:`, {
      appointmentStatus: apt.operationalStatus,
      guideUsedSessions: guide.usedSessions,
      guideStatus: guide.status
    });
  }, 25000);
});
