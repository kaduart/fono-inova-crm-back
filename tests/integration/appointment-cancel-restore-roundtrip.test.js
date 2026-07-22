/**
 * 🛡️ Teste de invariante — cancelAppointmentCommand ⇄ restoreCanceledAppointmentCommand
 *
 * Prova que os dois comandos são simétricos: cancelar e depois reativar deve
 * devolver Session/Package/Payment ao estado anterior — EXCETO nos pontos
 * onde a assimetria é intencional e documentada (2026-07-22):
 *
 * - Session.status NUNCA reabre direto pra 'completed' — reativação sempre
 *   pousa em 'scheduled', mesmo que a sessão tivesse sido completada antes.
 * - Payment NUNCA volta pra 'paid' automaticamente — volta pra 'pending',
 *   exigindo confirmação financeira real de novo.
 *
 * Fora esses dois campos, tudo o mais (sessionsDone, totalPaid, paidSessions,
 * balance, financialStatus, arrays sessions/appointments do Package,
 * isPaid/partialAmount/paymentMethod/completedAt da Session) deve ser
 * idêntico entre o estado inicial e o estado pós-restore.
 *
 * Usa Mongo real em memória (MongoMemoryReplSet) — sem mocks — pra exercitar
 * os dois comandos de ponta a ponta contra documentos reais.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let Appointment, Session, Package, Payment, Doctor, Patient;
let cancelAppointmentCommand, restoreCanceledAppointmentCommand;
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  await import('../../models/PatientsView.js');

  Appointment = (await import('../../models/Appointment.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Package = (await import('../../models/Package.js')).default;
  Payment = (await import('../../models/Payment.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Patient = (await import('../../models/Patient.js')).default;

  cancelAppointmentCommand = await import('../../services/appointment/commands/cancelAppointmentCommand.js');
  restoreCanceledAppointmentCommand = await import('../../services/appointment/commands/restoreCanceledAppointmentCommand.js');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Appointment.deleteMany({});
  await Session.deleteMany({});
  await Package.deleteMany({});
  await Payment.deleteMany({});
  await Doctor.deleteMany({});
  await Patient.deleteMany({});
});

const FAKE_USER = { _id: new mongoose.Types.ObjectId() };

async function createDoctor() {
  return Doctor.create({
    fullName: 'Dra. Teste',
    email: `doc_${Date.now()}_${Math.random()}@teste.com`,
    phoneNumber: '62999999999',
    licenseNumber: `CRFA-${Math.floor(Math.random() * 100000)}`,
    specialty: 'fisioterapia',
    active: true,
  });
}

async function createPatient() {
  return Patient.create({
    fullName: 'Paciente Teste',
    phone: '11999998888',
    dateOfBirth: '1990-05-15',
  });
}

/**
 * Monta o cenário completo (Package + Session + Appointment [+ Payment]) e
 * devolve tudo já vinculado (arrays do Package, appointmentId da Session).
 */
async function buildScenario({ doctor, patient, sessionCompleted, withPayment }) {
  const pkg = await Package.create({
    durationMonths: 1,
    sessionsPerWeek: 1,
    patient: patient._id,
    doctor: doctor._id,
    sessionType: 'fisioterapia',
    specialty: 'fisioterapia',
    date: new Date('2026-07-01'),
    totalValue: 400,
    totalSessions: 4,
    sessionValue: 100,
    paymentType: 'per-session',
    model: 'per_session',
    sessionsDone: sessionCompleted ? 1 : 0,
    totalPaid: withPayment ? 100 : 0,
    paidSessions: withPayment ? 1 : 0,
    balance: withPayment ? 300 : 400,
    financialStatus: withPayment ? 'partially_paid' : 'unpaid',
  });

  const session = await Session.create({
    date: new Date('2026-07-22'),
    time: '10:00',
    sessionType: 'fisioterapia',
    doctor: doctor._id,
    patient: patient._id,
    package: pkg._id,
    sessionValue: 100,
    status: sessionCompleted ? 'completed' : 'scheduled',
    completedAt: sessionCompleted ? new Date('2026-07-22T10:40:00Z') : null,
    paymentMethod: 'pix',
    partialAmount: withPayment ? 100 : 0,
    paymentOrigin: 'auto_per_session',
  });
  // financialSanitizer remove isPaid/paymentStatus em CREATE (isNew) — precisa
  // setar depois, num .save() de doc já existente, igual o resto do sistema faz.
  if (withPayment) {
    session.isPaid = true;
    session.paymentStatus = 'paid';
    await session.save();
  }

  const appt = new Appointment({
    patient: patient._id,
    doctor: doctor._id,
    date: '2026-07-22',
    time: '10:00',
    specialty: 'fisioterapia',
    operationalStatus: sessionCompleted ? 'completed' : 'scheduled',
    duration: 40,
    serviceType: 'package_session',
    package: pkg._id,
    session: session._id,
    sessionValue: 100,
    paymentOrigin: 'auto_per_session',
    paymentMethod: 'pix',
    billingType: 'particular',
  });
  // Bypass do guard [SECURITY] operationalStatus=completed — só necessário
  // pra montar o fixture do teste, o guard em si continua ativo em produção.
  appt._fromCompleteService = true;
  await appt.save();

  session.appointmentId = appt._id;
  await session.save();

  pkg.sessions = [session._id];
  pkg.appointments = [appt._id];
  await pkg.save();

  let payment = null;
  if (withPayment) {
    payment = await Payment.create({
      patient: patient._id,
      doctor: doctor._id,
      appointment: appt._id,
      session: session._id,
      package: pkg._id,
      amount: 100,
      paymentDate: new Date(),
      paidAt: new Date(),
      paymentMethod: 'pix',
      status: 'paid',
      kind: 'appointment_payment',
      billingType: 'particular',
    });
    appt.payment = payment._id;
    await appt.save();
  }

  return { pkg, session, appt, payment };
}

function snapshotPackage(pkg) {
  return {
    sessionsDone: pkg.sessionsDone,
    totalPaid: pkg.totalPaid,
    paidSessions: pkg.paidSessions,
    balance: pkg.balance,
    financialStatus: pkg.financialStatus,
    sessions: [...pkg.sessions].map(String).sort(),
    appointments: [...pkg.appointments].map(String).sort(),
  };
}

async function cancelThenRestore(appt, session) {
  const mongoSession = await mongoose.startSession();
  await mongoSession.withTransaction(async () => {
    await cancelAppointmentCommand.executeWithSession(
      appt._id,
      { reason: 'Paciente remarcou' },
      FAKE_USER,
      mongoSession
    );
  });

  const canceledAppt = await Appointment.findById(appt._id)
    .populate('session payment package')
    .session(mongoSession);

  await mongoSession.withTransaction(async () => {
    await restoreCanceledAppointmentCommand.executeWithSession(
      canceledAppt,
      { reason: 'Reativação de teste' },
      FAKE_USER,
      mongoSession
    );
    // Quem normalmente faz isso é updateAppointmentCommand.js — aqui simulamos
    // só o campo que ele mexe direto no Appointment (status operacional).
    await Appointment.findByIdAndUpdate(
      appt._id,
      { $set: { operationalStatus: 'scheduled' } },
      { session: mongoSession }
    );
  });

  await mongoSession.endSession();
}

describe('Invariante cancel ⇄ restore', () => {
  it('round-trip completo — sessão nunca completed: estado final == estado inicial', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const { pkg, session, appt } = await buildScenario({ doctor, patient, sessionCompleted: false, withPayment: false });

    const before = snapshotPackage(pkg);

    await cancelThenRestore(appt, session);

    const pkgAfter = await Package.findById(pkg._id);
    const sessionAfter = await Session.findById(session._id);
    const apptAfter = await Appointment.findById(appt._id);

    expect(snapshotPackage(pkgAfter)).toEqual(before);
    expect(sessionAfter.status).toBe('scheduled');
    expect(sessionAfter.isPaid).toBe(false);
    expect(sessionAfter.confirmedAbsence).toBe(false);
    expect(sessionAfter.canceledAt).toBeNull();
    expect(apptAfter.operationalStatus).toBe('scheduled');
  });

  it('assimetria documentada — sessão já tinha sido completed e paga: financeiro/contadores voltam, mas status e Payment NÃO reabrem sozinhos', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const { pkg, session, appt, payment } = await buildScenario({ doctor, patient, sessionCompleted: true, withPayment: true });

    const before = snapshotPackage(pkg);
    const completedAtBefore = session.completedAt;

    await cancelThenRestore(appt, session);

    const pkgAfter = await Package.findById(pkg._id);
    const sessionAfter = await Session.findById(session._id);
    const paymentAfter = await Payment.findById(payment._id);

    // ✅ Simétrico: contadores e agregados financeiros voltam exatamente ao que eram
    expect(snapshotPackage(pkgAfter)).toEqual(before);
    expect(sessionAfter.isPaid).toBe(true);
    expect(sessionAfter.partialAmount).toBe(100);
    expect(sessionAfter.paymentMethod).toBe('pix');

    // 📌 completedAt é histórico — nunca é limpo, nem pelo cancel nem pelo restore
    expect(sessionAfter.completedAt?.getTime()).toBe(completedAtBefore.getTime());

    // ⚠️ Assimetria intencional 1: nunca reabre direto pra 'completed'
    expect(sessionAfter.status).toBe('scheduled');

    // ⚠️ Assimetria intencional 2: Payment nunca volta pra 'paid' sozinho
    expect(paymentAfter.status).toBe('pending');
    expect(paymentAfter.canceledAt).toBeNull();
  });

  it('pacote pré-pago: sessionsDone restaura, mas totalPaid/Payment nunca são mexidos (dinheiro já estava com a clínica)', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();

    const pkg = await Package.create({
      durationMonths: 1,
      sessionsPerWeek: 1,
      patient: patient._id,
      doctor: doctor._id,
      sessionType: 'fisioterapia',
      specialty: 'fisioterapia',
      date: new Date('2026-07-01'),
      totalValue: 800,
      totalSessions: 8,
      sessionValue: 100,
      paymentType: 'full',
      model: 'prepaid',
      sessionsDone: 1,
      totalPaid: 800,
      balance: 0,
      financialStatus: 'paid',
    });

    const session = await Session.create({
      date: new Date('2026-07-22'),
      time: '10:00',
      sessionType: 'fisioterapia',
      doctor: doctor._id,
      patient: patient._id,
      package: pkg._id,
      sessionValue: 100,
      status: 'completed',
      completedAt: new Date('2026-07-22T10:40:00Z'),
      isPaid: true,
      paymentStatus: 'package_paid',
      paymentMethod: 'pix',
      paymentOrigin: 'package_prepaid',
    });

    const appt = new Appointment({
      patient: patient._id,
      doctor: doctor._id,
      date: '2026-07-22',
      time: '10:00',
      specialty: 'fisioterapia',
      operationalStatus: 'completed',
      duration: 40,
      serviceType: 'package_session',
      package: pkg._id,
      session: session._id,
      sessionValue: 100,
      paymentOrigin: 'package_prepaid',
      paymentMethod: 'pix',
      billingType: 'particular',
      // pacote pré-pago não tem Payment por agendamento (Regra B do caixa) — payment fica null
    });
    appt._fromCompleteService = true;
    await appt.save();

    session.appointmentId = appt._id;
    await session.save();
    pkg.sessions = [session._id];
    pkg.appointments = [appt._id];
    await pkg.save();

    const totalPaidBefore = pkg.totalPaid;

    await cancelThenRestore(appt, session);

    const pkgAfter = await Package.findById(pkg._id);
    expect(pkgAfter.sessionsDone).toBe(1); // restaurado (tinha sido completed)
    expect(pkgAfter.totalPaid).toBe(totalPaidBefore); // nunca mexido — nem no cancel nem no restore
    expect(pkgAfter.financialStatus).toBe('paid');
  });
});
