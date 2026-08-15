import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import TherapeuticPlan from '../../models/TherapeuticPlan.js';
import LiminarContract from '../../models/LiminarContract.js';
import { buildDateTime, buildDayRange } from '../../utils/datetime.js';
import { getHolidaysWithNames } from '../../config/feriadosBR-dynamic.js';
import { buildLiminarSession } from '../../domain/session/sessionFactory.js';

const BLOCKING_STATUSES = ['pre_agendado', 'scheduled', 'confirmed', 'pending', 'missed', 'completed'];
const CANCELED_STATUSES = ['canceled', 'cancelled', 'force_cancelled'];

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getWeekStart(date) {
  const result = new Date(date);
  result.setDate(result.getDate() - result.getDay());
  result.setHours(0, 0, 0, 0);
  return result;
}

function emptyResult(contract, extra = {}) {
  return {
    created: 0, skipped: 0, total: 0, conflicts: 0, conflictSlots: [], totalCost: 0,
    saldo: contract.creditBalance, saldoAposTudo: contract.creditBalance,
    saldoInsuficiente: false, slotsBloqueadosPorSaldo: 0,
    limiteSessoesAtingido: false, slotsBloqueadosPorLimiteSessoes: 0,
    ...extra,
  };
}

function conflictError(message, conflictSlots = []) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'LIMINAR_SCHEDULE_CONFLICT';
  error.conflictSlots = conflictSlots;
  return error;
}

/** Append-only. Decision reads and all writes run in one Mongo transaction. */
export async function generateLiminarSessions({
  planId, mode = 'append', weeks = 4, skipHolidays = true, specialties,
}) {
  if (mode !== 'append') {
    const error = new Error('LIMINAR_RESET_DISABLED');
    error.statusCode = 409;
    error.code = 'LIMINAR_RESET_DISABLED';
    throw error;
  }

  const mongoSession = await mongoose.startSession();
  let response;
  try {
    await mongoSession.withTransaction(async () => {
      const plan = await TherapeuticPlan.findById(planId).session(mongoSession).lean();
      if (!plan) throw new Error('PLAN_NOT_FOUND');
      if (plan.status !== 'active') throw new Error(`PLAN_NOT_ACTIVE: status=${plan.status}`);

      const contract = await LiminarContract.findById(plan.liminarContract).session(mongoSession).lean();
      if (!contract) throw new Error('LIMINAR_CONTRACT_NOT_FOUND');
      if (contract.status !== 'active') {
        const error = new Error(`LIMINAR_CONTRACT_NOT_ACTIVE: status=${contract.status}`);
        error.statusCode = 409;
        error.code = 'LIMINAR_CONTRACT_NOT_ACTIVE';
        throw error;
      }

      const therapies = plan.therapies instanceof Map
        ? Object.fromEntries(plan.therapies) : (plan.therapies || {});
      const entries = Object.entries(therapies);
      const activeEntries = specialties?.length
        ? entries.filter(([specialty]) => specialties.includes(specialty)) : entries;
      if (activeEntries.length === 0) {
        response = emptyResult(contract);
        return;
      }

      const existingSessionsCount = contract.totalSessions != null
        ? await Appointment.countDocuments({
            liminarContract: contract._id,
            operationalStatus: { $nin: CANCELED_STATUSES },
          }).session(mongoSession)
        : 0;

      const holidaysByYear = new Map();
      const isHoliday = dateStr => {
        if (!skipHolidays) return false;
        const year = Number(dateStr.slice(0, 4));
        if (!holidaysByYear.has(year)) {
          holidaysByYear.set(year, new Set(getHolidaysWithNames(year).map(item => item.date)));
        }
        return holidaysByYear.get(year).has(dateStr);
      };

      const anchor = new Date(plan.startDate);
      anchor.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const minDate = anchor > today ? anchor : today;
      const candidates = [];

      for (const [specialty, config] of activeEntries) {
        for (const configuredSlot of (Array.isArray(config.slots) ? config.slots : [])) {
          const existing = await Appointment.find({
            patient: contract.patient, liminarContract: contract._id, specialty,
            time: configuredSlot.time, date: { $gte: minDate },
            operationalStatus: { $nin: CANCELED_STATUSES },
          }).select('date').session(mongoSession).lean();
          const existingDates = new Set(existing
            .filter(item => new Date(item.date).getDay() === configuredSlot.dayOfWeek)
            .map(item => new Date(item.date).toISOString().split('T')[0]));

          let candidate = addDays(getWeekStart(minDate), configuredSlot.dayOfWeek);
          while (candidate < minDate) candidate = addDays(candidate, 7);
          let occurrences = 0;
          let guard = 0;
          while (occurrences < weeks && guard++ < 260) {
            const dateStr = candidate.toISOString().split('T')[0];
            if (!isHoliday(dateStr)) {
              occurrences++;
              if (!existingDates.has(dateStr)) {
                candidates.push({
                  specialty, dateStr, time: configuredSlot.time,
                  date: buildDateTime(dateStr, configuredSlot.time),
                  sessionValue: Number(config.sessionValue || 0),
                  duration: config.sessionDurationMinutes || 40,
                  doctor: config.doctor || contract.doctor,
                });
              }
            }
            candidate = addDays(candidate, 7);
          }
        }
      }

      candidates.sort((a, b) => a.dateStr.localeCompare(b.dateStr) || a.time.localeCompare(b.time));
      const internalKeys = new Set();
      for (const slot of candidates) {
        const key = `${slot.dateStr}|${slot.time}`;
        if (internalKeys.has(key)) {
          throw conflictError('O lote contém horários conflitantes para o paciente.', [slot]);
        }
        internalKeys.add(key);
      }

      const externalConflicts = [];
      for (const slot of candidates) {
        const occupied = await Appointment.findOne({
          date: buildDayRange(slot.dateStr), time: slot.time,
          operationalStatus: { $in: BLOCKING_STATUSES },
          $or: [{ doctor: slot.doctor }, { patient: contract.patient }],
        }).select('_id patient doctor').session(mongoSession).lean();
        if (occupied) externalConflicts.push({
          date: slot.date, time: slot.time, specialty: slot.specialty,
          doctorId: slot.doctor?.toString(), appointmentId: occupied._id.toString(),
        });
      }
      if (externalConflicts.length) {
        throw conflictError('Um ou mais horários do lote já estão ocupados.', externalConflicts);
      }

      const kept = [];
      const saldoBlocked = [];
      const sessionBlocked = [];
      let runningCost = 0;
      for (const slot of candidates) {
        const exceedsCredit = runningCost + slot.sessionValue > contract.creditBalance;
        const exceedsSessions = contract.totalSessions != null
          && existingSessionsCount + kept.length >= contract.totalSessions;
        if (exceedsCredit || exceedsSessions) {
          (exceedsSessions && !exceedsCredit ? sessionBlocked : saldoBlocked).push(slot);
        } else {
          kept.push(slot);
          runningCost += slot.sessionValue;
        }
      }

      if (kept.length === 0) {
        response = emptyResult(contract, {
          saldoInsuficiente: saldoBlocked.length > 0,
          slotsBloqueadosPorSaldo: saldoBlocked.length,
          limiteSessoesAtingido: sessionBlocked.length > 0,
          slotsBloqueadosPorLimiteSessoes: sessionBlocked.length,
        });
        return;
      }

      const appointments = await Appointment.insertMany(kept.map(slot => ({
        patient: contract.patient, doctor: slot.doctor, date: slot.date, time: slot.time,
        duration: slot.duration, specialty: slot.specialty, sessionType: slot.specialty,
        serviceType: 'liminar_session', billingType: 'liminar',
        paymentOrigin: 'liminar_credit', paymentMethod: 'liminar_credit', paymentStatus: 'pending',
        operationalStatus: 'pre_agendado', clinicalStatus: 'pending', sessionValue: slot.sessionValue,
        liminarContract: contract._id, therapeuticPlan: plan._id, planVersion: plan.version,
      })), { session: mongoSession, ordered: true });

      const sessions = await Session.insertMany(
        appointments.map(appointment => buildLiminarSession(appointment)),
        { session: mongoSession, ordered: true },
      );
      await Appointment.bulkWrite(sessions.map((createdSession, index) => ({
        updateOne: {
          filter: { _id: appointments[index]._id },
          update: { $set: { session: createdSession._id } },
        },
      })), { session: mongoSession, ordered: true });

      response = {
        created: appointments.length, skipped: 0, total: kept.length,
        conflicts: 0, conflictSlots: [], totalCost: runningCost,
        saldo: contract.creditBalance, saldoAposTudo: contract.creditBalance - runningCost,
        saldoInsuficiente: saldoBlocked.length > 0,
        slotsBloqueadosPorSaldo: saldoBlocked.length,
        limiteSessoesAtingido: sessionBlocked.length > 0,
        slotsBloqueadosPorLimiteSessoes: sessionBlocked.length,
      };
    });
    return response;
  } finally {
    await mongoSession.endSession();
  }
}
