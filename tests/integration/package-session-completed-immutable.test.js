import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../config/socket.js', () => ({ getIo: () => ({ emit: vi.fn(), to: () => ({ emit: vi.fn() }) }) }));
vi.mock('../../services/syncService.js', () => ({
  syncEvent: vi.fn().mockResolvedValue(undefined),
  handlePackageSessionUpdate: vi.fn(),
}));
vi.mock('../../services/auditLogService.js', () => ({ recordAudit: vi.fn() }));
vi.mock('../../infrastructure/outbox/outboxPattern.js', () => ({ saveToOutbox: vi.fn() }));
vi.mock('../../projections/paymentsProjection.js', () => ({ handlePaymentEvent: vi.fn() }));

let replSet;
let Appointment;
let Patient;
let Doctor;
let execute;
let Package;
let Session;
let completeSessionV2;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  Appointment = (await import('../../models/Appointment.js')).default;
  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Package = (await import('../../models/Package.js')).default;
  Session = (await import('../../models/Session.js')).default;
  execute = (await import('../../services/appointment/commands/updateAppointmentCommand.js')).execute;
  completeSessionV2 = (await import('../../services/completeSessionService.v2.js')).completeSessionV2;
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
});

describe('updateAppointmentCommand — histórico de pacote concluído', () => {
  it('rejeita mudança de data/horário/profissional em package_session completed sem escrever', async () => {
    const patient = await Patient.create({ fullName: 'Paciente Imutável', phone: '62999990000', dateOfBirth: '2015-01-01' });
    const doctor = await Doctor.create({
      fullName: 'Dra. Imutável', specialty: 'fonoaudiologia', phoneNumber: '62999990001',
      licenseNumber: 'CRM-IMM-1', email: 'imutavel@teste.com',
    });
    const appointmentId = new mongoose.Types.ObjectId();
    await Appointment.collection.insertOne({
      _id: appointmentId,
      patient: patient._id,
      doctor: doctor._id,
      date: new Date('2026-08-20T03:00:00.000Z'),
      time: '10:00',
      duration: 40,
      specialty: 'fonoaudiologia',
      serviceType: 'package_session',
      billingType: 'particular',
      operationalStatus: 'completed',
      clinicalStatus: 'completed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(execute(appointmentId, { time: '11:00' }, { _id: new mongoose.Types.ObjectId(), role: 'admin' }))
      .rejects.toMatchObject({ status: 409, code: 'PACKAGE_SESSION_COMPLETED_IMMUTABLE' });

    const unchanged = await Appointment.findById(appointmentId).lean();
    expect(unchanged.time).toBe('10:00');
    expect(unchanged.operationalStatus).toBe('completed');
  });

  // 🚨 Regressão (2026-09-04): caso real Isis Caldas Rebelatto, pacote TO-3 —
  // reverter operationalStatus de 'completed' por este update genérico (sem
  // passar por cancelAppointmentCommand) deixava sessionsDone do pacote sem
  // desconto; completar de novo em seguida incrementava um segundo crédito
  // pra uma única sessão real (3 sessões reais viraram sessionsDone=4).
  it('rejeita reverter operationalStatus de completed pra outro status via update genérico', async () => {
    const patient = await Patient.create({ fullName: 'Paciente Reversão', phone: '62999990010', dateOfBirth: '2015-01-01' });
    const doctor = await Doctor.create({
      fullName: 'Dra. Reversão', specialty: 'fonoaudiologia', phoneNumber: '62999990011',
      licenseNumber: 'CRM-REV-1', email: 'reversao@teste.com',
    });
    const appointmentId = new mongoose.Types.ObjectId();
    await Appointment.collection.insertOne({
      _id: appointmentId,
      patient: patient._id,
      doctor: doctor._id,
      date: new Date('2026-08-20T03:00:00.000Z'),
      time: '10:00',
      duration: 40,
      specialty: 'fonoaudiologia',
      serviceType: 'package_session',
      billingType: 'particular',
      operationalStatus: 'completed',
      clinicalStatus: 'completed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(execute(appointmentId, { operationalStatus: 'scheduled' }, { _id: new mongoose.Types.ObjectId(), role: 'admin' }))
      .rejects.toMatchObject({ status: 409, code: 'FORBIDDEN_MANUAL_UNCOMPLETE' });

    const unchanged = await Appointment.findById(appointmentId).lean();
    expect(unchanged.operationalStatus).toBe('completed');
  });

  it('não conclui sessão vinculada a pacote inativo e libera o lock operacional', async () => {
    const patient = await Patient.create({ fullName: 'Paciente Inativo', phone: '62999990002', dateOfBirth: '2015-01-01' });
    const doctor = await Doctor.create({
      fullName: 'Dra. Inativa', specialty: 'fonoaudiologia', phoneNumber: '62999990003',
      licenseNumber: 'CRM-IMM-2', email: 'inativa@teste.com',
    });
    const pkg = await Package.create({
      durationMonths: 1, sessionsPerWeek: 1, patient: patient._id, doctor: doctor._id,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia', sessionValue: 100,
      totalSessions: 2, totalValue: 200, date: new Date('2026-08-20T03:00:00.000Z'),
      type: 'therapy', model: 'prepaid', status: 'canceled',
    });
    const appointmentId = new mongoose.Types.ObjectId();
    const sessionId = new mongoose.Types.ObjectId();
    await Session.collection.insertOne({
      _id: sessionId, appointmentId, package: pkg._id, patient: patient._id, doctor: doctor._id,
      date: new Date('2026-08-20T03:00:00.000Z'), time: '10:00', specialty: 'fonoaudiologia',
      sessionType: 'fonoaudiologia', status: 'scheduled', createdAt: new Date(), updatedAt: new Date(),
    });
    await Appointment.collection.insertOne({
      _id: appointmentId, patient: patient._id, doctor: doctor._id, package: pkg._id, session: sessionId,
      date: new Date('2026-08-20T03:00:00.000Z'), time: '10:00', duration: 40,
      specialty: 'fonoaudiologia', serviceType: 'package_session', billingType: 'particular',
      operationalStatus: 'scheduled', clinicalStatus: 'pending', createdAt: new Date(), updatedAt: new Date(),
    });

    await expect(completeSessionV2(appointmentId, { billingMeta: { billingType: 'particular' } }))
      .rejects.toMatchObject({ status: 409, code: 'PACKAGE_INACTIVE' });

    const unchanged = await Appointment.findById(appointmentId).lean();
    expect(unchanged.operationalStatus).toBe('scheduled');
    expect(unchanged.isProcessing).toBe(false);
  });
});
