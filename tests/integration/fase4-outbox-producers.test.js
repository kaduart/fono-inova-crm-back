/**
 * Fase 4 — Testes de integração dos producers migrados para o Outbox
 *
 * Valida que os commands de baixo risco da Fase 4 salvam eventos canônicos
 * no Outbox dentro de uma transação MongoDB.
 *
 * Commands testados:
 *   - deleteAppointmentCommand  → APPOINTMENT_DELETED
 *   - deletePackageCommand      → PACKAGE_DELETED
 *   - expirePreAgendamentoCommand → APPOINTMENT_UPDATED
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// ─── MOCKS: Topo do arquivo (hoisted) ────────────────────────────────────────
vi.mock('../../config/socket.js', () => ({
  getIo: () => ({ emit: () => {}, to: () => ({ emit: () => {} }) }),
  initializeSocket: () => {},
  emitSocket: async () => {},
}));

vi.mock('../../config/redisConnection.js', () => ({
  redisConnection: { status: 'ready', on: () => {} }
}));

vi.mock('../../config/bullConfig.js', () => ({
  followupQueue:         { add: async () => ({}), on: () => {} },
  followupEvents:        { on: () => {} },
  videoGenerationQueue:  { add: async () => ({}), on: () => {} },
  videoGenerationEvents: { on: () => {} }
}));

vi.mock('../../services/journeyFollowupEngine.js', () => ({
  runJourneyFollowups: async () => {}
}));

vi.mock('../../services/sicoobService.js', () => ({
  registerWebhook: async () => {}
}));

vi.mock('../../services/syncService.js', () => ({
  syncEvent: async () => {}
}));

// ─── SETUP ───────────────────────────────────────────────────────────────────
let mongoServer;
let Patient, Doctor, Appointment, Session, Payment, Package, PatientBalance, PackagesView, Outbox;
let deleteAppointmentCommand, deletePackageCommand, expirePreAgendamentoCommand;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  Patient     = (await import('../../models/Patient.js')).default;
  Doctor      = (await import('../../models/Doctor.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  Session     = (await import('../../models/Session.js')).default;
  Payment     = (await import('../../models/Payment.js')).default;
  Package     = (await import('../../models/Package.js')).default;
  PatientBalance = (await import('../../models/PatientBalance.js')).default;
  PackagesView   = (await import('../../models/PackagesView.js')).default;
  Outbox         = (await import('../../infrastructure/outbox/OutboxModel.js')).default;

  deleteAppointmentCommand   = await import('../../services/appointment/commands/deleteAppointmentCommand.js');
  deletePackageCommand       = await import('../../services/billing/commands/deletePackageCommand.js');
  expirePreAgendamentoCommand = await import('../../services/appointment/commands/expirePreAgendamentoCommand.js');
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 30_000);

beforeEach(async () => {
  const cols = mongoose.connection.collections;
  for (const key in cols) await cols[key].deleteMany({});
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function seedPatientAndDoctor() {
  const patient = await Patient.create({
    fullName: 'Paciente Fase 4',
    phone: '62999990001',
    dateOfBirth: new Date('2010-01-15')
  });
  const doctor = await Doctor.create({
    fullName: 'Dr. Fase 4',
    specialty: 'fonoaudiologia',
    phoneNumber: '62999990002',
    licenseNumber: 'CRM-GO-99999',
    email: 'dr.fase4@teste.com'
  });
  return { patient, doctor };
}

// ─── TESTES: deleteAppointmentCommand ────────────────────────────────────────
describe('deleteAppointmentCommand → APPOINTMENT_DELETED', () => {
  it('deleta appointment sem pacote e registra APPOINTMENT_DELETED no Outbox', async () => {
    const { patient, doctor } = await seedPatientAndDoctor();

    const appointment = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      date: '2026-08-10',
      time: '09:00',
      specialty: 'fonoaudiologia',
      serviceType: 'individual_session',
      billingType: 'particular',
      paymentMethod: 'pix',
      amount: 200,
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',
    });

    const payment = await Payment.create({
      patient: patient._id,
      appointment: appointment._id,
      amount: 200,
      paymentMethod: 'pix',
      paymentDate: new Date('2026-08-10'),
      status: 'pending',
      source: 'appointment',
    });

    appointment.payment = payment._id;
    await appointment.save();

    await patient.updateOne({ $push: { appointments: appointment._id } });

    const result = await deleteAppointmentCommand.execute(appointment._id, { _id: patient._id, role: 'admin' });

    expect(result.data.deletedId.toString()).toBe(appointment._id.toString());

    const deleted = await Appointment.findById(appointment._id);
    expect(deleted).toBeNull();

    const outbox = await Outbox.findOne({ eventType: 'APPOINTMENT_DELETED' }).lean();
    expect(outbox).toBeTruthy();
    expect(outbox.aggregateType).toBe('appointment');
    expect(outbox.aggregateId).toBe(appointment._id.toString());
    expect(outbox.payload.appointmentId).toBe(appointment._id.toString());
    expect(outbox.payload.patientId).toBe(patient._id.toString());
    expect(outbox.status).toBe('pending');
  });

  it('rejeita deleção de appointment vinculado a pacote', async () => {
    const { patient, doctor } = await seedPatientAndDoctor();
    const pkg = await Package.create({
      patient: patient._id,
      doctor: doctor._id,
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
      date: new Date('2026-08-10'),
      sessionsPerWeek: 1,
      durationMonths: 1,
    });

    const appointment = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      package: pkg._id,
      date: '2026-08-10',
      time: '09:00',
      specialty: 'fonoaudiologia',
      serviceType: 'package_session',
      billingType: 'particular',
      paymentMethod: 'pix',
      amount: 0,
      operationalStatus: 'scheduled',
    });

    await expect(
      deleteAppointmentCommand.execute(appointment._id, { _id: patient._id, role: 'admin' })
    ).rejects.toMatchObject({
      status: 400,
      code: 'PACKAGE_APPOINTMENT_DELETE_BLOCKED',
    });
  });
});

// ─── TESTES: deletePackageCommand ────────────────────────────────────────────
describe('deletePackageCommand → PACKAGE_DELETED', () => {
  it('deleta pacote, ajusta PatientBalance e registra PACKAGE_DELETED no Outbox', async () => {
    const { patient, doctor } = await seedPatientAndDoctor();

    const pkg = await Package.create({
      patient: patient._id,
      doctor: doctor._id,
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
      date: new Date('2026-08-10'),
      sessionsPerWeek: 1,
      durationMonths: 1,
    });

    const view = await PackagesView.create({
      packageId: pkg._id,
      patientId: patient._id,
      doctorId: doctor._id,
      status: 'active',
      type: 'therapy',
      specialty: 'fonoaudiologia',
      totalSessions: 5,
      sessionsDone: 0,
    });

    const appointment = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      package: pkg._id,
      date: '2026-08-10',
      time: '09:00',
      specialty: 'fonoaudiologia',
      serviceType: 'package_session',
      billingType: 'particular',
      paymentMethod: 'pix',
      amount: 0,
      operationalStatus: 'scheduled',
    });

    const balance = await PatientBalance.create({
      patient: patient._id,
      currentBalance: 800,
      totalCredited: 1000,
      totalDebited: 200,
      transactions: [
        {
          type: 'credit',
          amount: 1000,
          description: 'Crédito do pacote',
          settledByPackageId: pkg._id,
          isPaid: true,
        },
        {
          type: 'debit',
          amount: 200,
          description: 'Débito de sessão',
          isPaid: true,
        },
      ],
    });

    const result = await deletePackageCommand.execute(pkg._id, { _id: patient._id, role: 'admin' });

    expect(result.data.deleted).toBe(true);
    expect(result.data.packageId).toBe(pkg._id.toString());

    expect(await Package.findById(pkg._id)).toBeNull();
    expect(await Appointment.findById(appointment._id)).toBeNull();
    expect(await PackagesView.findById(view._id)).toBeNull();

    const balanceAfter = await PatientBalance.findById(balance._id).lean();
    expect(balanceAfter.transactions.some(t => t.isDeleted)).toBe(true);

    const outbox = await Outbox.findOne({ eventType: 'PACKAGE_DELETED' }).lean();
    expect(outbox).toBeTruthy();
    expect(outbox.aggregateType).toBe('package');
    expect(outbox.aggregateId).toBe(pkg._id.toString());
    expect(outbox.payload.packageId).toBe(pkg._id.toString());
    expect(outbox.payload.patientId).toBe(patient._id.toString());
  });
});

// ─── TESTES: expirePreAgendamentoCommand ─────────────────────────────────────
describe('expirePreAgendamentoCommand → APPOINTMENT_UPDATED', () => {
  it('expira pré-agendamento e registra APPOINTMENT_UPDATED no Outbox', async () => {
    const { patient, doctor } = await seedPatientAndDoctor();

    const appointment = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      date: '2026-08-10',
      time: '09:00',
      specialty: 'fonoaudiologia',
      serviceType: 'individual_session',
      billingType: 'particular',
      paymentMethod: 'pix',
      operationalStatus: 'pre_agendado',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',
    });

    const result = await expirePreAgendamentoCommand.execute(appointment._id, {
      reason: 'Teste Fase 4',
      correlationId: 'fase4_test_expire',
    });

    expect(result.expired).toBe(true);

    const updated = await Appointment.findById(appointment._id).lean();
    expect(updated.operationalStatus).toBe('missed');

    const outbox = await Outbox.findOne({ eventType: 'APPOINTMENT_UPDATED' }).lean();
    expect(outbox).toBeTruthy();
    expect(outbox.aggregateType).toBe('appointment');
    expect(outbox.aggregateId).toBe(appointment._id.toString());
    expect(outbox.payload.newStatus).toBe('missed');
    expect(outbox.payload.previousStatus).toBe('pre_agendado');
    expect(outbox.payload.reason).toBe('auto_expired');
  });

  it('é idempotente para pré-agendamentos já expirados', async () => {
    const { patient, doctor } = await seedPatientAndDoctor();

    const appointment = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      date: '2026-08-10',
      time: '09:00',
      specialty: 'fonoaudiologia',
      serviceType: 'individual_session',
      operationalStatus: 'missed',
      clinicalStatus: 'missed',
    });

    const result = await expirePreAgendamentoCommand.execute(appointment._id);

    expect(result.expired).toBe(false);
    expect(result.message).toContain('já estava expirado');
  });
});
