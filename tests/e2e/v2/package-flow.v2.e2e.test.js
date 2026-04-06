/**
 * E2E V2 - Fluxo Completo de Pacote
 * 
 * Testa o fluxo end-to-end:
 * 1. Cria pacote
 * 2. Cria agendamento de pacote
 * 3. Completa agendamento
 * 4. Valida sessionsDone incrementado
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import Patient from '../../../models/Patient.js';
import Doctor from '../../../models/Doctor.js';
import Package from '../../../models/Package.js';
import Appointment from '../../../models/Appointment.js';
import Session from '../../../models/Session.js';
import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';
import { startAllWorkers, stopAllWorkers } from '../../../workers/index.js';
import { startRedis } from '../../../services/redisClient.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

describe('🧪 V2 E2E - Package Flow', () => {
  let testPatient;
  let testDoctor;
  let createdPackageId;
  let createdAppointmentId;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao Atlas');
    
    // Inicia Redis
    await startRedis();
    
    // Inicia workers
    startAllWorkers();
    console.log('✅ Workers iniciados');
    
    // Aguarda workers iniciarem
    await new Promise(r => setTimeout(r, 2000));
    
    // Setup: Cria paciente e doutor de teste
    testPatient = await Patient.create({
      fullName: 'E2E Package Test Patient',
      email: `e2e_package_${Date.now()}@test.com`,
      phone: '11999999999',
      dateOfBirth: new Date('1990-01-01')
    });
    
    testDoctor = await Doctor.findOne() || await Doctor.create({
      fullName: 'Dr. E2E Test',
      specialty: 'fonoaudiologia',
      email: `e2e_doc_${Date.now()}@test.com`
    });
    
    console.log('✅ Setup:', {
      patientId: testPatient._id.toString(),
      doctorId: testDoctor._id.toString()
    });
  }, 30000);

  afterAll(async () => {
    // Cleanup
    if (testPatient) await Patient.deleteOne({ _id: testPatient._id });
    if (createdPackageId) await Package.deleteOne({ _id: createdPackageId });
    if (createdAppointmentId) await Appointment.deleteOne({ _id: createdAppointmentId });
    await mongoose.disconnect();
    console.log('✅ Cleanup e desconectado');
  }, 30000);

  it('1. Cria pacote com packageId predefinido', async () => {
    const correlationId = `pkg_e2e_${Date.now()}`;
    const requestId = `req_${Date.now()}`;
    createdPackageId = new mongoose.Types.ObjectId();
    
    // Publica evento de criação de pacote
    const eventResult = await publishEvent('PACKAGE_CREATE_REQUESTED', {
      packageId: createdPackageId.toString(),
      patientId: testPatient._id.toString(),
      doctorId: testDoctor._id.toString(),
      specialty: 'fonoaudiologia',
      sessionType: 'fonoaudiologia',
      sessionValue: 200,
      totalSessions: 5,
      type: 'therapy',
      paymentMethod: 'pix',
      requestId,
      createdBy: testPatient._id.toString()
    }, { correlationId });

    console.log('✅ Evento PACKAGE_CREATE_REQUESTED publicado:', eventResult.eventId);
    
    // Aguarda processamento (simula worker)
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Verifica se pacote foi criado
    const pkg = await Package.findById(createdPackageId);
    expect(pkg).toBeTruthy();
    expect(pkg.status).toBe('active');
    expect(pkg.totalSessions).toBe(5);
    expect(pkg.sessionsDone).toBe(0);
    
    console.log('✅ Pacote criado:', {
      packageId: pkg._id.toString(),
      totalSessions: pkg.totalSessions,
      sessionsDone: pkg.sessionsDone
    });
  }, 30000);

  it('2. Cria agendamento de pacote', async () => {
    const correlationId = `apt_e2e_${Date.now()}`;
    createdAppointmentId = new mongoose.Types.ObjectId();
    
    // Cria appointment direto (simulando a API)
    const appointment = await Appointment.create({
      _id: createdAppointmentId,
      patient: testPatient._id,
      doctor: testDoctor._id,
      package: createdPackageId,
      date: '2026-04-20',
      time: '10:00',
      specialty: 'fonoaudiologia',
      serviceType: 'package_session',
      billingType: 'particular',
      paymentMethod: 'package',
      amount: 0,
      operationalStatus: 'processing_create',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',
      sessionValue: 0
    });

    // Publica evento
    const eventResult = await publishEvent('APPOINTMENT_CREATE_REQUESTED', {
      appointmentId: appointment._id.toString(),
      patientId: testPatient._id.toString(),
      doctorId: testDoctor._id.toString(),
      packageId: createdPackageId.toString(),
      date: '2026-04-20',
      time: '10:00',
      specialty: 'fonoaudiologia',
      serviceType: 'package_session',
      billingType: 'particular',
      paymentMethod: 'package',
      amount: 0,
      notes: 'E2E Test'
    }, { correlationId });

    console.log('✅ Evento APPOINTMENT_CREATE_REQUESTED publicado:', eventResult.eventId);
    
    // Aguarda processamento
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Verifica se foi processado
    const apt = await Appointment.findById(createdAppointmentId);
    expect(apt).toBeTruthy();
    expect(apt.operationalStatus).toBe('scheduled');
    
    console.log('✅ Agendamento criado:', {
      appointmentId: apt._id.toString(),
      status: apt.operationalStatus,
      hasSession: !!apt.session
    });
  }, 30000);

  it('3. Completa agendamento e valida sessionsDone', async () => {
    const correlationId = `complete_e2e_${Date.now()}`;
    
    // Publica evento de complete
    const eventResult = await publishEvent('APPOINTMENT_COMPLETE_REQUESTED', {
      appointmentId: createdAppointmentId.toString(),
      patientId: testPatient._id.toString(),
      doctorId: testDoctor._id.toString(),
      packageId: createdPackageId.toString(),
      addToBalance: false,
      userId: testPatient._id.toString()
    }, { correlationId });

    console.log('✅ Evento APPOINTMENT_COMPLETE_REQUESTED publicado:', eventResult.eventId);
    
    // Aguarda processamento (mais tempo quando roda em paralelo)
    await new Promise(resolve => setTimeout(resolve, 8000));
    
    // Verifica se appointment foi completado
    const apt = await Appointment.findById(createdAppointmentId);
    expect(apt.operationalStatus).toBe('completed');
    expect(apt.clinicalStatus).toBe('completed');
    
    // Verifica se package incrementou sessionsDone
    const pkg = await Package.findById(createdPackageId);
    expect(pkg.sessionsDone).toBe(1);
    
    console.log('✅ Complete realizado:', {
      appointmentStatus: apt.operationalStatus,
      packageSessionsDone: pkg.sessionsDone,
      packageTotalSessions: pkg.totalSessions
    });
  }, 30000);
});
