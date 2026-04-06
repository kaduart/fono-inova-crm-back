/**
 * 🧪 E2E Test - Liminar Flow
 * 
 * Fluxo: Create Liminar Package → Create Session → Complete → Validate
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';
import Appointment from '../../../models/Appointment.js';
import Package from '../../../models/Package.js';
import Patient from '../../../models/Patient.js';
import Doctor from '../../../models/Doctor.js';
import { startAllWorkers, stopAllWorkers } from '../../../workers/index.js';
import { startRedis } from '../../../services/redisClient.js';
import { v4 as uuidv4 } from 'uuid';

// Test data
let createdPatientId;
let createdPackageId;
let createdAppointmentId;
let testDoctorId;

const timestamp = Date.now();
const testContext = `[pkg_lim_e2e_${timestamp}]`;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

describe('🧪 V2 E2E - Liminar Flow', () => {
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
      fullName: `E2E Liminar Patient ${timestamp}`,
      phone: `11999${timestamp.toString().slice(-6)}`,
      email: `e2e.liminar.${timestamp}@test.com`,
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
    if (createdPackageId) await Package.deleteOne({ _id: createdPackageId });
    if (createdPatientId) await Patient.deleteOne({ _id: createdPatientId });
    
    // Para workers
    await stopAllWorkers();
    
    await mongoose.disconnect();
    console.log(`${testContext} Cleanup e desconectado`);
  }, 30000);

  it('1. Cria pacote liminar', async () => {
    const requestId = uuidv4();
    const packageId = new mongoose.Types.ObjectId();
    createdPackageId = packageId;
    
    console.log(`${testContext} Criando pacote liminar:`, packageId.toString());
    
    const event = await publishEvent(
      'PACKAGE_CREATE_REQUESTED',
      {
        packageId: packageId.toString(),
        patientId: createdPatientId.toString(),
        doctorId: testDoctorId.toString(),
        totalSessions: 5,
        sessionValue: 450,
        type: 'liminar',
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        liminarProcessNumber: `PROC-E2E-${timestamp}`,
        liminarCourt: '1ª Vara Federal',
        requestId
      },
      { requestId }
    );
    
    console.log(`${testContext} Evento publicado:`, event.eventId);
    
    // Aguarda processamento
    await new Promise(r => setTimeout(r, 12000));
    
    // Verifica se pacote foi criado
    const pkg = await Package.findById(createdPackageId);
    
    // Retry se não encontrou imediatamente
    if (!pkg) {
      console.log(`${testContext} Pacote não encontrado, aguardando mais...`);
      await new Promise(r => setTimeout(r, 8000));
      const pkgRetry = await Package.findById(createdPackageId);
      expect(pkgRetry).toBeTruthy();
      expect(pkgRetry.type).toBe('liminar');
      expect(pkgRetry.totalSessions).toBe(5);
      console.log(`${testContext} ✅ Pacote liminar criado:`, pkgRetry._id.toString());
    } else {
      expect(pkg.type).toBe('liminar');
      expect(pkg.totalSessions).toBe(5);
      expect(pkg.liminarProcessNumber).toBe(`PROC-E2E-${timestamp}`);
      console.log(`${testContext} ✅ Pacote liminar criado:`, pkg._id.toString());
    }
  }, 20000);

  it('2. Cria agendamento de liminar', async () => {
    const requestId = uuidv4();
    const appointmentId = new mongoose.Types.ObjectId();
    createdAppointmentId = appointmentId;
    
    console.log(`${testContext} Criando agendamento liminar...`);
    
    // Cria appointment direto
    const appointment = await Appointment.create({
      _id: appointmentId,
      patient: createdPatientId,
      doctor: testDoctorId,
      date: '2026-04-20',
      time: '14:00',
      specialty: 'fonoaudiologia',
      serviceType: 'liminar_session',
      paymentMethod: 'liminar',
      billingType: 'liminar',
      package: createdPackageId,
      sessionValue: 450,
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',
      paymentOrigin: 'liminar'
    });
    
    expect(appointment).toBeTruthy();
    expect(appointment.serviceType).toBe('liminar_session');
    expect(appointment.paymentOrigin).toBe('liminar');
    
    console.log(`${testContext} ✅ Agendamento criado:`, appointment._id.toString());
  }, 10000);

  it('3. Completa e reconhece receita', async () => {
    const requestId = uuidv4();
    
    console.log(`${testContext} Completando agendamento...`);
    
    const event = await publishEvent(
      'APPOINTMENT_COMPLETE_REQUESTED',
      {
        appointmentId: createdAppointmentId.toString(),
        packageId: createdPackageId.toString(),
        doctorId: testDoctorId.toString(),
        patientId: createdPatientId.toString(),
        completedAt: new Date().toISOString(),
        notes: 'Sessão liminar completada - E2E',
        requestId
      },
      { requestId }
    );
    
    console.log(`${testContext} Evento complete publicado:`, event.eventId);
    
    // Aguarda processamento
    await new Promise(r => setTimeout(r, 8000));
    
    // Verifica agendamento
    const apt = await Appointment.findById(createdAppointmentId);
    expect(apt).toBeTruthy();
    expect(apt.operationalStatus).toBe('completed');
    
    // Verifica package
    const pkg = await Package.findById(createdPackageId);
    expect(pkg).toBeTruthy();
    expect(pkg.sessionsDone).toBe(1);
    expect(pkg.recognizedRevenue).toBe(450);
    
    console.log(`${testContext} ✅ Complete realizado:`, {
      appointmentStatus: apt.operationalStatus,
      packageSessionsDone: pkg.sessionsDone,
      recognizedRevenue: pkg.recognizedRevenue
    });
  }, 20000);
});
