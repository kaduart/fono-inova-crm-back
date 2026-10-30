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
  const DAYS = 14;
  const firstDay = today.clone().subtract(DAYS - 1, 'days');
  const last30Days = today.clone().subtract(29, 'days');

  // Datas para preenchimento
  const datesRange = Array.from({ length: DAYS }, (_, i) =>
    firstDay.clone().add(i, 'days').format('YYYY-MM-DD')
  );

  // Appointment.date é Date gravado como o DIA (meio-dia ou meia-noite UTC). Antes o $match
  // comparava com string 'YYYY-MM-DD' e não casava nenhum documento: o gráfico vinha zerado.
  // Janela em UTC do primeiro ao último dia, e agrupamento pelo dia UTC.
  const utcDay = (ymd, end = false) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0));
  };
  const todayYmd = today.format('YYYY-MM-DD');
  const apptRange = (fromYmd) => ({ $gte: utcDay(fromYmd), $lte: utcDay(todayYmd, true) });
  // mesmo critério do card "Sessões hoje" (statsBuilder)
  const NOT_COUNTED = ['canceled', 'pre_agendado'];

  const [
    appointmentsByDay,
    leadsByOrigin,
    revenueByDay,
    patientsBySpecialty
  ] = await Promise.all([
    // Sessões por dia (últimos 14 dias)
    Appointment.aggregate([
      {
        $match: {
          date: apptRange(firstDay.format('YYYY-MM-DD')),
          operationalStatus: { $nin: NOT_COUNTED }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
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

    // Caixa por dia (últimos 14 dias) — fonte única de verdade
    unifiedFinancialService.calculateCashByDay(firstDay.clone().startOf('day').toDate(), today.toDate()),

    // Pacientes atendidos por especialidade (últimos 30 dias): pacientes distintos, não sessões
    Appointment.aggregate([
      {
        $match: {
          date: apptRange(last30Days.format('YYYY-MM-DD')),
          operationalStatus: { $nin: NOT_COUNTED }
        }
      },
      { $group: { _id: { specialty: '$specialty', patient: '$patient' } } },
      { $group: { _id: '$_id.specialty', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 6 }
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
    appointmentsChart: datesRange.map(date => ({
      date: moment(date).format('DD/MM'),
      count: appointmentsMap[date] || 0
    })),
    revenueChart: datesRange.map(date => ({
      date: moment(date).format('DD/MM'),
      value: revenueMap[date] || 0
    })),
    leadsByOrigin,
    patientsBySpecialty,
    calculatedAt: new Date().toISOString()
  };
}
