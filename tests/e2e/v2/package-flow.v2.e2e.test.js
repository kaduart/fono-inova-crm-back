/**
 * E2E V2 - Fluxo Completo de Pacote (chamada direta de serviços)
 *
 * 1. Cria paciente + doutor + pacote diretamente no DB
 * 2. Cria agendamento vinculado ao pacote
 * 3. Chama completeSessionV2 diretamente
 * 4. Valida sessionsDone incrementado
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import Patient from '../../../models/Patient.js';
import Doctor from '../../../models/Doctor.js';
import Package from '../../../models/Package.js';
import Appointment from '../../../models/Appointment.js';
import Session from '../../../models/Session.js';
import Payment from '../../../models/Payment.js';
import { completeSessionV2 } from '../../../services/completeSessionService.v2.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development';

describe('🧪 V2 E2E - Package Flow', () => {
  let testPatient;
  let testDoctor;
  let testPackage;
  let testAppointment;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao Atlas');

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
    if (testAppointment) {
      await Session.deleteMany({ appointment: testAppointment._id });
      await Payment.deleteMany({ appointment: testAppointment._id });
      await Appointment.deleteOne({ _id: testAppointment._id });
    }
    if (testPackage) await Package.deleteOne({ _id: testPackage._id });
    if (testPatient) await Patient.deleteOne({ _id: testPatient._id });
    await mongoose.disconnect();
    console.log('✅ Cleanup e desconectado');
  }, 30000);

  it('1. Cria pacote diretamente no DB', async () => {
    testPackage = await Package.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      specialty: 'fonoaudiologia',
      sessionType: 'fonoaudiologia',
      sessionValue: 200,
      totalSessions: 5,
      totalValue: 1000,
      sessionsDone: 0,
      status: 'active',
      type: 'therapy',
      paymentMethod: 'pix',
      paymentType: 'per-session',
      date: new Date('2026-04-20'),
      sessionsPerWeek: 1,
      durationMonths: 1,
      createdBy: testPatient._id
    });

    expect(testPackage).toBeTruthy();
    expect(testPackage.status).toBe('active');
    expect(testPackage.totalSessions).toBe(5);
    expect(testPackage.sessionsDone).toBe(0);

    console.log('✅ Pacote criado:', {
      packageId: testPackage._id.toString(),
      totalSessions: testPackage.totalSessions,
      sessionsDone: testPackage.sessionsDone,
      paymentType: testPackage.paymentType
    });
  });

  it('2. Cria agendamento de pacote', async () => {
    testAppointment = await Appointment.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      package: testPackage._id,
      date: '2026-04-20',
      time: '10:00',
      specialty: 'fonoaudiologia',
      serviceType: 'package_session',
      billingType: 'particular',
      paymentMethod: 'pix',
      amount: 0,
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',
      sessionValue: 200
    });

    expect(testAppointment).toBeTruthy();
    expect(testAppointment.operationalStatus).toBe('scheduled');
    expect(testAppointment.serviceType).toBe('package_session');

    console.log('✅ Agendamento criado:', {
      appointmentId: testAppointment._id.toString(),
      status: testAppointment.operationalStatus,
      serviceType: testAppointment.serviceType
    });
  });

  it('3. Completa agendamento e valida sessionsDone', async () => {
    const result = await completeSessionV2(
      testAppointment._id.toString(),
      {
        addToBalance: false,
        userId: testPatient._id.toString()
      }
    );

    expect(result).toBeTruthy();
    expect(result.success).toBe(true);

    const apt = await Appointment.findById(testAppointment._id);
    expect(apt.operationalStatus).toBe('completed');
    expect(apt.clinicalStatus).toBe('completed');

    const pkg = await Package.findById(testPackage._id);
    expect(pkg.sessionsDone).toBe(1);

    console.log('✅ Complete realizado:', {
      appointmentStatus: apt.operationalStatus,
      packageSessionsDone: pkg.sessionsDone,
      packageTotalSessions: pkg.totalSessions
    });
  }, 30000);
});
