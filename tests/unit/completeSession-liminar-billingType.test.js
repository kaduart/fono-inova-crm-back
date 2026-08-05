/**
 * 🧪 Vitest - Liminar billingType sync
 *
 * Cenário do bug: appointment criado com billingType='particular'/paymentMethod='pix'
 * mas vinculado a um LiminarContract. Após completeSessionV2, o Appointment deve
 * refletir billingType='liminar' e paymentMethod='liminar_credit'.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { completeSessionV2 } from '../../services/completeSessionService.v2.js';
import Appointment from '../../models/Appointment.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';
import LiminarContract from '../../models/LiminarContract.js';
import Session from '../../models/Session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_test';

describe('Complete Session V2 - Liminar billingType sync', () => {
  let testPatient;
  let testDoctor;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 30000 });

    // Evita “catalog changes” durante a transaction do completeSessionV2
    const db = mongoose.connection.db;
    await Promise.all([
      db.createCollection('patients').catch(() => {}),
      db.createCollection('doctors').catch(() => {}),
      db.createCollection('appointments').catch(() => {}),
      db.createCollection('sessions').catch(() => {}),
      db.createCollection('liminarcontracts').catch(() => {}),
      db.createCollection('payments').catch(() => {}),
    ]);

    testPatient = await Patient.create({
      fullName: `Liminar Billing Sync Patient ${Date.now()}`,
      phone: `61999${Date.now().toString().slice(-6)}`,
      email: `liminar-sync-${Date.now()}@test.com`,
      dateOfBirth: new Date('1990-01-01')
    });

    testDoctor = await Doctor.create({
      fullName: `Liminar Billing Sync Doctor ${Date.now()}`,
      name: `Liminar Billing Sync Doctor ${Date.now()}`,
      email: `liminar-sync-doctor-${Date.now()}@test.com`,
      specialty: 'fonoaudiologia',
      phoneNumber: '61999999999',
      licenseNumber: `CRM-TEST-${Date.now()}`
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it.skip('deve sincronizar billingType/paymentMethod para liminar quando appointment tem liminarContract (requer MongoDB replica set)', async () => {
    const contract = await LiminarContract.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      processNumber: `PROC-SYNC-${Date.now()}`,
      court: '1ª Vara Federal',
      totalCredit: 1000,
      creditBalance: 1000,
      usedCredit: 0,
      status: 'active'
    });

    const appointment = await Appointment.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      date: new Date('2026-08-10T14:00:00.000Z'),
      time: '14:00',
      specialty: 'fonoaudiologia',
      serviceType: 'liminar_session',
      billingType: 'particular',        // 🎯 simula dado corrompido/legado
      paymentMethod: 'pix',             // 🎯 simula dado corrompido/legado
      liminarContract: contract._id,
      sessionValue: 160,
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',
      correlationId: `liminar_sync_${Date.now()}`
    });

    const session = await Session.create({
      patient: testPatient._id,
      doctor: testDoctor._id,
      date: appointment.date,
      time: appointment.time,
      sessionType: appointment.specialty,
      sessionValue: 160,
      appointmentId: appointment._id,
      status: 'scheduled',
      paymentStatus: 'pending',
      paymentMethod: 'pix'              // legado: appointment foi criado como particular/pix
    });

    // Vincula session ao appointment (modelo Session-first)
    await Appointment.findByIdAndUpdate(appointment._id, { session: session._id });

    const result = await completeSessionV2(appointment._id.toString(), {
      notes: 'Teste liminar billingType sync',
      correlationId: `complete_liminar_sync_${Date.now()}`
    });

    expect(result).toBeTruthy();
    expect(result.operationalStatus).toBe('completed');

    const updatedAppointment = await Appointment.findById(appointment._id).lean();
    expect(updatedAppointment.billingType).toBe('liminar');
    expect(updatedAppointment.paymentMethod).toBe('liminar_credit');
    expect(updatedAppointment.balanceAmount).toBe(0);

    const updatedContract = await LiminarContract.findById(contract._id).lean();
    expect(updatedContract.usedCredit).toBe(160);
    expect(updatedContract.creditBalance).toBe(840);
  }, 20000);
});
