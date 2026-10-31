/**
 * 📅 Upcoming Appointments Builder — Admin Dashboard V2
 *
 * Próximas consultas com projection mínima.
 * TTL recomendado: 15s
 */

import moment from 'moment-timezone';
import Appointment from '../../models/Appointment.js';

const TIMEZONE = 'America/Sao_Paulo';

// Agendamento ativo = mesmo conceito da Retenção/Comercial (DOMAIN_INVARIANTS:
// pre_agendado entra em todo filtro ativo — decisão do Kadu, 31/10/2026).
export const ACTIVE_STATUSES = ['pre_agendado', 'scheduled', 'confirmed'];
const NOT_CHILD = { $or: [{ appointmentId: { $exists: false } }, { appointmentId: null }] };

// "Não confirmada" = ativa, sem confirmação do profissional (operationalStatus) nem
// do paciente pelo WhatsApp (attendanceConfirmation.status).
const UNCONFIRMED = {
  operationalStatus: { $in: ['pre_agendado', 'scheduled'] },
  'attendanceConfirmation.status': { $ne: 'confirmed' },
};

/**
 * Contagens REAIS dos próximos 7 dias (o front não pode contar sobre a lista
 * limitada — auditoria 31/10/2026, A1). Datas agrupadas no fuso de São Paulo.
 */
export async function buildUpcomingCounts() {
  const now = moment().tz(TIMEZONE);
  const today = now.clone().startOf('day');
  const nextWeek = now.clone().add(7, 'days').endOf('day');
  const match = {
    date: { $gte: today.toDate(), $lte: nextWeek.toDate() },
    operationalStatus: { $in: ACTIVE_STATUSES },
    ...NOT_CHILD,
  };
  const [rows] = await Appointment.aggregate([
    { $match: match },
    {
      $facet: {
        byDay: [
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: TIMEZONE } }, count: { $sum: 1 } } },
        ],
        unconfirmed: [
          { $match: UNCONFIRMED },
          { $count: 'n' },
        ],
      },
    },
  ]);
  const byDay = Object.fromEntries((rows?.byDay || []).map(r => [r._id, r.count]));
  const todayYmd = today.format('YYYY-MM-DD');
  const tomorrowYmd = today.clone().add(1, 'day').format('YYYY-MM-DD');
  return {
    all: Object.values(byDay).reduce((a, b) => a + b, 0),
    today: byDay[todayYmd] || 0,
    tomorrow: byDay[tomorrowYmd] || 0,
    unconfirmed: rows?.unconfirmed?.[0]?.n || 0,
  };
}

export async function buildUpcomingAppointments(limit = 10) {
  const today = moment().tz(TIMEZONE).startOf('day').toDate();
  const nextWeek = moment().tz(TIMEZONE).add(7, 'days').endOf('day').toDate();

  const appointments = await Appointment.find({
    date: { $gte: today, $lte: nextWeek },
    operationalStatus: { $in: ACTIVE_STATUSES },
    ...NOT_CHILD
  })
    .select('date time reason operationalStatus attendanceConfirmation.status patient doctor')
    .populate('patient', 'fullName')
    .populate('doctor', 'fullName specialty')
    .sort({ date: 1, time: 1 })
    .limit(limit)
    .lean();

  console.log(`[upcomingBuilder] Encontradas ${appointments.length} consultas`);

  return appointments.map(appt => ({
    _id: appt._id,
    date: appt.date,
    time: appt.time,
    reason: appt.reason,
    status: appt.operationalStatus,
    confirmed: appt.operationalStatus === 'confirmed' || appt.attendanceConfirmation?.status === 'confirmed',
    patientName: appt.patient?.fullName || 'Paciente não encontrado',
    professionalName: appt.doctor?.fullName || 'Profissional não encontrado',
    specialty: appt.doctor?.specialty || ''
  }));
}
