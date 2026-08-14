/**
 * E2E Test - Replan in-place do convênio (2026-08-14)
 *
 * 🎯 Validação: replanInsurancePlanSessions.js reaproveita Appointment/Session/
 * Payment existentes em vez de apagar e recriar — preserva IDs, nunca move
 * `completed`, só reaproveita `canceled` quando financeiramente reversível,
 * nunca move `confirmed`/`missed` automaticamente, nunca cancela registro de
 * outra guia (bloqueia com conflito), é idempotente, nunca duplica Payment,
 * nunca diminui `usedSessions`.
 *
 * ⚠️ Caso real que motivou a correção: guia 16173376 (Ícaro, Terapia
 * Ocupacional) — startDate retroativa (17/07) nunca foi preenchida porque a
 * heurística antiga de divergência (Set<dayOfWeek-time> + contagem) não
 * detectava o buraco: mesmos slots, mesma contagem, datas erradas.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../config/socket.js', () => ({
  getIo: () => ({ emit: () => {}, to: () => ({ emit: () => {} }) }),
  initializeSocket: () => {}
}));
vi.mock('../../config/redisConnection.js', () => ({
  redisConnection: { status: 'ready', on: () => {} }
}));
vi.mock('../../config/bullConfig.js', () => ({
  followupQueue: { add: async () => ({}), on: () => {} },
  followupEvents: { on: () => {} },
  videoGenerationQueue: { add: async () => ({}), on: () => {} },
  videoGenerationEvents: { on: () => {} }
}));
vi.mock('../../services/journeyFollowupEngine.js', () => ({ runJourneyFollowups: async () => {} }));
vi.mock('../../services/syncService.js', () => ({ syncEvent: async () => {} }));

let mongoServer;
let Patient, Doctor, Convenio, InsuranceGuide, InsurancePlan, Appointment, Session, Payment;
let replanInsurancePlanSessions, isPaymentFinanciallyReversible, generateInsurancePlanSessions;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Convenio = (await import('../../models/Convenio.js')).default;
  InsuranceGuide = (await import('../../models/InsuranceGuide.js')).default;
  InsurancePlan = (await import('../../models/InsurancePlan.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Payment = (await import('../../models/Payment.js')).default;

  ({ replanInsurancePlanSessions, isPaymentFinanciallyReversible } = await import('../../services/schedule/replanInsurancePlanSessions.js'));
  ({ generateInsurancePlanSessions } = await import('../../services/schedule/generateInsurancePlanSessions.js'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const cols = mongoose.connection.collections;
  for (const key in cols) await cols[key].deleteMany({});
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function nextWeekday(dayOfWeek, fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + ((dayOfWeek - d.getDay() + 7) % 7 || 7));
  d.setHours(0, 0, 0, 0);
  return d;
}

async function seedPatientAndDoctor(suffix = '') {
  const patient = await Patient.create({
    fullName: `Paciente Replan Teste ${suffix}`,
    phone: `6299999${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
    dateOfBirth: new Date('2016-01-01')
  });
  const doctor = await Doctor.create({
    fullName: `Dra. Replan Teste ${suffix}`,
    specialty: 'terapia_ocupacional',
    phoneNumber: `6299998${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
    licenseNumber: `CRM-GO-${Math.floor(Math.random() * 90000) + 10000}`,
    email: `dra.replan.${Date.now()}.${Math.random()}@teste.com`
  });
  await Convenio.findOneAndUpdate(
    { code: 'unimed-replan-teste' },
    {
      code: 'unimed-replan-teste',
      name: 'Unimed Replan Teste',
      sessionValue: 80,
      active: true,
      guidePolicy: { renewalType: 'until_consumed', autoSuggestRenewal: false }
    },
    { upsert: true }
  );
  return { patient, doctor };
}

async function seedGuideAndPlan({ patient, doctor, totalSessions = 10, usedSessions = 0, startDate, slots }) {
  const guide = await InsuranceGuide.create({
    number: `GUIA-REPLAN-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    insurance: 'unimed-replan-teste',
    patientId: patient._id,
    doctorId: doctor._id,
    specialty: 'terapia_ocupacional',
    totalSessions,
    usedSessions,
    sessionValue: 80,
    status: 'active',
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 180)
  });
  const plan = await InsurancePlan.create({
    patient: patient._id,
    guide: guide._id,
    doctor: doctor._id,
    specialty: 'terapia_ocupacional',
    totalSessions: totalSessions - usedSessions,
    sessionsPerWeek: slots.length,
    startDate,
    slots,
    sessionValue: 80,
    status: 'active'
  });
  return { guide, plan };
}

async function withTransaction(fn) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

/** Cria appointment+session+payment "manualmente" fora do replan, pra simular
 *  estado pré-existente (pendente, cancelado, completed, confirmed, missed). */
async function seedAppointmentTrio({ patient, doctor, guide, plan, date, time, operationalStatus, paymentOverrides = {} }) {
  const apptDoc = new Appointment({
    patient: patient._id,
    doctor: doctor._id,
    specialty: 'terapia_ocupacional',
    date,
    time,
    duration: 40,
    billingType: 'convenio',
    paymentMethod: 'convenio',
    insuranceGuide: guide._id,
    insurancePlan: plan._id,
    insuranceProvider: guide.insurance,
    sessionValue: 80,
    insuranceValue: 80,
    operationalStatus,
    clinicalStatus: operationalStatus === 'completed' ? 'completed' : 'pending',
    status: operationalStatus,
    serviceType: 'session',
    sessionType: 'terapia_ocupacional',
    metadata: { origin: { source: 'insurance_plan' } }
  });
  if (operationalStatus === 'completed') apptDoc._fromCompleteService = true;
  const appointment = await apptDoc.save();

  const session = await Session.create({
    patient: patient._id,
    doctor: doctor._id,
    specialty: 'terapia_ocupacional',
    date,
    time,
    sessionType: 'terapia_ocupacional',
    serviceType: 'session',
    sessionValue: 80,
    appointmentId: appointment._id,
    appointment: appointment._id,
    paymentMethod: 'convenio',
    status: operationalStatus === 'canceled' || operationalStatus === 'cancelled' ? 'canceled' : (operationalStatus === 'completed' ? 'completed' : 'scheduled'),
    isPaid: false,
    insuranceGuide: guide._id
  });

  const payment = await Payment.create({
    patient: patient._id,
    doctor: doctor._id,
    appointment: appointment._id,
    session: session._id,
    specialty: 'terapia_ocupacional',
    amount: 0,
    paymentDate: date,
    paymentMethod: 'convenio',
    billingType: 'convenio',
    status: 'pending',
    insurance: { provider: guide.insurance, status: 'pending', grossAmount: 80 },
    insuranceGuide: guide._id,
    insurancePlan: plan._id,
    kind: 'session_payment',
    ...paymentOverrides
  });

  await Appointment.findByIdAndUpdate(appointment._id, { session: session._id, payment: payment._id });
  return { appointment: await Appointment.findById(appointment._id).lean(), session: await Session.findById(session._id).lean(), payment: await Payment.findById(payment._id).lean() };
}

// ─── PREDICATE — testável isoladamente ────────────────────────────────────────
describe('isPaymentFinanciallyReversible — predicate canônico', () => {
  it('null/sem payment → reversível', () => {
    expect(isPaymentFinanciallyReversible(null)).toBe(true);
  });
  it('pending, insurance.status pending → reversível', () => {
    expect(isPaymentFinanciallyReversible({ status: 'pending', insurance: { status: 'pending' } })).toBe(true);
  });
  it.each(['billed', 'paid', 'partial', 'refunded'])('status "%s" → bloqueia', (status) => {
    expect(isPaymentFinanciallyReversible({ status, insurance: {} })).toBe(false);
  });
  it('insurance.status billed → bloqueia mesmo com status top-level pending', () => {
    expect(isPaymentFinanciallyReversible({ status: 'pending', insurance: { status: 'billed' } })).toBe(false);
  });
  it('insurance.status received → bloqueia', () => {
    expect(isPaymentFinanciallyReversible({ status: 'pending', insurance: { status: 'received' } })).toBe(false);
  });
  it('receivedAmount > 0 → bloqueia', () => {
    expect(isPaymentFinanciallyReversible({ status: 'pending', insurance: { receivedAmount: 50 } })).toBe(false);
  });
  it('billedAt presente → bloqueia', () => {
    expect(isPaymentFinanciallyReversible({ status: 'pending', insurance: { billedAt: new Date() } })).toBe(false);
  });
});

// ─── REPLAN IN-PLACE ───────────────────────────────────────────────────────────
describe('replanInsurancePlanSessions — in-place', () => {
  it('buraco retroativo desde startDate: cria as datas passadas faltantes (allowPastGeneration=true)', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('retroativo');
    // startDate 3 semanas atrás, 1x/semana (segunda) — simula o caso Ícaro
    const past = new Date(); past.setDate(past.getDate() - 21); past.setHours(0, 0, 0, 0);
    const startDate = nextWeekday(1, past);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 4, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 1, time: '09:00' }]
    });

    const result = await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }, allowPastGeneration: true
    }));

    expect(result.appointmentsGenerated).toBe(4);
    expect(result.pastAppointments.length).toBeGreaterThan(0);

    const appts = await Appointment.find({ insurancePlan: plan._id }).sort({ date: 1 }).lean();
    expect(appts.length).toBe(4);
    expect(new Date(appts[0].date) <= new Date()).toBe(true); // a mais antiga é passada
  }, 30_000);

  it('appointments pendentes (pre_agendado/scheduled) futuros preservam AppointmentId/SessionId/PaymentId ao reposicionar', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('preserva-ids');
    const startDate = nextWeekday(3);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 1, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 3, time: '10:00' }]
    });

    // Appointment já existe, mas numa data/hora DIFERENTE da série esperada
    const wrongDate = nextWeekday(5);
    const trio = await seedAppointmentTrio({
      patient, doctor, guide, plan, date: wrongDate, time: '15:00', operationalStatus: 'pre_agendado'
    });

    await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));

    const apptAfter = await Appointment.findById(trio.appointment._id).lean();
    const sessionAfter = await Session.findById(trio.session._id).lean();
    // Mesmo _id, data/hora reposicionadas pra série esperada
    expect(apptAfter._id.toString()).toBe(trio.appointment._id.toString());
    expect(apptAfter.time).toBe('10:00');
    expect(sessionAfter._id.toString()).toBe(trio.session._id.toString());
    expect(sessionAfter.time).toBe('10:00');
    expect(apptAfter.payment.toString()).toBe(trio.payment._id.toString());

    const totalAppointments = await Appointment.countDocuments({ insurancePlan: plan._id });
    expect(totalAppointments).toBe(1); // não duplicou
  }, 30_000);

  it('cancelada reversível (payment pending) é restaurada e reposicionada preservando IDs', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('cancel-reversivel');
    const startDate = nextWeekday(2);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 1, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 2, time: '11:00' }]
    });

    const trio = await seedAppointmentTrio({
      patient, doctor, guide, plan, date: nextWeekday(4), time: '16:00', operationalStatus: 'canceled'
    });

    const result = await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));

    expect(result.appointmentsGenerated).toBe(1);
    const apptAfter = await Appointment.findById(trio.appointment._id).lean();
    expect(apptAfter._id.toString()).toBe(trio.appointment._id.toString());
    expect(apptAfter.operationalStatus).toBe('pre_agendado');
    expect(apptAfter.paymentStatus).toBe('pending_receipt'); // nunca 'unpaid'
    expect(apptAfter.time).toBe('11:00');

    const paymentAfter = await Payment.findById(trio.payment._id).lean();
    expect(paymentAfter.status).toBe('pending'); // restaurado, nunca 'paid' direto

    const totalPayments = await Payment.countDocuments({ insurancePlan: plan._id });
    expect(totalPayments).toBe(1); // não duplicou
  }, 30_000);

  it('cancelada com financeiro avançado (billed) NÃO é reaproveitada — cria nova em vez de reativar', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('cancel-bloqueado');
    const startDate = nextWeekday(2);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 1, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 2, time: '11:00' }]
    });

    const trio = await seedAppointmentTrio({
      patient, doctor, guide, plan, date: nextWeekday(4), time: '16:00', operationalStatus: 'canceled',
      paymentOverrides: { status: 'billed', insurance: { provider: guide.insurance, status: 'billed', billedAt: new Date(), grossAmount: 80 } }
    });

    await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));

    // O cancelado faturado continua intocado
    const canceledAfter = await Appointment.findById(trio.appointment._id).lean();
    expect(canceledAfter.operationalStatus).toBe('canceled');
    const paymentAfter = await Payment.findById(trio.payment._id).lean();
    expect(paymentAfter.status).toBe('billed'); // nunca voltou pra pending

    // Uma sessão NOVA foi criada pro slot esperado, sem tocar na antiga
    const newAppt = await Appointment.findOne({ insurancePlan: plan._id, operationalStatus: 'pre_agendado' }).lean();
    expect(newAppt).not.toBeNull();
    expect(newAppt._id.toString()).not.toBe(trio.appointment._id.toString());
  }, 30_000);

  it('completed permanece byte-a-byte idêntica e continua consumindo autorização', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('completed-imutavel');
    const startDate = nextWeekday(1);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 2, usedSessions: 1,
      startDate, slots: [{ dayOfWeek: 1, time: '09:00' }]
    });

    // Sessão completed FORA do padrão atual (dia diferente do slot vigente)
    const completedTrio = await seedAppointmentTrio({
      patient, doctor, guide, plan, date: nextWeekday(5), time: '14:00', operationalStatus: 'completed'
    });
    const before = await Appointment.findById(completedTrio.appointment._id).lean();

    await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));

    const after = await Appointment.findById(completedTrio.appointment._id).lean();
    expect(after.date.getTime()).toBe(before.date.getTime());
    expect(after.time).toBe(before.time);
    expect(after.operationalStatus).toBe('completed');

    const guideAfter = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfter.usedSessions).toBe(1); // não mudou
  }, 30_000);

  it('confirmed e missed não são movidos automaticamente', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('frozen');
    const startDate = nextWeekday(3);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 3, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 3, time: '10:00' }]
    });

    const confirmedTrio = await seedAppointmentTrio({
      patient, doctor, guide, plan, date: nextWeekday(5), time: '13:00', operationalStatus: 'confirmed'
    });
    const missedTrio = await seedAppointmentTrio({
      patient, doctor, guide, plan, date: nextWeekday(6), time: '13:00', operationalStatus: 'missed'
    });

    await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));

    const confirmedAfter = await Appointment.findById(confirmedTrio.appointment._id).lean();
    const missedAfter = await Appointment.findById(missedTrio.appointment._id).lean();
    expect(confirmedAfter.time).toBe('13:00');
    expect(confirmedAfter.operationalStatus).toBe('confirmed');
    expect(missedAfter.time).toBe('13:00');
    expect(missedAfter.operationalStatus).toBe('missed');
  }, 30_000);

  it('conflito com registro de OUTRA guia: lança erro, zero mutação em qualquer lado', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('conflito');
    const conflictDate = nextWeekday(4);

    // Guia A antiga com appointment bloqueando quarta 09:00
    const { guide: guideA, plan: planA } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 1, usedSessions: 0,
      startDate: conflictDate, slots: [{ dayOfWeek: 4, time: '09:00' }]
    });
    const trioA = await seedAppointmentTrio({
      patient, doctor, guide: guideA, plan: planA, date: conflictDate, time: '09:00', operationalStatus: 'pre_agendado'
    });

    // Guia B nova, mesmo paciente/doutor, mesmo horário exato
    const { guide: guideB, plan: planB } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 1, usedSessions: 0,
      startDate: conflictDate, slots: [{ dayOfWeek: 4, time: '09:00' }]
    });

    await expect(withTransaction(session => replanInsurancePlanSessions({
      planId: planB._id, guideId: guideB._id, mongoSession: session, user: { _id: doctor._id }
    }))).rejects.toThrow();

    // Guia A intocada
    const trioAAfter = await Appointment.findById(trioA.appointment._id).lean();
    expect(trioAAfter.operationalStatus).toBe('pre_agendado');
    expect(trioAAfter.time).toBe('09:00');
    // Guia B não ganhou nenhum appointment
    const guideBAppointments = await Appointment.countDocuments({ insurancePlan: planB._id });
    expect(guideBAppointments).toBe(0);
  }, 30_000);

  it('segunda execução idêntica é no-op (idempotente)', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('idempotente');
    const startDate = nextWeekday(2);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 3, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 2, time: '09:00' }]
    });

    const first = await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));
    expect(first.appointmentsGenerated).toBe(3);

    const idsBefore = (await Appointment.find({ insurancePlan: plan._id }).sort({ date: 1 }).lean()).map(a => a._id.toString());

    const second = await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));

    expect(second.appointmentsGenerated).toBe(0);
    expect(second.appointmentsCanceled).toBe(0);

    const idsAfter = (await Appointment.find({ insurancePlan: plan._id }).sort({ date: 1 }).lean()).map(a => a._id.toString());
    expect(idsAfter).toEqual(idsBefore);
    const totalAppointments = await Appointment.countDocuments({ insurancePlan: plan._id });
    expect(totalAppointments).toBe(3);
  }, 30_000);

  it('usedSessions nunca diminui, mesmo com cancelados/reposicionamentos', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('used-sessions');
    const startDate = nextWeekday(1);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 5, usedSessions: 2,
      startDate, slots: [{ dayOfWeek: 1, time: '09:00' }]
    });

    await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));

    const guideAfter = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfter.usedSessions).toBe(2); // exatamente igual, nunca decrementado
  }, 30_000);

  it('nenhum Payment duplicado após reposicionar + criar no mesmo replan', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('sem-duplicar-payment');
    const startDate = nextWeekday(3);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 2, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 3, time: '10:00' }, { dayOfWeek: 5, time: '10:00' }]
    });

    // Um appointment pendente já existe em data errada — vai ser reaproveitado.
    // O segundo slot da série esperada não tem nada — vai ser criado.
    await seedAppointmentTrio({
      patient, doctor, guide, plan, date: nextWeekday(6), time: '17:00', operationalStatus: 'pre_agendado'
    });

    await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));

    const appointments = await Appointment.find({ insurancePlan: plan._id }).lean();
    expect(appointments.length).toBe(2);
    const paymentsCount = await Payment.countDocuments({ insurancePlan: plan._id });
    expect(paymentsCount).toBe(2); // 1 reaproveitado + 1 novo, nunca 3+

    // Cada appointment aponta pra um payment distinto
    const paymentIds = appointments.map(a => a.payment?.toString());
    expect(new Set(paymentIds).size).toBe(2);
  }, 30_000);
});
