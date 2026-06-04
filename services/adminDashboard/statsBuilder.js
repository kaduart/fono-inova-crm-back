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
import unifiedFinancialService from '../../services/unifiedFinancialService.v2.js';

const TIMEZONE = 'America/Sao_Paulo';

export async function buildStats() {
  const today = moment().tz(TIMEZONE).startOf('day');
  const todayEnd = moment().tz(TIMEZONE).endOf('day');
  const startOfMonth = moment().tz(TIMEZONE).startOf('month');
  const startOfWeek = moment().tz(TIMEZONE).startOf('week');

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
    // Total profissionais ativos
    Doctor.countDocuments({ active: true }),

    // Total pacientes
    Patient.estimatedDocumentCount(),

    // Agendamentos de hoje (exclui cancelados e pré-agendados)
    Appointment.countDocuments({
      date: { $gte: today.toDate(), $lte: todayEnd.toDate() },
      operationalStatus: { $nin: ['canceled', 'pre_agendado'] }
    }),

    // Agendamentos da semana
    Appointment.countDocuments({
      date: { $gte: startOfWeek.toDate(), $lte: todayEnd.toDate() },
      operationalStatus: { $nin: ['canceled', 'pre_agendado'] }
    }),

    // Pagamentos pendentes ou parciais
    Payment.countDocuments({
      status: { $in: ['pending', 'partial'] }
    }),

    // Receita do mês (fonte única de verdade)
    unifiedFinancialService.calculateCash(startOfMonth.toDate(), todayEnd.toDate()),

    // Receita de hoje (fonte única de verdade)
    unifiedFinancialService.calculateCash(today.toDate(), todayEnd.toDate()),

    // Leads do mês
    Lead.countDocuments({
      createdAt: { $gte: startOfMonth.toDate() }
    }),

    // Leads por status (mês atual)
    Lead.aggregate([
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
    ])
  ]);

  // Mapear leads por status
  const leadsStatusMap = leadsByStatus.reduce((acc, item) => {
    acc[item._id || 'unknown'] = item.count;
    return acc;
  }, {});

  return {
    totalDoctors,
    totalPatients,
    activePatients: totalPatients, // TODO: definir critério de "ativo"
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
