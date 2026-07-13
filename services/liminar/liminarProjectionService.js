// services/liminar/liminarProjectionService.js
// Projeção de esgotamento de crédito judicial (liminar) — analytics, não saldo.
//
// Responsabilidade única: estimar quando o creditBalance de um LiminarContract
// chegaria a zero, dado o ritmo de consumo (sessões/semana) do paciente.
//
// METODOLOGIA (decisão de produto 2026-07-11):
//   1. scheduled_plan — se houver pelo menos 2 semanas futuras com appointments
//      scheduled/confirmed/pre_agendado, o ritmo vem do plano terapêutico vigente
//      (frequência que a clínica já definiu para esse paciente). Prioridade sobre
//      o histórico porque reflete a decisão clínica atual, não uma média que pode
//      incluir semanas de ritmo antigo já superado.
//   2. historical_last_weeks — fallback quando não há agenda futura suficiente:
//      média das últimas 4 semanas com sessão COMPLETADA.
//
// IMPORTANTE — âncora de data no histórico:
// A fonte cronológica é sempre appointment.date (data real do atendimento),
// NUNCA creditHistory[].createdAt. Conclusões retroativas (ex: appointment
// completado dias/semanas depois de um bug de status) gravam createdAt =
// momento da ação no sistema, não o dia do atendimento — usar createdAt como
// proxy cronológico distorce silenciosamente o ritmo calculado.
// Ver back/docs/DOMAIN_INVARIANTS.md (tabela de campos de data).

import Appointment from '../../models/Appointment.js';

const FUTURE_STATUSES = ['scheduled', 'confirmed', 'pre_agendado'];
const FUTURE_SAMPLE_WEEKS = 4;
const HISTORICAL_SAMPLE_WEEKS = 4;
const MIN_FUTURE_WEEKS_FOR_PLAN = 2;

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {Object} contract - documento LiminarContract (lean ou hidratado):
 *   precisa de _id, creditBalance e creditHistory
 * @returns {Promise<Object|null>} projeção, ou null se não há dado suficiente
 *   (nem agenda futura, nem histórico de débito)
 */
export async function computeExhaustionProjection(contract) {
  // ── 0. Data de início do tratamento — primeira sessão já debitada (todo o
  // histórico, não só a amostra usada no ritmo). Sem nenhuma sessão completada
  // ainda, cai para a data de criação do contrato (não há tratamento iniciado). ──
  const allDebits = (contract.creditHistory || []).filter(h => h.type === 'debit' && h.appointmentId);
  let treatmentStartDate = contract.createdAt || null;
  let dateById = new Map();
  if (allDebits.length > 0) {
    const allAppointmentIds = allDebits.map(d => d.appointmentId);
    const allAppointments = await Appointment.find(
      { _id: { $in: allAppointmentIds } },
      { date: 1 }
    ).lean();
    dateById = new Map(allAppointments.map(a => [a._id.toString(), a.date]));
    const allRealDates = allDebits
      .map(d => dateById.get(d.appointmentId.toString()))
      .filter(Boolean)
      .map(d => new Date(d));
    if (allRealDates.length > 0) {
      treatmentStartDate = new Date(Math.min(...allRealDates.map(d => d.getTime())));
    }
  }

  // ── 1. Tenta metodologia prioritária: plano terapêutico vigente (agenda futura) ──
  const futureAppts = await Appointment.find(
    { liminarContract: contract._id, operationalStatus: { $in: FUTURE_STATUSES } },
    { date: 1, sessionValue: 1 }
  ).sort({ date: 1 }).lean();

  const futureByWeek = new Map();
  for (const a of futureAppts) {
    if (!a.date) continue;
    const wk = isoWeekKey(new Date(a.date));
    const entry = futureByWeek.get(wk) || { count: 0, total: 0 };
    entry.count += 1;
    entry.total += (a.sessionValue || 0);
    futureByWeek.set(wk, entry);
  }
  const futureWeeks = [...futureByWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  let sampleWeeksData;
  let methodology;
  let anchorDate;

  if (futureWeeks.length >= MIN_FUTURE_WEEKS_FOR_PLAN) {
    // Usa as próximas N semanas mais próximas — semanas muito distantes tendem a
    // estar sub-preenchidas só porque a secretária ainda não agendou tão à frente,
    // não porque o ritmo real vá cair.
    sampleWeeksData = futureWeeks.slice(0, FUTURE_SAMPLE_WEEKS);
    methodology = 'scheduled_plan';
    anchorDate = new Date();
  } else {
    // ── 2. Fallback: histórico das últimas semanas com sessão completada ──
    if (allDebits.length === 0) return null;

    const byWeek = new Map();
    let lastRealDate = null;
    for (const d of allDebits) {
      const realDate = dateById.get(d.appointmentId.toString());
      if (!realDate) continue; // appointment deletado/órfão — fora da amostra
      const wk = isoWeekKey(new Date(realDate));
      const entry = byWeek.get(wk) || { count: 0, total: 0 };
      entry.count += 1;
      entry.total += d.amount;
      byWeek.set(wk, entry);
      if (!lastRealDate || new Date(realDate) > lastRealDate) lastRealDate = new Date(realDate);
    }
    if (byWeek.size === 0) return null;

    const historyWeeks = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    sampleWeeksData = historyWeeks.slice(-HISTORICAL_SAMPLE_WEEKS);
    methodology = 'historical_last_weeks';
    anchorDate = lastRealDate;
  }

  const sumCount = sampleWeeksData.reduce((s, [, v]) => s + v.count, 0);
  const sumValue = sampleWeeksData.reduce((s, [, v]) => s + v.total, 0);
  if (sumCount === 0 || sumValue === 0) return null;

  const averageSessionsPerWeek = sumCount / sampleWeeksData.length;
  const averageSessionValue = sumValue / sumCount;
  const weeklyConsumption = sumValue / sampleWeeksData.length;

  const remainingSessions = contract.creditBalance / averageSessionValue;
  const remainingWeeks = remainingSessions / averageSessionsPerWeek;
  const estimatedExhaustionDate = new Date(anchorDate.getTime() + remainingWeeks * 7 * 86400000);

  // scheduled_plan é sempre mais confiável que extrapolação de histórico —
  // reflete a frequência que a clínica decidiu, não uma média que pode estar
  // capturando um ritmo já superado.
  const confidence = methodology === 'scheduled_plan'
    ? (sampleWeeksData.length >= FUTURE_SAMPLE_WEEKS ? 'high' : 'medium')
    : (sampleWeeksData.length >= 3 ? 'medium' : 'low');

  return {
    methodology, // 'scheduled_plan' | 'historical_last_weeks'
    treatmentStartDate,
    averageSessionsPerWeek: round2(averageSessionsPerWeek),
    averageSessionValue: round2(averageSessionValue),
    weeklyConsumption: round2(weeklyConsumption),
    remainingSessions: round1(remainingSessions),
    remainingWeeks: round1(remainingWeeks),
    estimatedExhaustionDate,
    confidence,
    sampleWeeks: sampleWeeksData.length
  };
}

export default { computeExhaustionProjection };
