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
  skipHolidays = true,
  specialties,       // optional string[] — quando presente, processa só essas especialidades
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

  // Filtra por especialidades selecionadas (se informado)
  const activeEntries = specialties?.length
    ? therapyEntries.filter(([sp]) => specialties.includes(sp))
    : therapyEntries;

  if (activeEntries.length === 0) {
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
        operationalStatus: { $in: ['scheduled', 'pre_agendado'] }
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
    const todayAnchor = new Date(); todayAnchor.setHours(0, 0, 0, 0);
    const planAnchor  = new Date(plan.startDate); planAnchor.setHours(0, 0, 0, 0);
    const baseAnchor  = todayAnchor > planAnchor ? todayAnchor : planAnchor;

    // Detecta gaps: verifica se algum slot do plano atual não tem appointments futuros.
    // Se sim → mudança de plano ou slot novo → começa de hoje para preencher.
    // Se não → tudo em ordem → estende a partir do último appointment.
    const slotChecks = await Promise.all(
      activeEntries.flatMap(([specialty, config]) =>
        (config.slots ?? []).map(slot =>
          Appointment.findOne({
            patient:           contract.patient,
            liminarContract:   contract._id,
            specialty,
            time:              slot.time,
            date:              { $gte: todayAnchor },
            operationalStatus: { $ne: 'canceled' }
          }).lean()
        )
      )
    );

    const hasGap = slotChecks.some(appt => !appt);

    if (hasGap) {
      // Slot sem appointment futuro → preenche gaps a partir de hoje
      weekStart = getWeekStart(baseAnchor);
      console.log('[generateLiminarSessions] 🔍 Gap detectado — weekStart = hoje:', weekStart.toISOString().split('T')[0]);
    } else {
      // Todos slots têm appointments futuros → estende a partir do último
      const lastSession = await Appointment.findOne({
        patient:           contract.patient,
        liminarContract:   contract._id,
        specialty:         { $in: activeEntries.map(([sp]) => sp) },
        operationalStatus: { $ne: 'canceled' }
      }).sort({ date: -1 }).lean();

      if (lastSession) {
        weekStart = getWeekStart(lastSession.date);
        weekStart.setDate(weekStart.getDate() + 7);
        console.log('[generateLiminarSessions] ▶ Sem gaps — weekStart = após último:', weekStart.toISOString().split('T')[0]);
      } else {
        weekStart = getWeekStart(baseAnchor);
      }
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

      for (const [specialty, config] of activeEntries) {
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
              duration:     config.sessionDurationMinutes || 40,
              doctor:       config.doctor || contract.doctor
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
        for (const [specialty, config] of activeEntries) {
          for (const slot of (Array.isArray(config.slots) ? config.slots : [])) {
            if (slot.dayOfWeek === dayOfWeek) {
              slots.push({
                specialty,
                dateStr,
                time:         slot.time,
                date:         buildDateTime(dateStr, slot.time),
                sessionValue: config.sessionValue,
                duration:     config.sessionDurationMinutes || 40,
                doctor:       config.doctor || contract.doctor
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
  console.log('[generateLiminarSessions] 📋 Especialidades ativas:', activeEntries.map(([sp]) => sp));
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
          doctor:            slot.doctor || contract.doctor,
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
          operationalStatus: 'pre_agendado',
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

  let result;
  let rawConflicts = [];
  try {
    result = await Appointment.bulkWrite(bulkOps, { ordered: false });
  } catch (err) {
    if (err.code === 11000 || err.name === 'MongoBulkWriteError') {
      result = err.result;
      rawConflicts = (err.writeErrors || []).map(we => slots[we.index]).filter(Boolean);
      console.warn('[generateLiminarSessions] ⚠️ Slots já ocupados:', rawConflicts.length);
    } else {
      throw err;
    }
  }

  // ── Enriquece conflitos: busca quem ocupa cada slot ────────────
  let conflictSlots = [];
  if (rawConflicts.length > 0) {
    const Patient = (await import('../../models/Patient.js')).default;
    const Doctor  = (await import('../models/Doctor.js')).default;

    const conflictDocs = await Promise.all(rawConflicts.map(async slot => {
      const existing = await Appointment.findOne({
        doctor: slot.doctor,
        date:   slot.date,
        time:   slot.time,
        operationalStatus: { $ne: 'canceled' }
      }).select('patient doctor patientName').lean();

      let patientName = existing?.patientName || null;
      let doctorName  = null;

      if (existing?.patient) {
        const pt = await Patient.findById(existing.patient).select('fullName').lean();
        patientName = pt?.fullName ?? patientName;
      }
      if (slot.doctor) {
        const doc = await Doctor.findById(slot.doctor).select('fullName').lean();
        doctorName = doc?.fullName ?? null;
      }

      const dateLabel = new Date(slot.date).toLocaleDateString('pt-BR', {
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo'
      });

      return {
        date:        slot.date,
        time:        slot.time,
        specialty:   slot.specialty,
        doctorId:    slot.doctor?.toString(),
        doctorName,
        patientName,
        message:     `${dateLabel} às ${slot.time} — Dr(a). ${doctorName ?? 'desconhecido'} está indisponível${patientName ? ` (ocupado com ${patientName})` : ''}`
      };
    }));

    conflictSlots = conflictDocs;
    console.warn('[generateLiminarSessions] ⚠️ Conflitos detalhados:', conflictSlots.map(c => c.message));
  }

  // ── 7b. Sync sessionValue em appointments existentes com sv=0 ──
  // Cobre casos criados por rota antiga sem sessionValue (independe da janela de datas)
  for (const [specialty, config] of activeEntries) {
    if (config.sessionValue > 0) {
      const fixed = await Appointment.updateMany(
        {
          patient:         contract.patient,
          liminarContract: contract._id,
          specialty,
          sessionValue:    { $in: [0, null] },
          operationalStatus: { $nin: ['canceled', 'completed', 'force_cancelled'] }
        },
        { $set: { sessionValue: config.sessionValue, updatedAt: new Date() } }
      );
      if (fixed.modifiedCount > 0) {
        console.log(`[generateLiminarSessions] 🔧 Fixed sessionValue=0 → ${config.sessionValue} para ${specialty}: ${fixed.modifiedCount} doc(s)`);
      }
    }
  }

  // ── 8. Cria Sessions para appointments recém-inseridos ─────────
  const upsertedIds = Object.values((result?.upsertedIds) || {});
  let createdSessionsCount = 0;

  if (upsertedIds.length > 0) {
    const newAppointments = await Appointment.find(
      { _id: { $in: upsertedIds } }
    ).lean();

    let createdSessions = [];
    try {
      const sessionDocs = newAppointments.map(a => buildLiminarSession(a));
      createdSessions = await Session.insertMany(sessionDocs);
      createdSessionsCount = createdSessions.length;

      const sessionLinkOps = createdSessions.map((s, i) => ({
        updateOne: {
          filter: { _id: newAppointments[i]._id },
          update: { $set: { session: s._id } }
        }
      }));
      await Appointment.bulkWrite(sessionLinkOps, { ordered: false });
    } catch (sessionErr) {
      // Rollback: remove appointments órfãos e sessions criadas parcialmente
      console.error('[generateLiminarSessions] ❌ Erro ao criar sessions — revertendo appointments:', sessionErr.message);
      await Appointment.deleteMany({ _id: { $in: upsertedIds } });
      if (createdSessions.length > 0) {
        await Session.deleteMany({ _id: { $in: createdSessions.map(s => s._id) } });
      }
      throw new Error(`Falha ao criar sessões para os agendamentos liminar. Os agendamentos foram revertidos. Tente novamente. Detalhe: ${sessionErr.message}`);
    }
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
    conflicts:     conflictSlots.length,
    conflictSlots,
    totalCost,
    saldo:         contract.creditBalance,
    saldoAposTudo: contract.creditBalance - totalCost
  };
}
