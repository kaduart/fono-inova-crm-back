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
import { getHolidaysWithNames } from '../../config/feriadosBR-dynamic.js';

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

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Espelha o walker de buildExpectedSeries (mesma ordem semana→slots, mesma
 *  regra de pular feriado e `occupiedKeys`) pra calcular a série exata que o
 *  serviço real geraria — suporta múltiplos slots/semana (ex: quarta+sexta,
 *  como o padrão real da guia 16173376), independente de em que dia do
 *  calendário a suíte roda (evita flakiness por feriado nacional caindo em
 *  cima de uma das datas "já existentes" da fixture). */
function computeExpectedSeriesLike(startFloor, slots, count, occupiedKeys = new Set()) {
  const holidays = new Set();
  for (const y of [startFloor.getFullYear(), startFloor.getFullYear() + 1, startFloor.getFullYear() + 2]) {
    for (const h of getHolidaysWithNames(y)) holidays.add(h.date);
  }
  const weekStart = new Date(startFloor); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0, 0, 0, 0);
  const series = [];
  for (let w = 0; series.length < count && w < 520; w++) {
    const weekSunday = addDays(weekStart, w * 7);
    for (const slot of slots) {
      if (series.length >= count) break;
      const d = addDays(weekSunday, slot.dayOfWeek);
      if (d < startFloor) continue;
      const dStr = d.toISOString().split('T')[0];
      if (holidays.has(dStr)) continue;
      const key = `${dStr}T${slot.time}`;
      if (occupiedKeys.has(key)) continue;
      series.push({ date: d, time: slot.time });
    }
  }
  return series;
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
    // Espelha o que cancelAppointmentCommand REALMENTE grava na Session ao
    // cancelar (sessionDoc.paymentStatus = 'canceled') — a fixture por padrão
    // não seta esse campo, e sem isso o teste não prova o cenário real do
    // bloqueador 4 (Session ficando 'canceled' enquanto Appointment já virou
    // 'pending_receipt').
    await Session.updateOne({ _id: trio.session._id }, { $set: { paymentStatus: 'canceled' } });

    const result = await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));

    expect(result.appointmentsGenerated).toBe(1);
    const apptAfter = await Appointment.findById(trio.appointment._id).lean();
    expect(apptAfter._id.toString()).toBe(trio.appointment._id.toString());
    expect(apptAfter.operationalStatus).toBe('pre_agendado');
    expect(apptAfter.paymentStatus).toBe('pending_receipt'); // nunca 'unpaid'
    expect(apptAfter.time).toBe('11:00');

    const sessionAfter = await Session.findById(trio.session._id).lean();
    expect(sessionAfter.paymentStatus).toBe('pending_receipt'); // nunca fica 'canceled' órfão (bloqueador 4)

    const paymentAfter = await Payment.findById(trio.payment._id).lean();
    expect(paymentAfter.status).toBe('pending'); // restaurado, nunca 'paid' direto

    const totalPayments = await Payment.countDocuments({ insurancePlan: plan._id });
    expect(totalPayments).toBe(1); // não duplicou
  }, 30_000);

  it('cancelada com financeiro avançado (billed) NÃO é reaproveitada e BLOQUEIA em vez de criar nova por cima (bloqueador 2 do review 2026-08-14)', async () => {
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

    await expect(withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }))).rejects.toMatchObject({ code: 'CONVENIO_REPLAN_BLOCKED_NON_REVERSIBLE_CANCELED' });

    // Zero mutação: o cancelado faturado continua intocado
    const canceledAfter = await Appointment.findById(trio.appointment._id).lean();
    expect(canceledAfter.operationalStatus).toBe('canceled');
    const paymentAfter = await Payment.findById(trio.payment._id).lean();
    expect(paymentAfter.status).toBe('billed'); // nunca voltou pra pending

    // Nenhuma sessão nova foi criada por cima — o bloqueio abortou antes de qualquer escrita
    const totalAppointments = await Appointment.countDocuments({ insurancePlan: plan._id });
    expect(totalAppointments).toBe(1); // só o cancelado original, nada novo
  }, 30_000);

  it('cancelada com Payment histórico duplicado (um pending, outro billed) NÃO é reversível — checa TODOS os payments, não só um (bloqueador 3)', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('cancel-payment-duplicado');
    const startDate = nextWeekday(2);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 1, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 2, time: '11:00' }]
    });

    const trio = await seedAppointmentTrio({
      patient, doctor, guide, plan, date: nextWeekday(4), time: '16:00', operationalStatus: 'canceled'
      // payment "oficial" (appointment.payment) fica pending — reversível se olhado sozinho
    });

    // Payment histórico duplicado (legado, sem `session` preenchida — cenário real
    // descrito no comentário de cancelAppointmentCommand.js: "duplicatas históricas
    // (legado)... quando appointment.payment aponta pra um registro diferente do
    // Payment ativo real da session"). Só é achado buscando por `appointment`
    // também, não só pelo Payment "oficial" apontado em appointment.payment.
    // Sem `session`, não colide com o índice único parcial
    // unique_active_convenio_payment_per_session (que só se aplica quando
    // session é um ObjectId).
    await Payment.create({
      patient: patient._id,
      doctor: doctor._id,
      appointment: trio.appointment._id,
      specialty: 'terapia_ocupacional',
      amount: 0,
      paymentDate: nextWeekday(4),
      paymentMethod: 'convenio',
      billingType: 'convenio',
      status: 'billed',
      insurance: { provider: guide.insurance, status: 'billed', billedAt: new Date(), grossAmount: 80 },
      insuranceGuide: guide._id,
      insurancePlan: plan._id,
      kind: 'session_payment'
    });

    await expect(withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }))).rejects.toMatchObject({ code: 'CONVENIO_REPLAN_BLOCKED_NON_REVERSIBLE_CANCELED' });

    const canceledAfter = await Appointment.findById(trio.appointment._id).lean();
    expect(canceledAfter.operationalStatus).toBe('canceled'); // nunca restaurado
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

  it('reposicionamento já satisfeito (alreadyThere) entra em generatedAppointments — não pode ficar vazio numa execução idempotente (bloqueador "generatedAppointments vazio")', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('generated-appointments');
    const startDate = nextWeekday(1);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 2, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 1, time: '09:00' }, { dayOfWeek: 3, time: '09:00' }]
    });

    // Roda uma vez pra criar as 2 sessões corretamente posicionadas.
    await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));
    const idsAfterFirst = (await Appointment.find({ insurancePlan: plan._id }).lean()).map(a => a._id.toString());
    expect(idsAfterFirst.length).toBe(2);

    // Segunda execução: nada muda (idempotente) — as 2 já estão exatamente onde
    // deveriam, então nunca passam por toReposition/toRestoreAndReposition/toCreate,
    // só pelo ramo "alreadyThere". generatedAppointments precisa continuar com as 2,
    // não ficar vazio (achado real: só incluía completed+frozen+touchedAppointments,
    // que fica vazio quando não há nada pra tocar).
    await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }));

    const planAfter = await InsurancePlan.findById(plan._id).lean();
    const generatedIds = (planAfter.generatedAppointments || []).map(id => id.toString());
    expect(generatedIds.sort()).toEqual(idsAfterFirst.sort());
  }, 30_000);

  it('CASO REAL guia 16173376/Ícaro: quarta+sexta, 18 autorizadas, 1 completed, retroativas faltantes + futuras existentes somando 17 — replan preenche exatamente o buraco sem perder nenhuma futura (bloqueador 1)', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('icaro-real');

    // Padrão real da guia: 2 slots/semana (quarta 14:00 + sexta 15:00), não 1 —
    // exercita a mesma iteração semana→slots que o serviço real percorre.
    // Datas calculadas dinamicamente (não hardcoded 17/07-18/09) de propósito:
    // hardcoded ficaria datado e arriscaria colidir com feriado dependendo de
    // quando a suíte roda. O split retroativas/futuras é DINÂMICO (filtra por
    // `< today` de verdade) em vez de um índice fixo — com 2 slots/semana o
    // ponto exato onde "hoje" cai entre duas entradas consecutivas depende de
    // em que dia da semana a suíte roda, então um corte fixo (ex: sempre 8/9)
    // quebraria em ~2 de cada 7 execuções. A âncora fica ~4,5 semanas atrás pra
    // as 17 entradas (~8,5 semanas de span com 2/semana) ficarem centradas em
    // torno de hoje, garantindo pelo menos 1 de cada lado.
    const slots = [{ dayOfWeek: 3, time: '14:00' }, { dayOfWeek: 5, time: '15:00' }];
    const past = new Date(); past.setDate(past.getDate() - 30); past.setHours(0, 0, 0, 0);
    const anchorDate = nextWeekday(3, past); // índice 0 — "14/08", quarta-feira
    const occupiedKeys = new Set([`${anchorDate.toISOString().split('T')[0]}T14:00`]);
    const validSeries = computeExpectedSeriesLike(anchorDate, slots, 17, occupiedKeys);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const retroactiveEntries = validSeries.filter(e => e.date < today);
    const futureEntries = validSeries.filter(e => e.date >= today);
    expect(retroactiveEntries.length).toBeGreaterThan(0); // topologia real precisa das duas partes
    expect(futureEntries.length).toBeGreaterThan(0);
    expect(retroactiveEntries.length + futureEntries.length).toBe(17);

    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 18, usedSessions: 1,
      startDate: anchorDate, slots
    });

    const completedTrio = await seedAppointmentTrio({
      patient, doctor, guide, plan, date: anchorDate, time: '14:00', operationalStatus: 'completed'
    });

    const futureTrios = [];
    for (const e of futureEntries) {
      futureTrios.push(await seedAppointmentTrio({
        patient, doctor, guide, plan, date: e.date, time: e.time, operationalStatus: 'pre_agendado'
      }));
    }
    expect(futureTrios.length).toBe(futureEntries.length);

    const result = await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }, allowPastGeneration: true
    }));

    // Exatamente as retroativas faltantes foram criadas — nenhuma a mais, nenhuma a menos
    expect(result.appointmentsGenerated).toBe(retroactiveEntries.length);
    expect(result.pastAppointments.length).toBe(retroactiveEntries.length);

    const allAppts = await Appointment.find({ insurancePlan: plan._id }).sort({ date: 1 }).lean();
    expect(allAppts.length).toBe(18); // 1 completed + futuras + retroativas — nunca 17

    // As 9 futuras PRESERVAM o _id original (nunca foram tocadas nem recriadas)
    const futureIdsBefore = futureTrios.map(t => t.appointment._id.toString()).sort();
    const futureIdsAfter = allAppts
      .filter(a => futureEntries.some(e => e.date.getTime() === new Date(a.date).getTime() && e.time === a.time))
      .map(a => a._id.toString())
      .sort();
    expect(futureIdsAfter).toEqual(futureIdsBefore);

    // A completed continua intocada
    const completedAfter = await Appointment.findById(completedTrio.appointment._id).lean();
    expect(completedAfter.date.getTime()).toBe(new Date(anchorDate).getTime());
    expect(completedAfter.time).toBe('14:00');
    expect(completedAfter.operationalStatus).toBe('completed');

    // Nenhum Payment duplicado: 18 appointments, 18 payments
    const paymentsCount = await Payment.countDocuments({ insurancePlan: plan._id });
    expect(paymentsCount).toBe(18);

    // Completa as retroativas que caíram no passado (mesmo caminho pós-commit
    // que a rota usa) e confirma que usedSessions sobe exatamente 1 por
    // retroativa, nunca conta 2x a completed original.
    const { completeSessionV2 } = await import('../../services/completeSessionService.v2.js');
    for (const appt of result.pastAppointments) {
      await completeSessionV2(appt._id, { userId: doctor._id, notes: 'backfill teste' });
    }
    const expectedCompletedTotal = 1 + result.pastAppointments.length;
    const guideAfterBackfill = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfterBackfill.usedSessions).toBe(expectedCompletedTotal); // original + retroativas, nunca mais

    const completedCount = await Appointment.countDocuments({ insurancePlan: plan._id, operationalStatus: 'completed' });
    expect(completedCount).toBe(expectedCompletedTotal);

    // Segunda execução, já com as retroativas completadas: precisa ser
    // verdadeiramente no-op — nada criado, nada cancelado, nenhuma futura perdida.
    const second = await withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }, allowPastGeneration: true
    }));
    expect(second.appointmentsGenerated).toBe(0);
    expect(second.appointmentsCanceled).toBe(0);

    const totalAfterSecond = await Appointment.countDocuments({ insurancePlan: plan._id });
    expect(totalAfterSecond).toBe(18); // nenhuma futura foi cancelada como "sobra"

    const futureIdsAfterSecond = (await Appointment.find({ insurancePlan: plan._id }).lean())
      .filter(a => futureEntries.some(e => e.date.getTime() === new Date(a.date).getTime() && e.time === a.time))
      .map(a => a._id.toString())
      .sort();
    expect(futureIdsAfterSecond).toEqual(futureIdsBefore); // mesmos IDs, ninguém cancelado
  }, 30_000);

  it('colisão INTERNA com confirmed da própria guia por sobreposição PARCIAL de horário bloqueia (bloqueador 1 do 2º review: excludePlanId escondia isso)', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('colisao-interna-parcial');
    const startDate = nextWeekday(3);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 2, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 3, time: '10:00' }]
    });

    // confirmed da MESMA guia, 10:20-11:00 (duration 40) — sobrepõe parcialmente
    // o alvo 10:00-10:40 do plano (10:20-10:40). Data/hora NÃO são idênticas,
    // então occupiedKeys (que só compara data+hora exata) não pega isso — só
    // checkSlotConflicts, agora que não exclui mais o plano inteiro.
    await seedAppointmentTrio({
      patient, doctor, guide, plan, date: startDate, time: '10:20', operationalStatus: 'confirmed'
    });

    await expect(withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }))).rejects.toMatchObject({ code: 'APPOINTMENT_SLOT_CONFLICT' });

    // Zero mutação: nada foi criado por cima da confirmed
    const totalAppointments = await Appointment.countDocuments({ insurancePlan: plan._id });
    expect(totalAppointments).toBe(1); // só a confirmed original
  }, 30_000);

  it('Payment achável SOMENTE via appointment.payment (sem back-reference appointment/session) é considerado na reversibilidade (bloqueador 2 do 2º review)', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('payment-so-por-referencia');
    const startDate = nextWeekday(2);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 1, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 2, time: '11:00' }]
    });

    const trio = await seedAppointmentTrio({
      patient, doctor, guide, plan, date: nextWeekday(4), time: '16:00', operationalStatus: 'canceled'
    });

    // Substitui o Payment "oficial" por um SEM appointment/session preenchidos —
    // só é achável via _id === appointment.payment (vínculo legado real).
    const orphanPayment = await Payment.create({
      patient: patient._id,
      doctor: doctor._id,
      specialty: 'terapia_ocupacional',
      amount: 0,
      paymentDate: nextWeekday(4),
      paymentMethod: 'convenio',
      billingType: 'convenio',
      status: 'billed',
      insurance: { provider: guide.insurance, status: 'billed', billedAt: new Date(), grossAmount: 80 },
      insuranceGuide: guide._id,
      insurancePlan: plan._id,
      kind: 'session_payment'
    });
    await Appointment.updateOne({ _id: trio.appointment._id }, { $set: { payment: orphanPayment._id } });
    await Payment.deleteOne({ _id: trio.payment._id }); // remove o payment "normal", só sobra o órfão

    await expect(withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }))).rejects.toMatchObject({ code: 'CONVENIO_REPLAN_BLOCKED_NON_REVERSIBLE_CANCELED' });
  }, 30_000);

  it('Payment cancelado com paidAt preenchido (dinheiro já recebido antes do cancelamento) NÃO é reversível mesmo com status/insurance.status neutros (bloqueador 2 do 2º review)', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('payment-paidat');
    const startDate = nextWeekday(2);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 1, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 2, time: '11:00' }]
    });

    const trio = await seedAppointmentTrio({
      patient, doctor, guide, plan, date: nextWeekday(4), time: '16:00', operationalStatus: 'canceled',
      paymentOverrides: { status: 'canceled', insurance: { provider: guide.insurance, status: 'pending' }, paidAt: new Date() }
    });
    expect(trio.payment.paidAt).toBeTruthy();

    await expect(withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }))).rejects.toMatchObject({ code: 'CONVENIO_REPLAN_BLOCKED_NON_REVERSIBLE_CANCELED' });
  }, 30_000);

  it('erro real ao cancelar 1 item excedente aborta a transação inteira, zero mutação (bloqueador 5)', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('bulkcancel-falha');
    const startDate = nextWeekday(4);
    const { guide, plan } = await seedGuideAndPlan({
      patient, doctor, totalSessions: 1, usedSessions: 0,
      startDate, slots: [{ dayOfWeek: 4, time: '09:00' }]
    });

    // 2 pre_agendado pra 1 vaga só — 1 sobra e precisa ser cancelado como excedente
    const trioA = await seedAppointmentTrio({
      patient, doctor, guide, plan, date: startDate, time: '09:00', operationalStatus: 'pre_agendado'
    });
    await seedAppointmentTrio({
      patient, doctor, guide, plan, date: nextWeekday(4, startDate), time: '09:00', operationalStatus: 'pre_agendado'
    });

    const bulkCancelModule = await import('../../services/appointment/commands/bulkCancelAppointmentsCommand.js');
    const spy = vi.spyOn(bulkCancelModule, 'executeWithSession').mockResolvedValueOnce({
      canceled: 0,
      canceledIds: [],
      errors: [{ id: 'algum-id', error: 'falha simulada' }]
    });

    await expect(withTransaction(session => replanInsurancePlanSessions({
      planId: plan._id, guideId: guide._id, mongoSession: session, user: { _id: doctor._id }
    }))).rejects.toMatchObject({ code: 'CONVENIO_REPLAN_CANCEL_FAILED' });

    spy.mockRestore();

    // Zero mutação: os 2 originais continuam exatamente como estavam (nenhum cancelado, nenhum criado)
    const appointmentsAfter = await Appointment.find({ insurancePlan: plan._id }).lean();
    expect(appointmentsAfter.length).toBe(2);
    expect(appointmentsAfter.every(a => a.operationalStatus === 'pre_agendado')).toBe(true);
    const trioAAfter = await Appointment.findById(trioA.appointment._id).lean();
    expect(trioAAfter.time).toBe('09:00'); // não mexeu
  }, 30_000);
});
