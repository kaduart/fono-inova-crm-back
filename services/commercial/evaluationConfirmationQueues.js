// services/commercial/evaluationConfirmationQueues.js
/**
 * Duas filas do "Precisa de você hoje" (aprovadas pelo Kadu em 31/10/2026):
 *
 * 1. Avaliou e não fechou pacote: avaliação realizada (completed) há 3–30 dias e
 *    nenhum Package particular (therapy) criado depois dela, nem pacote ativo, nem
 *    sessão futura ativa. Mesmo conceito do "Fechou pacote" do funil de Vendas &
 *    Marketing (docs/SALES_MARKETING.md).
 * 2. Próximo dia útil sem confirmação: primeiro dia depois de hoje (até 7) que tem
 *    sessão ativa; lista as que não estão confirmadas pelo profissional nem pelo
 *    paciente (attendanceConfirmation.status).
 *
 * Só leitura em Appointment/Patient/Package/Doctor. Ver docs/COMMERCIAL_QUEUES.md.
 */
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Appointment from '../../models/Appointment.js';
import Patient from '../../models/Patient.js';
import Package from '../../models/Package.js';
import Doctor from '../../models/Doctor.js';
import CommercialContact from '../../models/CommercialContact.js';
import { FUTURE_STATUSES, daysBetween } from './commercialRules.js';

const TIMEZONE = 'America/Sao_Paulo';
export const EVALUATION_TYPES = ['evaluation', 'neuropsych_evaluation'];
// Pacote 1x/semana a R$ 180 (mesmo potencial usado em Convênios, SALES_MARKETING.md)
export const MONTHLY_PACKAGE_VALUE = 720;
const NOT_CHILD = { $or: [{ appointmentId: { $exists: false } }, { appointmentId: null }] };

const idStr = v => (v ? String(v) : '');

/** Regra pura (testável): avaliações sem fechamento depois delas. */
export function pickEvaluationsWithoutPackage(evaluations, { packages = [], futurePatientIds = new Set(), lostPatientIds = new Set() }) {
  const pkgByPatient = new Map();
  for (const p of packages) {
    const k = idStr(p.patient);
    if (!pkgByPatient.has(k)) pkgByPatient.set(k, []);
    pkgByPatient.get(k).push(p);
  }
  return evaluations.filter(ev => {
    const pid = idStr(ev.patient);
    if (futurePatientIds.has(pid) || lostPatientIds.has(pid)) return false;
    const evDate = new Date(ev.date);
    return !(pkgByPatient.get(pid) || []).some(p => {
      if (['active', 'in-progress'].includes(p.status)) return true;
      const created = p.createdAt ? new Date(p.createdAt) : p._id?.getTimestamp?.();
      return created && created >= new Date(evDate.getTime() - 86_400_000);
    });
  });
}

export async function evaluationsWithoutPackage({ minDays = 3, maxDays = 30, limit = 100 } = {}) {
  const now = moment().tz(TIMEZONE);
  const from = now.clone().subtract(maxDays, 'days').startOf('day').toDate();
  const to = now.clone().subtract(minDays, 'days').endOf('day').toDate();

  const evals = await Appointment.aggregate([
    {
      $match: {
        serviceType: { $in: EVALUATION_TYPES },
        operationalStatus: 'completed',
        isDeleted: { $ne: true },
        patient: { $exists: true, $ne: null },
        billingType: { $nin: ['convenio', 'liminar'] },
        date: { $gte: from, $lte: to },
      },
    },
    { $sort: { date: -1 } },
    { $group: { _id: '$patient', patient: { $first: '$patient' }, date: { $first: '$date' }, doctor: { $first: '$doctor' }, specialty: { $first: '$specialty' }, appointmentId: { $first: '$_id' } } },
  ]);
  if (!evals.length) return { items: [], total: 0, potentialMonthly: 0 };

  const pids = evals.map(e => e.patient);
  const todayStart = now.clone().startOf('day').toDate();
  const [packages, future, lost] = await Promise.all([
    Package.find({ patient: { $in: pids }, type: { $nin: ['convenio', 'liminar'] }, status: { $ne: 'canceled' } }, { patient: 1, status: 1 }).lean(),
    Appointment.distinct('patient', { patient: { $in: pids }, isDeleted: { $ne: true }, date: { $gte: todayStart }, operationalStatus: { $in: FUTURE_STATUSES } }),
    CommercialContact.distinct('target', { target: { $in: pids }, kind: 'evaluation_lost', createdAt: { $gte: from } }),
  ]);

  const open = pickEvaluationsWithoutPackage(evals, {
    packages,
    futurePatientIds: new Set(future.map(String)),
    lostPatientIds: new Set(lost.map(String)),
  }).slice(0, limit);
  if (!open.length) return { items: [], total: 0, potentialMonthly: 0 };

  const openIds = open.map(e => e.patient);
  const [patients, doctors, contacts] = await Promise.all([
    Patient.find({ _id: { $in: openIds } }, { fullName: 1, phone: 1 }).lean(),
    Doctor.find({ _id: { $in: open.map(e => e.doctor).filter(Boolean) } }, { fullName: 1 }).lean(),
    CommercialContact.aggregate([
      { $match: { target: { $in: openIds }, kind: 'evaluation' } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$target', at: { $first: '$createdAt' }, note: { $first: '$note' } } },
    ]),
  ]);
  const pMap = Object.fromEntries(patients.map(p => [idStr(p._id), p]));
  const dMap = Object.fromEntries(doctors.map(d => [idStr(d._id), d.fullName]));
  const cMap = Object.fromEntries(contacts.map(c => [idStr(c._id), c]));

  const items = open
    .filter(e => pMap[idStr(e.patient)])
    .map(e => {
      const pid = idStr(e.patient);
      return {
        patientId: pid,
        appointmentId: idStr(e.appointmentId),
        name: pMap[pid].fullName || 'Paciente',
        phone: pMap[pid].phone || '',
        specialty: e.specialty || null,
        doctorName: e.doctor ? dMap[idStr(e.doctor)] || null : null,
        evaluatedAt: e.date,
        daysSince: daysBetween(e.date, now.toDate()),
        lastContactAt: cMap[pid]?.at || null,
        lastContactNote: cMap[pid]?.note || null,
      };
    })
    .sort((a, b) => a.daysSince - b.daysSince);

  return { items, total: items.length, potentialMonthly: items.length * MONTHLY_PACKAGE_VALUE };
}

/** Classificação pura (testável) de uma sessão ainda não confirmada. */
export function confirmationState(appt, phone) {
  const st = appt.attendanceConfirmation?.status;
  if (st === 'change_requested') return 'change_requested';
  if (st === 'review_required') return 'review_required';
  if (!phone) return 'no_phone';
  if (appt.attendanceConfirmation?.sentAt || appt.attendanceConfirmation?.queuedAt) return 'no_reply';
  return 'not_sent';
}

export async function unconfirmedNextDay({ date } = {}) {
  const now = moment().tz(TIMEZONE);
  let day;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    day = moment.tz(date, 'YYYY-MM-DD', TIMEZONE);
  } else {
    // Próximo dia (até 7) com sessão ativa: domingo/feriado sem agenda é pulado sozinho.
    const rows = await Appointment.aggregate([
      { $match: { date: { $gte: now.clone().add(1, 'day').startOf('day').toDate(), $lte: now.clone().add(7, 'days').endOf('day').toDate() }, operationalStatus: { $in: FUTURE_STATUSES }, isDeleted: { $ne: true }, ...NOT_CHILD } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: TIMEZONE } } } },
      { $sort: { _id: 1 } },
      { $limit: 1 },
    ]);
    if (!rows.length) return { date: null, total: 0, confirmed: 0, items: [] };
    day = moment.tz(rows[0]._id, 'YYYY-MM-DD', TIMEZONE);
  }

  const appts = await Appointment.find(
    { date: { $gte: day.clone().startOf('day').toDate(), $lte: day.clone().endOf('day').toDate() }, operationalStatus: { $in: FUTURE_STATUSES }, isDeleted: { $ne: true }, ...NOT_CHILD },
    { date: 1, time: 1, patient: 1, doctor: 1, specialty: 1, operationalStatus: 1, attendanceConfirmation: 1, 'patientInfo.fullName': 1, 'patientInfo.phone': 1 },
  ).sort({ time: 1 }).lean();

  const isConfirmed = a => a.operationalStatus === 'confirmed' || a.attendanceConfirmation?.status === 'confirmed';
  const pending = appts.filter(a => !isConfirmed(a));
  const pids = [...new Set(pending.map(a => idStr(a.patient)).filter(Boolean))].map(id => new mongoose.Types.ObjectId(id));
  const since30 = now.clone().subtract(30, 'days').startOf('day').toDate();
  const [patients, doctors, missed] = await Promise.all([
    Patient.find({ _id: { $in: pids } }, { fullName: 1, phone: 1 }).lean(),
    Doctor.find({ _id: { $in: pending.map(a => a.doctor).filter(Boolean) } }, { fullName: 1 }).lean(),
    pids.length ? Appointment.aggregate([
      { $match: { patient: { $in: pids }, operationalStatus: 'missed', date: { $gte: since30 } } },
      { $group: { _id: '$patient', n: { $sum: 1 } } },
    ]) : [],
  ]);
  const pMap = Object.fromEntries(patients.map(p => [idStr(p._id), p]));
  const dMap = Object.fromEntries(doctors.map(d => [idStr(d._id), d.fullName]));
  const mMap = Object.fromEntries(missed.map(m => [idStr(m._id), m.n]));

  const items = pending.map(a => {
    const pid = idStr(a.patient);
    const phone = pMap[pid]?.phone || a.patientInfo?.phone || '';
    return {
      appointmentId: idStr(a._id),
      patientId: pid || null,
      name: pMap[pid]?.fullName || a.patientInfo?.fullName || 'Paciente',
      phone,
      time: a.time || '',
      specialty: a.specialty || null,
      doctorName: a.doctor ? dMap[idStr(a.doctor)] || null : null,
      status: a.operationalStatus,
      state: confirmationState(a, phone),
      sentAt: a.attendanceConfirmation?.sentAt || a.attendanceConfirmation?.queuedAt || null,
      respondedAt: a.attendanceConfirmation?.respondedAt || null,
      responseText: a.attendanceConfirmation?.responseText || null,
      missed30: mMap[pid] || 0,
    };
  });

  return { date: day.format('YYYY-MM-DD'), total: appts.length, confirmed: appts.length - pending.length, items };
}

/** Texto do lembrete (a enquete "Confirmar presença" é anexada pelo envio de confirmação). */
export function confirmationReminderText({ name, date, time, doctorName }) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const d = moment.tz(date, 'YYYY-MM-DD', TIMEZONE);
  const DAYS = ['no domingo', 'na segunda-feira', 'na terça-feira', 'na quarta-feira', 'na quinta-feira', 'na sexta-feira', 'no sábado'];
  const when = `${DAYS[d.day()]}, ${d.format('DD/MM')}${time ? `, às ${time}` : ''}`;
  return `Olá! Aqui é da Clínica Fono Inova. Passando para confirmar a sessão${first ? ` de ${first}` : ''} ${when}${doctorName ? `, com ${doctorName}` : ''}. Você confirma a presença?`;
}
