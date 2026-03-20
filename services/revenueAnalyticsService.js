/**
 * 💰 Revenue Analytics Service
 * 
 * Serviço para análise de receita por origem, campanha e canal.
 * Permite tracking completo de GMB → Lead → Appointment → Revenue
 */

import Appointment from '../models/Appointment.js';
import Leads from '../models/Leads.js';

/**
 * 🎯 Revenue por origem (source)
 * Retorna faturamento total dividido por origem do lead
 */
export async function getRevenueBySource(startDate, endDate) {
  const matchStage = {
    paymentStatus: { $in: ['paid', 'package_paid'] },
    sessionValue: { $gt: 0 }
  };

  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  const result = await Appointment.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: '$leadSnapshot.source',
        totalRevenue: { $sum: '$sessionValue' },
        appointments: { $sum: 1 },
        avgTicket: { $avg: '$sessionValue' },
        uniqueLeads: { $addToSet: '$lead' }
      }
    },
    {
      $project: {
        source: '$_id',
        totalRevenue: 1,
        appointments: 1,
        avgTicket: { $round: ['$avgTicket', 2] },
        uniqueLeads: { $size: '$uniqueLeads' },
        _id: 0
      }
    },
    { $sort: { totalRevenue: -1 } }
  ]);

  return result;
}

/**
 * 🎯 Revenue por campanha (campaign)
 * Útil para tracking de posts GMB específicos
 */
export async function getRevenueByCampaign(startDate, endDate, source = null) {
  const matchStage = {
    paymentStatus: { $in: ['paid', 'package_paid'] },
    sessionValue: { $gt: 0 },
    'leadSnapshot.campaign': { $ne: null }
  };

  if (source) {
    matchStage['leadSnapshot.source'] = source;
  }

  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  const result = await Appointment.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: '$leadSnapshot.campaign',
        source: { $first: '$leadSnapshot.source' },
        totalRevenue: { $sum: '$sessionValue' },
        appointments: { $sum: 1 },
        avgTicket: { $avg: '$sessionValue' },
        uniqueLeads: { $addToSet: '$lead' }
      }
    },
    {
      $project: {
        campaign: '$_id',
        source: 1,
        totalRevenue: 1,
        appointments: 1,
        avgTicket: { $round: ['$avgTicket', 2] },
        uniqueLeads: { $size: '$uniqueLeads' },
        _id: 0
      }
    },
    { $sort: { totalRevenue: -1 } }
  ]);

  return result;
}

/**
 * 🎯 Revenue específico do GMB
 * Foco em campanhas do Google Business Profile
 */
export async function getGMBRevenue(startDate, endDate) {
  return getRevenueByCampaign(startDate, endDate, 'gmb');
}

/**
 * 📊 Dashboard consolidado
 * Retorna todas as métricas principais em uma chamada
 */
export async function getRevenueDashboard(startDate, endDate) {
  const [bySource, byCampaign, gmbSpecific] = await Promise.all([
    getRevenueBySource(startDate, endDate),
    getRevenueByCampaign(startDate, endDate),
    getGMBRevenue(startDate, endDate)
  ]);

  // Calcular totais
  const totalRevenue = bySource.reduce((sum, item) => sum + item.totalRevenue, 0);
  const totalAppointments = bySource.reduce((sum, item) => sum + item.appointments, 0);

  return {
    summary: {
      totalRevenue,
      totalAppointments,
      avgTicket: totalAppointments > 0 ? Math.round(totalRevenue / totalAppointments) : 0,
      sourcesCount: bySource.length,
      campaignsCount: byCampaign.length
    },
    bySource,
    byCampaign,
    gmb: gmbSpecific,
    topCampaign: byCampaign[0] || null,
    bestSource: bySource[0] || null
  };
}

/**
 * 🔍 Funnel de conversão
 * Mostra conversão de Lead → Appointment → Paid
 */
export async function getConversionFunnel(startDate, endDate, source = null) {
  const dateFilter = {};
  if (startDate) dateFilter.$gte = new Date(startDate);
  if (endDate) dateFilter.$lte = new Date(endDate);

  // Leads capturados
  const leadMatch = { createdAt: dateFilter };
  if (source) leadMatch.source = source;

  const leadsCount = await Leads.countDocuments(leadMatch);

  // Appointments criados
  const apptMatch = { createdAt: dateFilter };
  if (source) apptMatch['leadSnapshot.source'] = source;

  const appointmentsCount = await Appointment.countDocuments(apptMatch);

  // Appointments pagos
  const paidMatch = {
    ...apptMatch,
    paymentStatus: { $in: ['paid', 'package_paid'] }
  };
  const paidCount = await Appointment.countDocuments(paidMatch);

  // Revenue
  const revenueAgg = await Appointment.aggregate([
    { $match: paidMatch },
    { $group: { _id: null, total: { $sum: '$sessionValue' } } }
  ]);
  const revenue = revenueAgg[0]?.total || 0;

  return {
    leads: leadsCount,
    appointments: appointmentsCount,
    paid: paidCount,
    revenue,
    conversionRates: {
      leadToAppointment: leadsCount > 0 ? Math.round((appointmentsCount / leadsCount) * 100) : 0,
      appointmentToPaid: appointmentsCount > 0 ? Math.round((paidCount / appointmentsCount) * 100) : 0,
      leadToPaid: leadsCount > 0 ? Math.round((paidCount / leadsCount) * 100) : 0
    }
  };
}

export default {
  getRevenueBySource,
  getRevenueByCampaign,
  getGMBRevenue,
  getRevenueDashboard,
  getConversionFunnel
};
