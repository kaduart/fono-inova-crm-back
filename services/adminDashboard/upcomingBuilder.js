/**
 * 📅 Upcoming Appointments Builder — Admin Dashboard V2
 *
 * Próximas consultas com projection mínima.
 * TTL recomendado: 15s
 */

import moment from 'moment-timezone';
import Appointment from '../../models/Appointment.js';

const TIMEZONE = 'America/Sao_Paulo';

export async function buildUpcomingAppointments(limit = 10) {
  const today = moment().tz(TIMEZONE).startOf('day').toDate();
  const nextWeek = moment().tz(TIMEZONE).add(7, 'days').endOf('day').toDate();

  const appointments = await Appointment.find({
    date: { $gte: today, $lte: nextWeek },
    operationalStatus: { $nin: ['canceled', 'completed', 'pre_agendado'] },
    $or: [
      { appointmentId: { $exists: false } },
      { appointmentId: null }
    ]
  })
    .select('date time reason operationalStatus patient doctor')
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
    patientName: appt.patient?.fullName || 'Paciente não encontrado',
    professionalName: appt.doctor?.fullName || 'Profissional não encontrado',
    specialty: appt.doctor?.specialty || ''
  }));
}
