/**
 * 🏥 Stats Builder — Admin Dashboard V2
 *
 * KPIs rápidos com projections mínimas e aggregations leves.
 * TTL recomendado: 30s
 */

import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Doctor from '../../models/Doctor.js';
import Patient from '../../models/Patient.js';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Lead from '../../models/Leads.js';
import unifiedFinancialService, { calculateCashTotal } from '../../services/unifiedFinancialService.v2.js';

const TIMEZONE = 'America/Sao_Paulo';

// Paciente recorrente = N+ atendimentos realizados (completed) dentro da janela.
// Número principal do card: RECURRING_MIN_VISITS+ em RECURRING_WINDOW_DAYS. O detalhamento
// (todas as janelas x 3+/4+/5+) vem junto para o card exibir, sem nenhum cálculo no front.
export const RECURRING_WINDOW_DAYS = 30;
export const RECURRING_MIN_VISITS = 4;
const RECURRING_WINDOWS = [30, 45];
const RECURRING_THRESHOLDS = [3, 4, 5];

async function buildRecurringPatients(now = moment().tz(TIMEZONE)) {
  const maxDays = Math.max(...RECURRING_WINDOWS);
  const since = (days) => now.clone().subtract(days, 'days').startOf('day').toDate();

  // Uma única passada: visitas por paciente em cada janela.
  const group = { _id: '$patient' };
  for (const d of RECURRING_WINDOWS) {
    group[`v${d}`] = { $sum: { $cond: [{ $gte: ['$date', since(d)] }, 1, 0] } };
  }
  const perPatient = await Appointment.aggregate([
    {
      $match: {
        date: { $gte: since(maxDays), $lte: now.toDate() },
        operationalStatus: 'completed',
        isDeleted: { $ne: true },
        patient: { $exists: true, $ne: null }
      }
    },
    { $group: group }
  ]);

  const windows = RECURRING_WINDOWS.map((days) => {
    const visits = perPatient.map((r) => r[`v${days}`]).filter((v) => v > 0);
    const row = { days, attended: visits.length };
    for (const min of RECURRING_THRESHOLDS) {
      row[`min${min}`] = visits.filter((v) => v >= min).length;
      // % sobre os pacientes atendidos na janela (calculado aqui; o front só desenha)
      row[`pct${min}`] = row.attended > 0 ? Math.round((row[`min${min}`] / row.attended) * 100) : 0;
    }
    return row;
  });

  const headline = windows.find((w) => w.days === RECURRING_WINDOW_DAYS)?.[`min${RECURRING_MIN_VISITS}`] || 0;
  return { total: headline, windowDays: RECURRING_WINDOW_DAYS, minVisits: RECURRING_MIN_VISITS, windows };
}

export async function buildStats() {
  const t0 = Date.now();
  const today = moment().tz(TIMEZONE).startOf('day');
  const todayEnd = moment().tz(TIMEZONE).endOf('day');
  const startOfMonth = moment().tz(TIMEZONE).startOf('month');
  const startOfWeek = moment().tz(TIMEZONE).startOf('week');

  const timeit = (label, promise) => {
    const start = Date.now();
    return promise.then(r => { console.log(`[buildStats] ${label} = ${Date.now() - start}ms`); return r; });
  };

  const [
    totalDoctors,
    totalPatients,
    todayAppointments,
    weekAppointments,
    pendingPayments,
    monthRevenueAgg,
    todayRevenueAgg,
    monthLeads,
    leadsByStatus,
    recurring
  ] = await Promise.all([
    timeit('doctors.count',        Doctor.countDocuments({ active: true })),
    timeit('patients.estimated',   Patient.estimatedDocumentCount()),
    timeit('appointments.today',   Appointment.countDocuments({
      date: { $gte: today.toDate(), $lte: todayEnd.toDate() },
      operationalStatus: { $nin: ['canceled', 'pre_agendado'] }
    })),
    timeit('appointments.week',    Appointment.countDocuments({
      date: { $gte: startOfWeek.toDate(), $lte: todayEnd.toDate() },
      operationalStatus: { $nin: ['canceled', 'pre_agendado'] }
    })),
    timeit('payments.pending',     Payment.countDocuments({
      status: { $in: ['pending', 'partial'] }
    })),
    timeit('cash.month',           calculateCashTotal(startOfMonth.toDate(), todayEnd.toDate())),
    timeit('cash.today',           calculateCashTotal(today.toDate(), todayEnd.toDate())),
    timeit('leads.count',          Lead.countDocuments({
      createdAt: { $gte: startOfMonth.toDate() }
    })),
    timeit('leads.byStatus',       Lead.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfMonth.toDate() }
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ])),
    timeit('patients.recurring',   buildRecurringPatients())
  ]);

  // Mapear leads por status
  const leadsStatusMap = leadsByStatus.reduce((acc, item) => {
    acc[item._id || 'unknown'] = item.count;
    return acc;
  }, {});

  console.log(`[buildStats] TOTAL = ${Date.now() - t0}ms`);

  return {
    totalDoctors,
    totalPatients,
    activePatients: totalPatients,
    recurring,
    todayAppointments,
    weekAppointments,
    todayRevenue: todayRevenueAgg?.total || 0,
    monthRevenue: monthRevenueAgg?.total || 0,
    pendingPayments,
    monthLeads,
    leadsByStatus: leadsStatusMap,
    calculatedAt: new Date().toISOString()
  };
}
