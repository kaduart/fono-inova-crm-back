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
      paymentType: 'per-session',
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

  it('InsuranceGuide inactivate CANCELA (nunca deleta) appointment futuro pendente e marca guia/pacote vinculado como canceled/cancelled corretos', async () => {
    // 🚨 Contrato mudou (2026-08-14, achado real guia 16173377/Ícaro): a rota
    // fazia hard-delete de Appointment/Session/Payment sem transação e sem
    // histórico. Agora usa cancelInsuranceGuideCascade — cancela preservando
    // registro (mesmo padrão do resto do domínio: nunca hard-delete de agenda).
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
      patient: patient._id, appointment: futureAppt._id, session: futureSession._id, insuranceGuide: guide._id,
      status: 'pending', kind: 'appointment_payment', amount: 130,
      paymentDate: new Date('2026-09-15'), paymentMethod: 'convenio',
    });
    await Appointment.findByIdAndUpdate(futureAppt._id, { session: futureSession._id, payment: futurePayment._id });

    const res = await request(app).post(`/api/v2/insurance-guides/${guide._id}/inactivate`).send();
    expect(res.status).toBe(200);

    const guideAfter = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfter.status).toBe('cancelled'); // grafia própria da InsuranceGuide — está no enum dela, não mexer

    const apptAfter = await Appointment.findById(futureAppt._id).lean();
    expect(apptAfter).not.toBeNull(); // nunca hard-delete
    expect(apptAfter.operationalStatus).toBe('canceled');

    const sessionAfter = await Session.findById(futureSession._id).lean();
    expect(sessionAfter).not.toBeNull();
    expect(sessionAfter.status).toBe('canceled');

    const paymentAfter = await Payment.findById(futurePayment._id).lean();
    expect(paymentAfter).not.toBeNull();
    expect(paymentAfter.status).toBe('canceled');
  });

  it('InsuranceGuide inactivate CANCELA appointment PASSADO com status missed (bug real: rota antiga só olhava date >= hoje)', async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();

    const guide = await InsuranceGuide.create({
      number: `GUIA-MISSED-${Date.now()}`,
      patientId: patient._id,
      specialty: 'fonoaudiologia',
      insurance: 'unimed',
      totalSessions: 10,
      usedSessions: 3,
      expiresAt: new Date('2027-01-01'),
    });

    // Passado, marcado 'missed' por auto-expiração — exatamente o caso real
    // que ficava intocado e continuava bloqueando o horário depois da guia
    // cancelada (checkSlotConflicts via outra guia/plano).
    const missedAppt = await Appointment.create({
      patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
      date: new Date('2026-01-10'), time: '15:20', duration: 40, specialty: 'terapia_ocupacional',
      serviceType: 'individual_session', operationalStatus: 'missed', clinicalStatus: 'missed',
      billingType: 'convenio', paymentMethod: 'convenio', sessionValue: 80, insuranceGuide: guide._id,
      history: [{ action: 'auto_expired', newStatus: 'missed', timestamp: new Date('2026-01-10T19:30:00Z'), context: 'operacional' }],
    });
    // Session não tem status 'missed' no schema (enum: pending/completed/canceled/
    // scheduled) — o conceito de "faltou" vive só em Appointment.operationalStatus.
    const missedSession = await Session.create({
      patient: patient._id, doctor: doctor._id, appointmentId: missedAppt._id, insuranceGuide: guide._id,
      status: 'scheduled', sessionType: 'terapia_ocupacional', specialty: 'terapia_ocupacional',
      date: new Date('2026-01-10'), time: '15:20', sessionValue: 80,
    });
    const missedPayment = await Payment.create({
      patient: patient._id, appointment: missedAppt._id, session: missedSession._id, insuranceGuide: guide._id,
      status: 'pending', kind: 'appointment_payment', billingType: 'convenio', amount: 0,
      paymentDate: new Date('2026-01-10'), paymentMethod: 'convenio',
    });
    await Appointment.findByIdAndUpdate(missedAppt._id, { session: missedSession._id, payment: missedPayment._id });

    // Já concluída — precisa continuar intocada, e usedSessions não pode mudar
    const completedAppt = await Appointment.create({
      patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
      date: new Date('2026-01-03'), time: '15:20', duration: 40, specialty: 'terapia_ocupacional',
      serviceType: 'individual_session', operationalStatus: 'completed', clinicalStatus: 'completed',
      billingType: 'convenio', paymentMethod: 'convenio', sessionValue: 80, insuranceGuide: guide._id,
      _fromCompleteService: true,
    });

    const res = await request(app).post(`/api/v2/insurance-guides/${guide._id}/inactivate`).send();
    expect(res.status).toBe(200);
    expect(res.body.data.appointmentsCanceled).toBe(1); // só o missed — completed não conta

    const missedApptAfter = await Appointment.findById(missedAppt._id).lean();
    expect(missedApptAfter.operationalStatus).toBe('canceled'); // libera o horário de vez
    expect(missedApptAfter.cancelSource).toBe('guide_closure');

    const missedSessionAfter = await Session.findById(missedSession._id).lean();
    expect(missedSessionAfter.status).toBe('canceled');

    const missedPaymentAfter = await Payment.findById(missedPayment._id).lean();
    expect(missedPaymentAfter.status).toBe('canceled');

    const completedApptAfter = await Appointment.findById(completedAppt._id).lean();
    expect(completedApptAfter.operationalStatus).toBe('completed'); // intocada

    const guideAfter = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfter.status).toBe('cancelled');
    expect(guideAfter.usedSessions).toBe(3); // nunca decrementado
  });

  it('InsuranceGuide inactivate BLOQUEIA a cascata inteira se qualquer appointment tiver Payment faturado/pago/parcial (zero mutação)', async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();

    const guide = await InsuranceGuide.create({
      number: `GUIA-BLOQUEIO-${Date.now()}`,
      patientId: patient._id,
      specialty: 'fonoaudiologia',
      insurance: 'unimed',
      totalSessions: 10,
      expiresAt: new Date('2027-01-01'),
    });

    const billedAppt = await Appointment.create({
      patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
      date: new Date('2026-01-10'), time: '15:20', duration: 40, specialty: 'terapia_ocupacional',
      serviceType: 'individual_session', operationalStatus: 'missed', clinicalStatus: 'missed',
      billingType: 'convenio', paymentMethod: 'convenio', sessionValue: 80, insuranceGuide: guide._id,
    });
    await Payment.create({
      patient: patient._id, appointment: billedAppt._id, insuranceGuide: guide._id,
      status: 'billed', kind: 'appointment_payment', billingType: 'convenio', amount: 80,
      insurance: { provider: 'unimed', status: 'billed', billedAt: new Date() },
      paymentDate: new Date('2026-01-10'), paymentMethod: 'convenio',
    });

    const res = await request(app).post(`/api/v2/insurance-guides/${guide._id}/inactivate`).send();
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('GUIDE_CANCEL_BLOCKED_NON_REVERSIBLE_PAYMENT');

    // Zero mutação: nada mudou
    const guideAfter = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfter.status).not.toBe('cancelled');
    const apptAfter = await Appointment.findById(billedAppt._id).lean();
    expect(apptAfter.operationalStatus).toBe('missed');
  });

  it('InsuranceGuide inactivate REPARA órfãos numa guia JÁ cancelled em vez de retornar 400 sem processar nada (caso real guia 16173377)', async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();

    // Guia já 'cancelled' pelo fluxo antigo (que não cancelava appointment
    // nenhum) — simula exatamente o estado real da guia 16173377/Ícaro.
    const guide = await InsuranceGuide.create({
      number: `GUIA-JA-CANCELLED-${Date.now()}`,
      patientId: patient._id,
      specialty: 'terapia_ocupacional',
      insurance: 'unimed',
      totalSessions: 10,
      usedSessions: 8,
      status: 'cancelled',
      expiresAt: new Date('2027-01-01'),
    });

    const orphanAppt = await Appointment.create({
      patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
      date: new Date('2026-07-31'), time: '15:20', duration: 40, specialty: 'terapia_ocupacional',
      serviceType: 'individual_session', operationalStatus: 'missed', clinicalStatus: 'missed',
      billingType: 'convenio', paymentMethod: 'convenio', sessionValue: 80, insuranceGuide: guide._id,
    });
    const orphanSession = await Session.create({
      patient: patient._id, doctor: doctor._id, appointmentId: orphanAppt._id, insuranceGuide: guide._id,
      status: 'scheduled', sessionType: 'terapia_ocupacional', specialty: 'terapia_ocupacional',
      date: new Date('2026-07-31'), time: '15:20', sessionValue: 80,
    });
    const orphanPayment = await Payment.create({
      patient: patient._id, appointment: orphanAppt._id, session: orphanSession._id, insuranceGuide: guide._id,
      status: 'pending', kind: 'appointment_payment', billingType: 'convenio', amount: 0,
      paymentDate: new Date('2026-07-31'), paymentMethod: 'convenio',
    });
    await Appointment.findByIdAndUpdate(orphanAppt._id, { session: orphanSession._id, payment: orphanPayment._id });

    // 8 completed, intocadas
    const completedAppts = [];
    for (let i = 0; i < 8; i++) {
      completedAppts.push(await Appointment.create({
        patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
        date: new Date(2026, 5, 1 + i), time: '15:20', duration: 40, specialty: 'terapia_ocupacional',
        serviceType: 'individual_session', operationalStatus: 'completed', clinicalStatus: 'completed',
        billingType: 'convenio', paymentMethod: 'convenio', sessionValue: 80, insuranceGuide: guide._id,
        _fromCompleteService: true,
      }));
    }

    const res = await request(app).post(`/api/v2/insurance-guides/${guide._id}/inactivate`).send();
    expect(res.status).toBe(200); // não retorna 400 ALREADY_CANCELLED
    expect(res.body.data.appointmentsCanceled).toBe(1); // só o órfão

    const orphanApptAfter = await Appointment.findById(orphanAppt._id).lean();
    expect(orphanApptAfter.operationalStatus).toBe('canceled');
    const orphanSessionAfter = await Session.findById(orphanSession._id).lean();
    expect(orphanSessionAfter.status).toBe('canceled');
    const orphanPaymentAfter = await Payment.findById(orphanPayment._id).lean();
    expect(orphanPaymentAfter.status).toBe('canceled');

    for (const c of completedAppts) {
      const after = await Appointment.findById(c._id).lean();
      expect(after.operationalStatus).toBe('completed'); // nenhuma das 8 tocada
    }

    const guideAfter = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfter.status).toBe('cancelled');
    expect(guideAfter.usedSessions).toBe(8); // preservado
  });

  it('DELETE /:id usa a mesma cascata do /inactivate (antes só setava status, sem tocar em nada)', async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();

    const guide = await InsuranceGuide.create({
      number: `GUIA-DELETE-${Date.now()}`,
      patientId: patient._id,
      specialty: 'fonoaudiologia',
      insurance: 'unimed',
      totalSessions: 10,
      expiresAt: new Date('2027-01-01'),
    });
    const missedAppt = await Appointment.create({
      patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
      date: new Date('2026-01-10'), time: '15:20', duration: 40, specialty: 'terapia_ocupacional',
      serviceType: 'individual_session', operationalStatus: 'missed', clinicalStatus: 'missed',
      billingType: 'convenio', paymentMethod: 'convenio', sessionValue: 80, insuranceGuide: guide._id,
    });

    const res = await request(app).delete(`/api/v2/insurance-guides/${guide._id}`).send();
    expect(res.status).toBe(200);

    const apptAfter = await Appointment.findById(missedAppt._id).lean();
    expect(apptAfter.operationalStatus).toBe('canceled');
  });
});
