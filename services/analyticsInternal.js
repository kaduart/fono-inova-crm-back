/**
 * 📊 Analytics Interno - Dados do próprio sistema
 * Usado como fallback quando GA4 não está disponível
 */

import Leads from '../models/Leads.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';

/**
 * Busca eventos/métricas internas do sistema
 */
export const getInternalAnalytics = async (startDate, endDate) => {
  try {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    // Contagem de leads criados no período
    const leadsCount = await Leads.countDocuments({
      createdAt: { $gte: start, $lte: end }
    });

    // Contagem de agendamentos
    const appointmentsCount = await Appointment.countDocuments({
      createdAt: { $gte: start, $lte: end }
    });

    // Contagem de novos pacientes
    const newPatients = await Patient.countDocuments({
      createdAt: { $gte: start, $lte: end }
    });

    // Contagem de pré-agendamentos
    const preAgendamentos = await Appointment.countDocuments({
      operationalStatus: 'pre_agendado',
      createdAt: { $gte: start, $lte: end }
    });

    // Leads por origem
    const leadsByOrigin = await Leads.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$origin', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Eventos baseados em dados reais do CRM (sem page_view — esse vem do GA4)
    const events = [
      { action: 'lead_created', value: leadsCount, timestamp: new Date() },
      { action: 'appointment_scheduled', value: appointmentsCount, timestamp: new Date() },
      { action: 'new_patient', value: newPatients, timestamp: new Date() },
      { action: 'pre_appointment', value: preAgendamentos, timestamp: new Date() },
      ...leadsByOrigin.map(o => ({
        action: `lead_origin_${o._id || 'unknown'}`,
        value: o.count,
        timestamp: new Date()
      }))
    ].filter(e => e.value > 0);

    // Métricas calculadas
    const metrics = {
      // 🆕 Dados CRM separados (não misturar com métricas web)
      crmLeads: leadsCount,
      crmAppointments: appointmentsCount,
      crmNewPatients: newPatients,
      crmPreAgendamentos: preAgendamentos,
      
      // Mantido para compatibilidade (deprecated)
      totalUsers: leadsCount + newPatients,
      activeUsers: appointmentsCount,
      sessions: leadsCount + preAgendamentos,
      engagedSessions: appointmentsCount,
      avgSessionDuration: 180,
      source: 'internal'
    };

    return { events, metrics };
  } catch (err) {
    console.error('❌ Erro em getInternalAnalytics:', err.message);
    return { events: [], metrics: null };
  }
};

export default { getInternalAnalytics };
