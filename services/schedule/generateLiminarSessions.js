// services/schedule/generateLiminarSessions.js
// Gera appointments a partir de TherapeuticPlan com slots { dayOfWeek, time }.
// Idempotente via bulkWrite upsert — chamar N vezes não duplica.

import Appointment from '../../models/Appointment.js';
import TherapeuticPlan from '../../models/TherapeuticPlan.js';
import LiminarContract from '../../models/LiminarContract.js';
import { buildDateTime, buildDayRange } from '../../utils/datetime.js';
import { getHolidaysWithNames } from '../../config/feriadosBR-dynamic.js';

/**
 * Gera appointments para um plano terapêutico dentro de uma janela de datas.
 *
 * @param {string}       planId        - ID do TherapeuticPlan ativo
 * @param {string|Date}  startDate     - Início da janela (inclusive)
 * @param {string|Date}  endDate       - Fim da janela (inclusive, max 90 dias)
 * @param {boolean}      skipHolidays  - Pular feriados nacionais (default: true)
 * @returns {{ created, skipped, total, totalCost, saldo, saldoAposTudo }}
 */
export async function generateLiminarSessions({
  planId,
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

  // ── 2. Feriados do período ─────────────────────────────────────
  const start = new Date(startDate); start.setHours(0,0,0,0);
  const end   = new Date(endDate);   end.setHours(23,59,59,999);

  const holidays = new Set();
  if (skipHolidays) {
    const years = new Set();
    const cur = new Date(start);
    while (cur <= end) { years.add(cur.getFullYear()); cur.setDate(cur.getDate() + 1); }
    for (const year of years) {
      for (const h of getHolidaysWithNames(year)) holidays.add(h.date);
    }
  }

  // ── 3. Normaliza therapies (Map → plain object ao usar .lean()) ─
  const therapies = plan.therapies instanceof Map
    ? Object.fromEntries(plan.therapies)
    : (plan.therapies || {});

  // ── 4. Gera slots iterando dia a dia ───────────────────────────
  // Cada slot do plano: { dayOfWeek: 1, time: "14:00" }
  const slots = [];
  const walker = new Date(start);

  while (walker <= end) {
    const dayOfWeek = walker.getDay();
    const dateStr   = walker.toISOString().split('T')[0]; // 'YYYY-MM-DD'

    if (!holidays.has(dateStr)) {
      for (const [specialty, config] of Object.entries(therapies)) {
        const planSlots = Array.isArray(config.slots) ? config.slots : [];

        for (const slot of planSlots) {
          if (slot.dayOfWeek === dayOfWeek) {
            slots.push({
              specialty,
              dateStr,
              time:         slot.time,
              date:         buildDateTime(dateStr, slot.time),
              sessionValue: config.sessionValue,
              duration:     config.sessionDurationMinutes || 50
            });
          }
        }
      }
    }

    walker.setDate(walker.getDate() + 1);
  }

  if (slots.length === 0) {
    return { created: 0, skipped: 0, total: 0, totalCost: 0, saldo: contract.creditBalance, saldoAposTudo: contract.creditBalance };
  }

  // ── 5. Alerta de saldo (não bloqueia) ─────────────────────────
  const totalCost = slots.reduce((s, sl) => s + sl.sessionValue, 0);
  if (contract.creditBalance < totalCost) {
    console.warn('[generateLiminarSessions] ⚠️ Saldo insuficiente para toda a janela', {
      contractId:    contract._id,
      creditBalance: contract.creditBalance,
      totalCost,
      slotCount:     slots.length
    });
  }

  // ── 6. bulkWrite upsert ────────────────────────────────────────
  // Chave de unicidade: paciente + contrato + especialidade + data + horário
  // Permite: mesma especialidade duas vezes no dia em horários diferentes (edge case válido)
  // Impede: duplicar o mesmo slot exato
  const bulkOps = slots.map(slot => ({
    updateOne: {
      filter: {
        patient:           contract.patient,
        liminarContract:   contract._id,
        specialty:         slot.specialty,
        time:              slot.time,
        date:              buildDayRange(slot.dateStr),  // BRT-aware: -03:00
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

  console.log('[generateLiminarSessions] ✅ Concluído', {
    contractId: contract._id.toString(),
    planId:     plan._id.toString(),
    version:    plan.version,
    window:     `${startDate} → ${endDate}`,
    created:    result.upsertedCount,
    skipped:    result.matchedCount,
    total:      slots.length
  });

  return {
    created:       result.upsertedCount,
    skipped:       result.matchedCount,      // já existiam, não duplicou
    total:         slots.length,
    totalCost,
    saldo:         contract.creditBalance,
    saldoAposTudo: contract.creditBalance - totalCost  // estimativa antes das sessões serem completadas
  };
}
