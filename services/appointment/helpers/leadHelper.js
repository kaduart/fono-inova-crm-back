// back/services/appointment/helpers/leadHelper.js
/**
 * Lead Helper
 *
 * Responsabilidade única: criar ou vincular lead a partir de um agendamento.
 */

import Patient from '../../../models/Patient.js';
import Leads from '../../../models/Leads.js';
import { normalizeE164BR } from '../../../utils/phone.js';

/**
 * Cria ou vincula um Lead automaticamente quando um agendamento é feito direto.
 *
 * @param {string} patientId - ID do paciente
 * @param {Object} appointmentData - Dados do agendamento (serviceType, date, time, specialty)
 * @param {string} source - Origem do agendamento
 * @returns {Promise<string|null>} - ID do lead ou null
 */
export async function ensureLeadForAppointment(
  patientId,
  appointmentData = {},
  source = 'agenda_direta',
  mongoSession = null
) {
  try {
    const patient = await Patient.findById(patientId).lean();
    if (!patient) {
      console.log('[ensureLeadForAppointment] Paciente não encontrado:', patientId);
      return null;
    }

    const phoneE164 = patient.phone ? normalizeE164BR(patient.phone) : null;

    // Verifica se já existe lead com este telefone
    if (phoneE164) {
      const existingLeadQuery = Leads.findOne({ 'contact.phone': phoneE164 }).lean();
      if (mongoSession) existingLeadQuery.session(mongoSession);
      const existingLead = await existingLeadQuery;
      if (existingLead) {
        console.log('[ensureLeadForAppointment] ✅ Lead existente encontrado:', existingLead._id);
        return existingLead._id.toString();
      }
    }

    // Cria novo lead com proteção contra race condition
    try {
      const createOptions = mongoSession ? { session: mongoSession } : {};
      const [newLead] = await Leads.create([{
        name: patient.fullName || patient.name || 'Paciente',
        contact: {
          phone: phoneE164,
          email: patient.email || null,
        },
        origin: source === 'whatsapp' ? 'WhatsApp' : 'Agenda Direta',
        status: 'agendado',
        stage: 'interessado_agendamento',
        circuit: 'Circuito Padrão',
        conversionScore: 50,
        responded: true,
        autoReplyEnabled: false,
        manualControl: { active: false, autoResumeAfter: null },
        patientInfo: {
          fullName: patient.fullName,
          phone: phoneE164,
          email: patient.email,
        },
        appointment: {
          seekingFor: 'Adulto +18 anos',
          modality: 'Presencial',
          healthPlan: 'Mensalidade',
        },
        interactions: [
          {
            date: new Date(),
            channel: 'manual',
            direction: 'inbound',
            message: `Lead criado do agendamento direto - ${appointmentData.serviceType || 'consulta'} em ${appointmentData.date}`,
            status: 'completed',
          },
        ],
        scoreHistory: [
          {
            score: 50,
            reason: 'Agendamento direto na agenda externa',
            date: new Date(),
          },
        ],
        lastInteractionAt: new Date(),
        lastContactAt: new Date(),
        autoCreatedFromAppointment: true,
        appointmentSource: source,
        linkedPatientId: patientId,
      }], createOptions);

      console.log('[ensureLeadForAppointment] ✅ Novo lead criado:', newLead._id);
      return newLead._id.toString();
    } catch (createError) {
      if (createError.code === 11000 && phoneE164) {
        console.log('[ensureLeadForAppointment] ⚠️ Race condition detectada, buscando lead existente...');
        const raceLeadQuery = Leads.findOne({ 'contact.phone': phoneE164 }).lean();
        if (mongoSession) raceLeadQuery.session(mongoSession);
        const raceLead = await raceLeadQuery;
        if (raceLead) {
          console.log('[ensureLeadForAppointment] ✅ Lead encontrado após race condition:', raceLead._id);
          return raceLead._id.toString();
        }
      }
      throw createError;
    }
  } catch (error) {
    console.error('[ensureLeadForAppointment] Erro:', error);
    return null;
  }
}

/**
 * Monta snapshot imutável do lead para o appointment.
 */
export async function buildLeadSnapshot(leadId, mongoSession = null) {
  if (!leadId) return null;
  const query = Leads.findById(leadId).lean();
  if (mongoSession) query.session(mongoSession);
  const leadDoc = await query;
  if (!leadDoc) return null;
  return {
    source: leadDoc.source || leadDoc.origin || null,
    campaign: leadDoc.campaign || null,
    origin: leadDoc.origin || null,
    conversionScore: leadDoc.conversionScore || null,
    capturedAt: leadDoc.createdAt || null,
  };
}

export default {
  ensureLeadForAppointment,
  buildLeadSnapshot,
};
