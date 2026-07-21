/**
 * 🧪 Regressão — PR2: helpers de cancelamento em massa (domain/appointment|session|payment)
 *
 * Cobre POST /v2/packages/:id/inactivate e POST /v2/insurance-guides/:id/inactivate
 * depois da extração para domain/{appointment,session,payment}/cancel*.js.
 *
 * Trava especificamente o bug encontrado nesta auditoria: a rota de pacote escrevia
 * `status: 'canceled'` no Appointment.updateMany, mas o schema não tem campo `status`
 * (só operationalStatus/clinicalStatus) — Mongoose descartava o valor em silêncio
 * (strict mode), então o slot nunca era liberado apesar da API reportar sucesso.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';

vi.mock('../../middleware/amandaAuth.js', () => ({
  flexibleAuth: (req, res, next) => {
    req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin' };
    next();
  },
}));
vi.mock('../../middleware/auth.js', () => ({
  auth: (req, res, next) => {
    req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin' };
    next();
  },
  authorize: () => (req, res, next) => next(),
}));
vi.mock('../../config/socket.js', () => ({
  getIo: vi.fn().mockReturnValue({ emit: vi.fn() }),
  initializeSocket: vi.fn(),
}));

let mongoServer, app;
let Patient, Doctor, Package, Session, Payment, Appointment, PackagesView, InsuranceGuide;
let buildPackageView;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  await import('../../models/PatientsView.js');
  await import('../../models/PatientBalance.js');
  await import('../../models/FinancialLedger.js');
  await import('../../models/MedicalEvent.js');
  await import('../../models/FinancialEvent.js');
  await import('../../models/InsuranceGuideView.js');
  await import('../../models/InsurancePlan.js');

  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Package = (await import('../../models/Package.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Payment = (await import('../../models/Payment.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  PackagesView = (await import('../../models/PackagesView.js')).default;
  InsuranceGuide = (await import('../../models/InsuranceGuide.js')).default;

  buildPackageView = (await import('../../domains/billing/services/PackageProjectionService.js')).buildPackageView;

  app = express();
  app.use(express.json());
  app.use('/api/v2/packages', (await import('../../routes/package.v2.js')).default);
  app.use('/api/v2/insurance-guides', (await import('../../routes/insuranceGuides.v2.js')).default);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const collections = ['appointments', 'sessions', 'payments', 'packages', 'patients', 'doctors', 'packagesviews', 'insuranceguides'];
  for (const name of collections) {
    try { await mongoose.connection.collection(name).deleteMany({}); } catch (e) { /* ignore */ }
  }
});

async function createPatient() {
  return Patient.create({ fullName: 'Paciente PR2', phone: '62999999999', dateOfBirth: '2015-01-01' });
}

async function createDoctor() {
  const suffix = Math.random().toString(36).substring(7);
  return Doctor.create({
    fullName: 'Dr. PR2',
    specialty: 'fonoaudiologia',
    email: `dr_${suffix}@teste.com`,
    licenseNumber: `CRM-${suffix}`,
    phoneNumber: '62999999999',
  });
}

describe('PR2 — helpers de inativação (regressão)', () => {
  it('Package inactivate cancela pendências, preserva concluídas e LIBERA o slot do appointment futuro', async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();

    const pkg = await Package.create({
      durationMonths: 1,
      sessionsPerWeek: 1,
      patient: patient._id,
      doctor: doctor._id,
      sessionType: 'fonoaudiologia',
      specialty: 'fonoaudiologia',
      date: new Date(),
      totalValue: 800,
      totalSessions: 5,
    });

    // já realizada — não pode ser tocada
    const completedAppt = await Appointment.create({
      patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
      date: new Date('2026-01-10'), time: '09:00', duration: 40, specialty: 'fonoaudiologia',
      serviceType: 'package_session', operationalStatus: 'completed', clinicalStatus: 'completed',
      paymentOrigin: 'package_prepaid', billingType: 'particular', sessionValue: 160, package: pkg._id,
      _fromCompleteService: true,
    });
    await Session.create({
      patient: patient._id, doctor: doctor._id, package: pkg._id, appointmentId: completedAppt._id,
      status: 'completed', sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date('2026-01-10'), time: '09:00', sessionValue: 160,
    });

    // futura/pendente — deve cancelar e liberar o slot
    const scheduledAppt = await Appointment.create({
      patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
      date: new Date('2026-09-10'), time: '09:00', duration: 40, specialty: 'fonoaudiologia',
      serviceType: 'package_session', operationalStatus: 'scheduled', clinicalStatus: 'pending',
      paymentOrigin: 'package_prepaid', billingType: 'particular', sessionValue: 160, package: pkg._id,
    });
    const scheduledSession = await Session.create({
      patient: patient._id, doctor: doctor._id, package: pkg._id, appointmentId: scheduledAppt._id,
      status: 'scheduled', sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date('2026-09-10'), time: '09:00', sessionValue: 160,
    });
    const pendingPayment = await Payment.create({
      patient: patient._id, package: pkg._id, appointment: scheduledAppt._id,
      status: 'pending', kind: 'package_payment', amount: 160,
      paymentDate: new Date('2026-09-10'), paymentMethod: 'pix',
    });

    await buildPackageView(pkg._id.toString(), { force: true });
    const view = await PackagesView.findOne({ packageId: pkg._id }).lean();
    expect(view).toBeTruthy();

    const res = await request(app).post(`/api/v2/packages/${view._id}/inactivate`).send();
    expect(res.status).toBe(200);

    const pkgAfter = await Package.findById(pkg._id).lean();
    expect(pkgAfter.status).toBe('canceled');

    const scheduledApptAfter = await Appointment.findById(scheduledAppt._id).lean();
    expect(scheduledApptAfter.operationalStatus).toBe('canceled'); // 🔒 regressão do bug de campo (slot liberado)

    const completedApptAfter = await Appointment.findById(completedAppt._id).lean();
    expect(completedApptAfter.operationalStatus).toBe('completed'); // preservado

    const scheduledSessionAfter = await Session.findById(scheduledSession._id).lean();
    expect(scheduledSessionAfter.status).toBe('canceled');

    const pendingPaymentAfter = await Payment.findById(pendingPayment._id).lean();
    expect(pendingPaymentAfter.status).toBe('canceled');
  });

  it('InsuranceGuide inactivate deleta appointment futuro (com filhos) e marca guia/pacote vinculado como canceled/cancelled corretos', async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();

    const guide = await InsuranceGuide.create({
      number: `GUIA-${Date.now()}`,
      patientId: patient._id,
      specialty: 'fonoaudiologia',
      insurance: 'unimed',
      totalSessions: 10,
      expiresAt: new Date('2027-01-01'),
    });

    const futureAppt = await Appointment.create({
      patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
      date: new Date('2026-09-15'), time: '10:00', duration: 40, specialty: 'fonoaudiologia',
      serviceType: 'individual_session', operationalStatus: 'scheduled', clinicalStatus: 'pending',
      paymentOrigin: 'convenio', billingType: 'convenio', sessionValue: 130, insuranceGuide: guide._id,
    });
    const futureSession = await Session.create({
      patient: patient._id, doctor: doctor._id, appointmentId: futureAppt._id, insuranceGuide: guide._id,
      status: 'scheduled', sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date('2026-09-15'), time: '10:00', sessionValue: 130,
    });
    const futurePayment = await Payment.create({
      patient: patient._id, appointment: futureAppt._id, insuranceGuide: guide._id,
      status: 'pending', kind: 'appointment_payment', amount: 130,
      paymentDate: new Date('2026-09-15'), paymentMethod: 'convenio',
    });

    const res = await request(app).post(`/api/v2/insurance-guides/${guide._id}/inactivate`).send();
    expect(res.status).toBe(200);

    const guideAfter = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfter.status).toBe('cancelled'); // grafia própria da InsuranceGuide — está no enum dela, não mexer

    const apptAfter = await Appointment.findById(futureAppt._id).lean();
    expect(apptAfter).toBeNull(); // comportamento preservado: convênio deleta futuro, não soft-cancela

    const sessionAfter = await Session.findById(futureSession._id).lean();
    expect(sessionAfter).toBeNull();

    const paymentAfter = await Payment.findById(futurePayment._id).lean();
    expect(paymentAfter).toBeNull();
  });
});
