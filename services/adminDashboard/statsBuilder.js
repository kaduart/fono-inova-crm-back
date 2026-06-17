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
    leadsByStatus
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
    ]))
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
