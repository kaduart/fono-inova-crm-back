/**
 * 🧪 Testes de regressão — Patient delete cascade
 *
 * Garante que a deleção de um Patient remove em cascata todos os dados
 * vinculados: payments, appointments, sessions, packages, balances e ledgers.
 *
 * Motivação: incidente 2026-07-29 onde a deleção de pacientes pelo
 * controller/worker deletava apenas Patient e PatientsView, deixando
 * payments órfãos que inflavam o caixa.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';

vi.mock('../../config/socket.js', () => ({
  getIo: vi.fn().mockReturnValue({ emit: vi.fn() }),
  initializeSocket: vi.fn(),
}));

let Patient, PatientsView, Doctor, Appointment, Session, Payment, Package, PatientBalance;
let deletePatientCommand;
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  await import('../../models/PatientsView.js');

  Patient = (await import('../../models/Patient.js')).default;
  PatientsView = (await import('../../models/PatientsView.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Payment = (await import('../../models/Payment.js')).default;
  Package = (await import('../../models/Package.js')).default;
  PatientBalance = (await import('../../models/PatientBalance.js')).default;

  deletePatientCommand = await import('../../domains/patient/commands/deletePatientCommand.js');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Patient.deleteMany({});
  await PatientsView.deleteMany({});
  await Doctor.deleteMany({});
  await Appointment.deleteMany({});
  await Session.deleteMany({});
  await Payment.deleteMany({});
  await Package.deleteMany({});
  await PatientBalance.deleteMany({});
});

async function createDoctor(overrides = {}) {
  return Doctor.create({
    fullName: 'Dra. Teste Cascade',
    email: `doc_${Date.now()}_${Math.random()}@teste.com`,
    phoneNumber: '62999999999',
    licenseNumber: `CRFA-${Math.floor(Math.random() * 100000)}`,
    specialty: 'fonoaudiologia',
    active: true,
    ...overrides,
  });
}

async function createPatient(overrides = {}) {
  return Patient.create({
    fullName: 'Paciente Teste Cascade',
    phone: '11999998888',
    dateOfBirth: '1990-05-15',
    ...overrides,
  });
}

describe('deletePatientCommand', () => {
  it('deve remover patient e todos os dados vinculados em cascata', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();

    const pkg = await Package.create({
      patient: patient._id,
      doctor: doctor._id,
      specialty: 'fonoaudiologia',
      sessionType: 'fonoaudiologia',
      durationMonths: 3,
      sessionsPerWeek: 1,
      totalSessions: 10,
      totalValue: 1800,
      date: new Date('2026-08-01'),
      time: '10:00',
      status: 'active',
    });

    const appointment = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      date: '2026-08-01',
      time: '10:00',
      specialty: 'fonoaudiologia',
      sessionType: 'fonoaudiologia',
      serviceType: 'session',
      package: pkg._id,
      operationalStatus: 'scheduled',
      billingType: 'particular',
    });

    const session = await Session.create({
      appointmentId: appointment._id,
      patient: patient._id,
      doctor: doctor._id,
      date: '2026-08-01',
      time: '10:00',
      sessionType: 'fonoaudiologia',
      serviceType: 'session',
      package: pkg._id,
      status: 'scheduled',
    });

    const payment = await Payment.create({
      patient: patient._id,
      doctor: doctor._id,
      appointment: appointment._id,
      session: session._id,
      package: pkg._id,
      amount: 180,
      paymentDate: new Date('2026-08-01'),
      paidAt: new Date('2026-08-01'),
      financialDate: new Date('2026-08-01'),
      paymentMethod: 'pix',
      status: 'paid',
      billingType: 'particular',
      kind: 'session_payment',
    });

    const balance = await PatientBalance.create({
      patient: patient._id,
      currentBalance: 0,
      totalCredited: 0,
      totalDebited: 0,
      transactions: [],
    });

    const view = await PatientsView.create({
      patientId: patient._id,
      fullName: patient.fullName,
      normalizedName: patient.fullName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      snapshot: { calculatedAt: new Date() },
    });

    // Executa a deleção
    const result = await deletePatientCommand.execute(patient._id, {
      reason: 'test_regression',
    });

    expect(result.deleted).toBe(true);
    expect(result.counts.patient).toBe(1);
    expect(result.counts.payments).toBe(1);
    expect(result.counts.appointments).toBe(1);
    expect(result.counts.sessions).toBe(1);
    expect(result.counts.packages).toBe(1);
    expect(result.counts.patientBalances).toBe(1);
    expect(result.counts.financialLedgers).toBe(0);
    expect(result.counts.patientsView).toBe(1);

    // Verifica que nada ficou órfão
    expect(await Patient.findById(patient._id)).toBeNull();
    expect(await PatientsView.findById(view._id)).toBeNull();
    expect(await Payment.findById(payment._id)).toBeNull();
    expect(await Appointment.findById(appointment._id)).toBeNull();
    expect(await Session.findById(session._id)).toBeNull();
    expect(await Package.findById(pkg._id)).toBeNull();
    expect(await PatientBalance.findById(balance._id)).toBeNull();
  });

  it('deve lançar erro 404 quando patient não existe', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    await expect(
      deletePatientCommand.execute(fakeId, { reason: 'test_not_found' })
    ).rejects.toThrow('Paciente não encontrado');
  });
});
