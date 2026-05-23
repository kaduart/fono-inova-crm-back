/**
 * 🏥 operational.v2.js — Painel Operacional da Clínica
 *
 * Endpoints leves para alimentar a central de comando do dia.
 * Foco: dados operacionais que não existem nos endpoints financeiros.
 */
import { Router } from 'express';
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Appointment from '../models/Appointment.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
const TIMEZONE = 'America/Sao_Paulo';

/**
 * GET /api/v2/operational/patients-without-next-session
 *
 * Retorna pacientes que foram atendidos HOJE mas não têm próxima sessão agendada.
 * Critério: appointment.completed hoje + sem appointment futuro para o mesmo paciente.
 */
router.get('/patients-without-next-session', flexibleAuth, asyncHandler(async (req, res) => {
  const todayStart = moment.tz(TIMEZONE).startOf('day').toDate();
  const todayEnd = moment.tz(TIMEZONE).endOf('day').toDate();

  // 1. Buscar appointments completados hoje
  const todayAppointments = await Appointment.find({
    date: { $gte: todayStart, $lte: todayEnd },
    operationalStatus: 'completed'
  }).select('patient patientInfo operationalStatus date time specialty doctor serviceType').lean();

  if (todayAppointments.length === 0) {
    return res.json({
      success: true,
      total: 0,
      recurrent: 0,
      impactMonthly: 0,
      patients: []
    });
  }

  // 2. Extrair IDs únicos de pacientes
  const patientIds = [...new Set(
    todayAppointments
      .map(a => a.patient?.toString())
      .filter(Boolean)
  )];

  // 3. Buscar quais pacientes TÊM appointment futuro
  const futureAppointments = await Appointment.find({
    patient: { $in: patientIds },
    date: { $gt: todayEnd }
  }).select('patient').lean();

  const patientsWithFuture = new Set(futureAppointments.map(a => a.patient?.toString()));

  // 4. Filtrar pacientes SEM próxima sessão
  const patientsWithoutNext = todayAppointments.filter(
    a => !patientsWithFuture.has(a.patient?.toString())
  );

  // 5. Agrupar por paciente (pegar o último appointment de hoje como referência)
  const grouped = {};
  patientsWithoutNext.forEach(a => {
    const pid = a.patient?.toString();
    if (!grouped[pid]) {
      grouped[pid] = {
        patientId: pid,
        name: a.patientInfo?.fullName || 'Paciente sem nome',
        phone: a.patientInfo?.phone || '',
        lastSessionDate: a.date,
        lastSessionTime: a.time,
        specialty: a.specialty || '',
        doctor: a.doctor,
        count: 0
      };
    }
    grouped[pid].count += 1;
  });

  const patients = Object.values(grouped);

  // 6. Heurística: recorrentes = pacientes com ≥3 sessões nos últimos 90d
  const recurrentIds = [];
  if (patients.length > 0) {
    const ninetyDaysAgo = moment.tz(TIMEZONE).subtract(90, 'days').startOf('day').toDate();
    const historyCounts = await Appointment.aggregate([
      { $match: { patient: { $in: patientIds.map(id => new mongoose.Types.ObjectId(id)) }, date: { $gte: ninetyDaysAgo } } },
      { $group: { _id: '$patient', total: { $sum: 1 } } },
      { $match: { total: { $gte: 3 } } }
    ]);
    historyCounts.forEach(h => recurrentIds.push(h._id.toString()));
  }

  const recurrent = patients.filter(p => recurrentIds.includes(p.patientId)).length;

  // 7. Impacto estimado: recorrentes * ticket médio estimado (R$ 180 como baseline) * 4 semanas
  const AVG_SESSION_VALUE = 180;
  const impactMonthly = recurrent * AVG_SESSION_VALUE * 4;

  res.json({
    success: true,
    total: patients.length,
    recurrent,
    impactMonthly,
    patients: patients.map(p => ({
      patientId: p.patientId,
      name: p.name,
      phone: p.phone,
      lastSessionDate: p.lastSessionDate,
      lastSessionTime: p.lastSessionTime,
      specialty: p.specialty,
      isRecurrent: recurrentIds.includes(p.patientId)
    }))
  });
}));

export default router;
