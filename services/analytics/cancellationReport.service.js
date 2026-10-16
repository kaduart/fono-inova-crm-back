// back/services/analytics/cancellationReport.service.js
/**
 * Relatório de cancelamentos por SOLICITANTE (paciente/profissional/clínica).
 *
 * Objetivo de negócio: saber quem origina os cancelamentos e cobrar compromisso
 * (profissionais e famílias) com base em quantidade, taxa, recorrência e
 * antecedência. Todo número é calculado AQUI (backend) — o front só exibe.
 *
 * Definições (mantê-las estáveis; o front e a cobrança dependem delas):
 *  - Janela: pela DATA DO ATENDIMENTO (appointment.date), não pela data do registro.
 *  - Denominador (taxa): agendamentos reais da janela — exclui pre_agendado e
 *    cancelamentos automáticos/sistêmicos (cancelSource em SYSTEM_CANCEL_SOURCES).
 *  - Cancelamento: operationalStatus='canceled' e não automático (inclui o paciente que
 *    avisou que não virá — "falta confirmada" na UI é aviso prévio, não no-show).
 *  - Falta (separada): operationalStatus='missed' (paciente não compareceu).
 *  - Automático (separado): canceled com cancelSource em SYSTEM_CANCEL_SOURCES.
 *  - Remarcação: não gera cancelamento (o mesmo Appointment muda de data) — não entra.
 *  - Solicitante ausente => 'unspecified' ("Não informado"). Nunca inferido.
 *  - Antecedência: horário do atendimento (America/Sao_Paulo) − (cancelRequestedAt ??
 *    canceledAt), em horas. Negativa = pedido depois do horário. "Em cima da hora" = < 24h.
 */

import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Appointment from '../../models/Appointment.js';
import {
  CANCEL_REQUESTERS,
  CANCEL_REQUESTER_LABELS,
  SYSTEM_CANCEL_SOURCES,
} from '../../domain/appointment/cancelRequester.js';

const TIMEZONE = 'America/Sao_Paulo';
const LATE_HOURS = 24;
export const UNSPECIFIED = 'unspecified';
const BUCKETS = [...CANCEL_REQUESTERS, UNSPECIFIED];

const LABELS = { ...CANCEL_REQUESTER_LABELS, [UNSPECIFIED]: 'Não informado' };

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const idOf = (v) => (v && (v._id || v)) ? String(v._id || v) : null;

/** Horário do atendimento em Date (America/Sao_Paulo). `date` é guardado como UTC 12:00 do dia. */
export function appointmentMoment(row) {
  const day = new Date(row.date).toISOString().slice(0, 10);
  return moment.tz(`${day} ${row.time || '00:00'}`, 'YYYY-MM-DD HH:mm', TIMEZONE);
}

/** Antecedência em horas (1 casa). null se não houver como calcular. */
export function hoursInAdvance(row) {
  const requested = row.cancelRequestedAt || row.canceledAt;
  if (!requested || !row.date) return null;
  const diff = appointmentMoment(row).diff(moment(requested), 'minutes') / 60;
  return Math.round(diff * 10) / 10;
}

export function isAutomaticCancel(row) {
  return row.operationalStatus === 'canceled' && SYSTEM_CANCEL_SOURCES.includes(row.cancelSource);
}

// Falta = paciente não compareceu (operationalStatus 'missed'). NÃO usar
// confirmedAbsence: na UI "Falta confirmada = Sim" significa que o paciente AVISOU
// que não virá — isso é cancelamento pedido pelo paciente e precisa ficar no relatório.
export function isAbsence(row) {
  return row.operationalStatus === 'missed';
}

/** Cancelamento "de verdade" para o relatório (não falta, não automático). */
export function isReportableCancel(row) {
  return row.operationalStatus === 'canceled'
    && !SYSTEM_CANCEL_SOURCES.includes(row.cancelSource);
}

export function bucketOf(row) {
  return CANCEL_REQUESTERS.includes(row.cancelRequester) ? row.cancelRequester : UNSPECIFIED;
}

const emptyCounts = () => Object.fromEntries(BUCKETS.map((b) => [b, 0]));

/**
 * Monta o relatório a partir de linhas leves (puro — testável sem banco).
 *
 * @param {Object[]} rows        Appointments da janela (lean, com doctor/patient populados {_id, fullName})
 * @param {Object}   totals      { all, byDoctor: Map<id,number>, byPatient: Map<id,number> } — denominadores
 */
/** Maior data (YYYY-MM-DD) do atendimento cancelado. */
function laterDate(current, date) {
  const iso = new Date(date).toISOString().slice(0, 10);
  return !current || iso > current ? iso : current;
}

export function buildCancellationReport(rows, totals) {
  const cancels = rows.filter(isReportableCancel).map((r) => {
    const hours = hoursInAdvance(r);
    return { row: r, bucket: bucketOf(r), hours, late: hours !== null && hours < LATE_HOURS };
  });

  const totalCanceled = cancels.length;
  const byBucket = emptyCounts();
  const lateByBucket = emptyCounts();
  for (const c of cancels) {
    byBucket[c.bucket] += 1;
    if (c.late) lateByBucket[c.bucket] += 1;
  }

  const byRequester = BUCKETS.map((b) => ({
    requester: b,
    label: LABELS[b],
    count: byBucket[b],
    percent: pct(byBucket[b], totalCanceled),
    lessThan24h: lateByBucket[b],
  }));

  // ── Por profissional ─────────────────────────────────────────────
  // Distingue "pedido pelo profissional" de "pedido por pacientes da agenda dele".
  const doctors = new Map();
  const patients = new Map();
  for (const c of cancels) {
    const dId = idOf(c.row.doctor);
    if (dId) {
      if (!doctors.has(dId)) {
        doctors.set(dId, {
          doctorId: dId,
          name: c.row.doctor?.fullName || 'Profissional não identificado',
          specialty: c.row.doctor?.specialty || c.row.specialty || null,
          ...emptyCounts(), canceled: 0, lateByProfessional: 0, lastByProfessional: null,
        });
      }
      const d = doctors.get(dId);
      d[c.bucket] += 1;
      d.canceled += 1;
      if (c.bucket === 'professional') {
        if (c.late) d.lateByProfessional += 1;
        d.lastByProfessional = laterDate(d.lastByProfessional, c.row.date);
      }
    }
    const pId = idOf(c.row.patient);
    if (pId) {
      if (!patients.has(pId)) {
        patients.set(pId, {
          patientId: pId,
          name: c.row.patient?.fullName || 'Paciente não identificado',
          ...emptyCounts(), canceled: 0, lateByPatient: 0, lastByPatient: null,
        });
      }
      const p = patients.get(pId);
      p[c.bucket] += 1;
      p.canceled += 1;
      if (c.bucket === 'patient') {
        if (c.late) p.lateByPatient += 1;
        p.lastByPatient = laterDate(p.lastByPatient, c.row.date);
      }
    }
  }

  const professionals = [...doctors.values()].map((d) => {
    const total = totals.byDoctor.get(d.doctorId) || 0;
    return {
      doctorId: d.doctorId,
      name: d.name,
      specialty: d.specialty,
      totalAppointments: total,
      canceledTotal: d.canceled,
      requestedByProfessional: d.professional,
      requestedByPatients: d.patient,
      requestedByClinic: d.clinic,
      unspecified: d.unspecified,
      lessThan24hByProfessional: d.lateByProfessional,
      lastRequestedByProfessional: d.lastByProfessional,
      // taxa do compromisso do PRÓPRIO profissional (o que se cobra dele)
      professionalRate: pct(d.professional, total),
      // taxa geral de cancelamento da agenda dele (inclui pedidos de pacientes)
      agendaCancelRate: pct(d.canceled, total),
    };
  }).sort((a, b) => b.requestedByProfessional - a.requestedByProfessional || b.canceledTotal - a.canceledTotal);

  const patientRows = [...patients.values()].map((p) => {
    const total = totals.byPatient.get(p.patientId) || 0;
    return {
      patientId: p.patientId,
      name: p.name,
      totalAppointments: total,
      canceledTotal: p.canceled,
      requestedByPatient: p.patient,
      requestedByProfessional: p.professional,
      requestedByClinic: p.clinic,
      unspecified: p.unspecified,
      lessThan24hByPatient: p.lateByPatient,
      lastRequestedByPatient: p.lastByPatient,
      patientRate: pct(p.patient, total),
    };
  }).sort((a, b) => b.requestedByPatient - a.requestedByPatient || b.canceledTotal - a.canceledTotal);

  return {
    summary: {
      totalAppointments: totals.all,
      totalCanceled,
      cancelRate: pct(totalCanceled, totals.all),
      lessThan24h: cancels.filter((c) => c.late).length,
      absences: rows.filter(isAbsence).length,       // separado de cancelamento
      automaticCancellations: rows.filter(isAutomaticCancel).length, // separado
      unspecified: byBucket[UNSPECIFIED],
      // dos "Não informado": por canal de origem (lacuna visível, não inferida)
      unspecifiedByChannel: cancels.filter((c) => c.bucket === UNSPECIFIED).reduce((a, c) => { const k = c.row.cancelChannel || 'historico'; a[k] = (a[k] || 0) + 1; return a; }, {}),
    },
    byRequester,
    professionals,
    patients: patientRows,
  };
}

/** Linhas de detalhamento (datas, motivo, antecedência) de cancelamentos filtrados. */
export function buildCancellationDetails(rows, { requester } = {}) {
  return rows
    .filter(isReportableCancel)
    .filter((r) => !requester || bucketOf(r) === requester)
    .map((r) => {
      const hours = hoursInAdvance(r);
      return {
        appointmentId: String(r._id),
        date: new Date(r.date).toISOString().slice(0, 10),
        time: r.time || null,
        specialty: r.specialty || null,
        patientId: idOf(r.patient),
        patientName: r.patient?.fullName || null,
        doctorId: idOf(r.doctor),
        doctorName: r.doctor?.fullName || null,
        requester: bucketOf(r),
        requesterLabel: LABELS[bucketOf(r)],
        reason: r.cancelReason || null,
        requestedAt: r.cancelRequestedAt || null,
        channel: r.cancelChannel || null,
        // sem hora do pedido, a antecedência usa a hora do REGISTRO (aproximação)
        requestedAtApproximate: !r.cancelRequestedAt,
        registeredAt: r.canceledAt || null,
        registeredBy: r.canceledBy?.name || r.canceledBy?.email || null,
        hoursInAdvance: hours,
        lessThan24h: hours !== null && hours < LATE_HOURS,
      };
    })
    .sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
}

function buildMatch({ startDate, endDate, doctorId, patientId, specialty }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) {
    const err = new Error('Informe startDate e endDate no formato YYYY-MM-DD');
    err.status = 400;
    err.code = 'INVALID_PERIOD';
    throw err;
  }
  const match = {
    date: { $gte: new Date(`${startDate}T00:00:00.000Z`), $lte: new Date(`${endDate}T23:59:59.999Z`) },
    operationalStatus: { $nin: ['pre_agendado'] },
  };
  if (doctorId) match.doctor = new mongoose.Types.ObjectId(doctorId);
  if (patientId) match.patient = new mongoose.Types.ObjectId(patientId);
  if (specialty) match.specialty = specialty;
  return match;
}

async function loadRows(filters, { withUsers = false } = {}) {
  const match = buildMatch(filters);
  let q = Appointment.find(match)
    .select('date time doctor patient specialty operationalStatus cancelReason cancelSource cancelRequester cancelRequestedAt cancelChannel canceledAt canceledBy')
    .populate('doctor', 'fullName specialty')
    .populate('patient', 'fullName');
  if (withUsers) q = q.populate('canceledBy', 'name email');
  const rows = await q.lean();

  // Denominador: agendamentos reais (sem cancelamento automático/sistêmico)
  const base = rows.filter((r) => !isAutomaticCancel(r));
  const byDoctor = new Map();
  const byPatient = new Map();
  for (const r of base) {
    const d = idOf(r.doctor);
    const p = idOf(r.patient);
    if (d) byDoctor.set(d, (byDoctor.get(d) || 0) + 1);
    if (p) byPatient.set(p, (byPatient.get(p) || 0) + 1);
  }
  return { rows, totals: { all: base.length, byDoctor, byPatient } };
}

const DAY_MS = 86400000;
const toISODate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Período anterior equivalente (mesma duração, imediatamente antes). */
export function previousPeriod({ startDate, endDate }) {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  const days = Math.round((end - start) / DAY_MS) + 1;
  return { startDate: toISODate(start - days * DAY_MS), endDate: toISODate(start - DAY_MS) };
}

/** Cobertura = % dos cancelamentos com solicitante identificado. */
function coverageOf(report) {
  const total = report.summary.totalCanceled;
  const identified = total - report.summary.unspecified;
  return { total, identified, percent: total ? Math.round((identified / total) * 100) : null };
}

/**
 * Compara períodos. Diferença é sempre ABSOLUTA ("X a mais/menos"); nunca percentual
 * (base anterior zero não gera % inválido). Por solicitante só é confiável quando a
 * cobertura de identificação é parecida nos dois períodos.
 */
export function buildComparison(current, previous, prevPeriod) {
  const covCur = coverageOf(current);
  const covPrev = coverageOf(previous);
  const reliable = covCur.percent !== null && covPrev.percent !== null && covCur.percent > 0 && covPrev.percent > 0
    && Math.abs(covCur.percent - covPrev.percent) <= 20;
  const prevCount = (k) => previous.byRequester.find((r) => r.requester === k)?.count || 0;
  return {
    previousPeriod: prevPeriod,
    total: { current: current.summary.totalCanceled, previous: previous.summary.totalCanceled, diff: current.summary.totalCanceled - previous.summary.totalCanceled },
    byRequester: current.byRequester.map((r) => ({
      requester: r.requester, current: r.count, previous: prevCount(r.requester), diff: r.count - prevCount(r.requester),
    })),
    coverage: { current: covCur, previous: covPrev },
    byRequesterReliable: reliable,
  };
}

export async function getCancellationReport(filters) {
  const { rows, totals } = await loadRows(filters);
  const current = buildCancellationReport(rows, totals);

  const prevP = previousPeriod(filters);
  const prevData = await loadRows({ ...filters, ...prevP });
  const previous = buildCancellationReport(prevData.rows, prevData.totals);

  return {
    period: { startDate: filters.startDate, endDate: filters.endDate },
    ...current,
    coverage: coverageOf(current),
    comparison: buildComparison(current, previous, prevP),
  };
}

export async function getCancellationDetails(filters) {
  const { rows } = await loadRows(filters, { withUsers: true });
  return buildCancellationDetails(rows, { requester: filters.requester });
}

export default { getCancellationReport, getCancellationDetails, buildCancellationReport, buildCancellationDetails };
