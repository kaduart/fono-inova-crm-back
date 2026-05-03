// services/schedule/generateLiminarSessions.js
// Gera appointments a partir de TherapeuticPlan com slots { dayOfWeek, time }.
// Idempotente via bulkWrite upsert — chamar N vezes não duplica.
//
// Modos:
//   append  → gera semanas completas a partir da semana seguinte à última sessão
//   reset   → cancela futuras scheduled e recria do zero (nova versão de plano)

import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import TherapeuticPlan from '../../models/TherapeuticPlan.js';
import LiminarContract from '../../models/LiminarContract.js';
import { buildDateTime, buildDayRange } from '../../utils/datetime.js';
import { getHolidaysWithNames } from '../../config/feriadosBR-dynamic.js';
import { buildLiminarSession } from '../../domain/session/sessionFactory.js';

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Retorna o domingo da semana da data fornecida (00:00:00) */
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=domingo
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Gera appointments para um plano terapêutico.
 *
 * @param {string}  planId        - ID do TherapeuticPlan ativo
 * @param {string}  mode          - 'append' | 'reset'
 * @param {number}  weeks         - Quantas semanas gerar (usado no modo append)
 * @param {string}  startDate     - Início da janela (modo reset)
 * @param {string}  endDate       - Fim da janela   (modo reset)
 * @param {boolean} skipHolidays  - Pular feriados nacionais (default: true)
 */
export async function generateLiminarSessions({
  planId,
  mode = 'append',
  weeks = 4,
  startDate,
  endDate,
  skipHolidays = true
}) {
  // ── 1. Carrega plano e contrato ────────────────────────────────
  const plan = await TherapeuticPlan.findById(planId).lean();
  if (!plan)                    throw new Error('PLAN_NOT_FOUND');
  if (plan.status !== 'active') throw new Error(`PLAN_NOT_ACTIVE: status=${plan.status}`);

  const contract = await LiminarContract.findById(plan.liminarContract).lean();
  if (!contract)                    throw new Error('LIMINAR_CONTRACT_NOT_FOUND');
  if (contract.status !== 'active') throw new Error(`LIMINAR_CONTRACT_NOT_ACTIVE: status=${contract.status}`);

  // ── 2. Normaliza therapies ─────────────────────────────────────
  const therapies = plan.therapies instanceof Map
    ? Object.fromEntries(plan.therapies)
    : (plan.therapies || {});

  const therapyEntries = Object.entries(therapies);
  if (therapyEntries.length === 0) {
    return { created: 0, skipped: 0, total: 0, totalCost: 0, saldo: contract.creditBalance, saldoAposTudo: contract.creditBalance };
  }

  // ── 3. Resolve janela de geração ───────────────────────────────
  let weekStart;
  let globalEnd;

  if (mode === 'reset') {
    // Cancela APENAS sessões agendadas (não confirmed/completed)
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cancelRes = await Appointment.updateMany(
      {
        liminarContract: contract._id,
        date: { $gte: today },
        operationalStatus: 'scheduled'
      },
      {
        $set: {
          operationalStatus: 'canceled',
          clinicalStatus: 'canceled',
          updatedAt: new Date()
        }
      }
    );
    console.log('[generateLiminarSessions] 🔄 reset cancelou futuras scheduled', {
      contractId: contract._id.toString(),
      canceled: cancelRes.modifiedCount
    });

    weekStart = getWeekStart(startDate);
    globalEnd = new Date(endDate); globalEnd.setHours(23, 59, 59, 999);
  } else {
    // append: descobre última semana com sessão e começa a seguinte
    const lastSession = await Appointment.findOne({
      patient: contract.patient,
      liminarContract: contract._id,
      operationalStatus: { $ne: 'canceled' }
    }).sort({ date: -1 }).lean();

    if (lastSession) {
      weekStart = getWeekStart(lastSession.date);
      weekStart.setDate(weekStart.getDate() + 7); // próxima semana completa
    } else {
      // Usa plan.startDate como âncora (igual ao convenio) — nunca gera no passado
      const anchor = new Date(plan.startDate);
      anchor.setHours(0, 0, 0, 0);
      weekStart = getWeekStart(anchor);
    }

    globalEnd = addDays(weekStart, weeks * 7 + 6);
    globalEnd.setHours(23, 59, 59, 999);
  }

  // ── 4. Feriados do período ─────────────────────────────────────
  const holidays = new Set();
  if (skipHolidays) {
    const years = new Set();
    const cur = new Date(weekStart);
    while (cur <= globalEnd) { years.add(cur.getFullYear()); cur.setDate(cur.getDate() + 1); }
    for (const year of years) {
      for (const h of getHolidaysWithNames(year)) holidays.add(h.date);
    }
  }

  // ── 5. Gera slots semana a semana ──────────────────────────────
  const slots = [];

  if (mode === 'append') {
    const anchorDate = new Date(plan.startDate);
    anchorDate.setHours(0, 0, 0, 0);

    const today = new Date(); today.setHours(0, 0, 0, 0);

    // Gera N semanas completas — cada semana contém TODOS os slots do plano
    for (let w = 0; w < weeks; w++) {
      const currentWeekSunday = addDays(weekStart, w * 7);

      for (const [specialty, config] of therapyEntries) {
        for (const slot of (Array.isArray(config.slots) ? config.slots : [])) {
          const sessionDate = addDays(currentWeekSunday, slot.dayOfWeek);
          const dateStr = sessionDate.toISOString().split('T')[0];

          // Pula datas antes do startDate do plano (igual ao convenio)
          if (sessionDate < anchorDate) continue;

          // Proteção extra: nunca gera slot no passado
          if (sessionDate < today) continue;

          if (!holidays.has(dateStr)) {
            slots.push({
              specialty,
              dateStr,
              time:         slot.time,
              date:         buildDateTime(dateStr, slot.time),
              sessionValue: config.sessionValue,
              duration:     config.sessionDurationMinutes || 40
            });
          }
        }
      }
    }
  } else {
    // reset: gera tudo dentro da janela fornecida
    const walker = new Date(weekStart);
    while (walker <= globalEnd) {
      const dayOfWeek = walker.getDay();
      const dateStr   = walker.toISOString().split('T')[0];

      if (!holidays.has(dateStr)) {
        for (const [specialty, config] of therapyEntries) {
          for (const slot of (Array.isArray(config.slots) ? config.slots : [])) {
            if (slot.dayOfWeek === dayOfWeek) {
              slots.push({
                specialty,
                dateStr,
                time:         slot.time,
                date:         buildDateTime(dateStr, slot.time),
                sessionValue: config.sessionValue,
                duration:     config.sessionDurationMinutes || 40
              });
            }
          }
        }
      }

      walker.setDate(walker.getDate() + 1);
    }
  }

  if (slots.length === 0) {
    return { created: 0, skipped: 0, total: 0, totalCost: 0, saldo: contract.creditBalance, saldoAposTudo: contract.creditBalance };
  }

  // ── 6. Alerta de saldo (não bloqueia) ─────────────────────────
  const totalCost = slots.reduce((s, sl) => s + sl.sessionValue, 0);
  if (contract.creditBalance < totalCost) {
    console.warn('[generateLiminarSessions] ⚠️ Saldo insuficiente para toda a janela', {
      contractId:    contract._id,
      creditBalance: contract.creditBalance,
      totalCost,
      slotCount:     slots.length
    });
  }

  // ── 7. bulkWrite upsert ────────────────────────────────────────
  const bulkOps = slots.map(slot => ({
    updateOne: {
      filter: {
        patient:           contract.patient,
        liminarContract:   contract._id,
        specialty:         slot.specialty,
        time:              slot.time,
        date:              buildDayRange(slot.dateStr),
        operationalStatus: { $ne: 'canceled' }
      },
      update: {
        $setOnInsert: {
          patient:           contract.patient,
          doctor:            contract.doctor,
          date:              slot.date,
          time:              slot.time,
          duration:          slot.duration,
          specialty:         slot.specialty,
          sessionType:       slot.specialty,
          serviceType:       'liminar_session',
          billingType:       'liminar',
          paymentOrigin:     'liminar_credit',
          paymentMethod:     'liminar_credit',
          paymentStatus:     'pending',
          operationalStatus: 'scheduled',
          clinicalStatus:    'pending',
          sessionValue:      slot.sessionValue,
          liminarContract:   contract._id,
          therapeuticPlan:   plan._id,
          planVersion:       plan.version,
          createdAt:         new Date()
        }
      },
      upsert: true
    }
  }));

  const result = await Appointment.bulkWrite(bulkOps, { ordered: false });

  // ── 8. Cria Sessions para appointments recém-inseridos ─────────
  const upsertedIds = Object.values(result.upsertedIds || {});
  let createdSessionsCount = 0;

  if (upsertedIds.length > 0) {
    const newAppointments = await Appointment.find(
      { _id: { $in: upsertedIds } }
    ).lean();

    const sessionDocs = newAppointments.map(a => buildLiminarSession(a));

    const createdSessions = await Session.insertMany(sessionDocs);
    createdSessionsCount = createdSessions.length;

    const sessionLinkOps = createdSessions.map((s, i) => ({
      updateOne: {
        filter: { _id: newAppointments[i]._id },
        update: { $set: { session: s._id } }
      }
    }));
    await Appointment.bulkWrite(sessionLinkOps, { ordered: false });
  }

  console.log('[generateLiminarSessions] ✅ Concluído', {
    contractId: contract._id.toString(),
    planId:     plan._id.toString(),
    version:    plan.version,
    mode,
    weeks,
    window:     `${weekStart.toISOString().split('T')[0]} → ${globalEnd.toISOString().split('T')[0]}`,
    created:         result.upsertedCount,
    skipped:         result.matchedCount,
    total:           slots.length,
    sessionsCreated: createdSessionsCount
  });

  return {
    created:       result.upsertedCount,
    skipped:       result.matchedCount,
    total:         slots.length,
    totalCost,
    saldo:         contract.creditBalance,
    saldoAposTudo: contract.creditBalance - totalCost
  };
}
