/**
 * 📊 Charts Builder — Admin Dashboard V2
 *
 * Dados agregados para gráficos. Mais pesado que stats.
 * TTL recomendado: 5 minutos
 */

import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Lead from '../../models/Leads.js';
import unifiedFinancialService from '../../services/unifiedFinancialService.v2.js';

const TIMEZONE = 'America/Sao_Paulo';

export async function buildCharts() {
  const today = moment().tz(TIMEZONE);
  const last7Days = today.clone().subtract(6, 'days');
  const last30Days = today.clone().subtract(29, 'days');

  // Datas para preenchimento
  const dates7Days = Array.from({ length: 7 }, (_, i) =>
    last7Days.clone().add(i, 'days').format('YYYY-MM-DD')
  );

  const [
    appointmentsByDay,
    leadsByOrigin,
    revenueByDay,
    patientsBySpecialty
  ] = await Promise.all([
    // Agendamentos por dia (últimos 7 dias)
    Appointment.aggregate([
      {
        $match: {
          date: { $gte: last7Days.format('YYYY-MM-DD') },
          operationalStatus: { $nin: ['canceled'] }
        }
      },
      {
        $group: {
          _id: '$date',
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]),

    // Leads por origem (últimos 30 dias)
    Lead.aggregate([
      {
        $match: {
          createdAt: { $gte: last30Days.toDate() }
        }
      },
      {
        $group: {
          _id: '$origin',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 6 }
    ]),

    // Receita por dia (últimos 7 dias) — fonte única de verdade
    unifiedFinancialService.calculateCashByDay(last7Days.toDate(), today.toDate()),

    // Pacientes por especialidade (últimos 30 dias)
    Appointment.aggregate([
      {
        $match: {
          date: { $gte: last30Days.format('YYYY-MM-DD') },
          operationalStatus: { $nin: ['canceled'] }
        }
      },
      {
        $group: {
          _id: '$specialty',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ])
  ]);

  // Preencher dias sem dados
  const appointmentsMap = appointmentsByDay.reduce((acc, item) => {
    acc[item._id] = item.count;
    return acc;
  }, {});

  const revenueMap = {};
  if (revenueByDay instanceof Map) {
    revenueByDay.forEach((value, key) => {
      revenueMap[key] = value.caixa || 0;
    });
  } else {
    revenueByDay.forEach(item => {
      revenueMap[item._id] = item.total;
    });
  }

  return {
    appointmentsChart: dates7Days.map(date => ({
      date: moment(date).format('DD/MM'),
      count: appointmentsMap[date] || 0
    })),
    revenueChart: dates7Days.map(date => ({
      date: moment(date).format('DD/MM'),
      value: revenueMap[date] || 0
    })),
    leadsByOrigin,
    patientsBySpecialty,
    calculatedAt: new Date().toISOString()
  };
}
