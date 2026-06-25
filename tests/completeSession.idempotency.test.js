/**
 * 🛡️ Testes de Idempotência - completeSessionService.v2.js
 *
 * Valida que o serviço oficial de complete não duplica:
 * - Payment
 * - Package.sessionsDone
 * - PatientBalance débito
 *
 * Esses testes cobrem a Fase 2 do plano de consolidação do complete.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import '../models/index.js';
import { completeSessionV2 } from '../services/completeSessionService.v2.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import PatientBalance from '../models/PatientBalance.js';

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_test';

describe('Complete Session V2 - Idempotência', () => {
  let testPatient;
  let testDoctor;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);

    testPatient = await Patient.create({
      fullName: 'Idempotency Test Patient',
      email: `idemp_${Date.now()}@test.com`,
      phone: '61988888888'
    });

    testDoctor = await Doctor.create({
      name: 'Idempotency Test Doctor',
      email: `idemp-doc_${Date.now()}@test.com`
    });
  });

  afterAll(async () => {
    await Patient.deleteOne({ _id: testPatient._id });
    await Doctor.deleteOne({ _id: testDoctor._id });
    await mongoose.connection.close();
  });

  it('Particular avulso: double complete não duplica Payment', async () => {
    const session = await Session.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      date: new Date(),
      status: 'scheduled',
      sessionValue: 200,
      paymentStatus: 'pending'
    });

    const appt = await Appointment.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      session: session._id,
      sessionValue: 200,
      billingType: 'particular',
      paymentStatus: 'pending',
      operationalStatus: 'scheduled',
      clinicalStatus: 'scheduled',
      date: new Date(),
      startTime: '09:00',
      endTime: '10:00',
      correlationId: `idemp_avulso_${Date.now()}`
    });

    await completeSessionV2(appt._id.toString(), {
      correlationId: `idemp_avulso_call_1_${Date.now()}`
    });

    await completeSessionV2(appt._id.toString(), {
      correlationId: `idemp_avulso_call_2_${Date.now()}`
    });

    const payments = await Payment.find({ appointment: appt._id });
    expect(payments.length).toBe(1);

    const completedAppt = await Appointment.findById(appt._id);
    expect(completedAppt.operationalStatus).toBe('completed');

    await Payment.deleteOne({ _id: payments[0]._id });
    await Session.deleteOne({ _id: session._id });
    await Appointment.deleteOne({ _id: appt._id });
  }, 30000);

  it('Pacote per-session: double complete não incrementa sessionsDone duas vezes', async () => {
    const pkg = await Package.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      type: 'therapy',
      paymentType: 'per-session',
      totalSessions: 5,
      sessionValue: 150,
      totalValue: 750,
      durationMonths: 1,
      sessionsPerWeek: 1,
      sessionType: 'fonoaudiologia',
      specialty: 'fonoaudiologia',
      date: new Date()
    });

    const session = await Session.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      package: pkg._id,
      date: new Date(),
      status: 'scheduled',
      sessionValue: 150,
      paymentStatus: 'pending'
    });

    const appt = await Appointment.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      session: session._id,
      package: pkg._id,
      sessionValue: 150,
      billingType: 'particular',
      paymentStatus: 'pending',
      operationalStatus: 'scheduled',
      clinicalStatus: 'scheduled',
      date: new Date(),
      startTime: '10:00',
      endTime: '11:00',
      correlationId: `idemp_pkg_${Date.now()}`
    });

    await completeSessionV2(appt._id.toString(), {
      correlationId: `idemp_pkg_call_1_${Date.now()}`
    });

    await completeSessionV2(appt._id.toString(), {
      correlationId: `idemp_pkg_call_2_${Date.now()}`
    });

    const updatedPackage = await Package.findById(pkg._id);
    expect(updatedPackage.sessionsDone).toBe(1);

    const payments = await Payment.find({ appointment: appt._id });
    expect(payments.length).toBe(1);

    await Payment.deleteOne({ appointment: appt._id });
    await Session.deleteOne({ _id: session._id });
    await Appointment.deleteOne({ _id: appt._id });
    await Package.deleteOne({ _id: pkg._id });
  }, 30000);

  it('addToBalance: double complete não duplica débito no PatientBalance', async () => {
    const session = await Session.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      date: new Date(),
      status: 'scheduled',
      sessionValue: 300,
      paymentStatus: 'pending'
    });

    const appt = await Appointment.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      session: session._id,
      sessionValue: 300,
      billingType: 'particular',
      paymentStatus: 'pending',
      operationalStatus: 'scheduled',
      clinicalStatus: 'scheduled',
      date: new Date(),
      startTime: '11:00',
      endTime: '12:00',
      correlationId: `idemp_balance_${Date.now()}`
    });

    await completeSessionV2(appt._id.toString(), {
      addToBalance: true,
      balanceAmount: 300,
      balanceDescription: 'Teste fiado idempotente',
      correlationId: `idemp_balance_call_1_${Date.now()}`
    });

    await completeSessionV2(appt._id.toString(), {
      addToBalance: true,
      balanceAmount: 300,
      balanceDescription: 'Teste fiado idempotente',
      correlationId: `idemp_balance_call_2_${Date.now()}`
    });

    const balance = await PatientBalance.findOne({ patient: testPatient._id });
    const debitTransactions = balance?.transactions?.filter(t => t.type === 'debit') || [];
    const relevantDebits = debitTransactions.filter(t =>
      t.appointmentId?.toString() === appt._id.toString()
    );

    expect(relevantDebits.length).toBe(1);

    await PatientBalance.deleteOne({ patient: testPatient._id });
    await Session.deleteOne({ _id: session._id });
    await Appointment.deleteOne({ _id: appt._id });
  }, 30000);
});
