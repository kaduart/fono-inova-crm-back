// infrastructure/persistence/LeadRepository.js
// Repository Pattern - Abstrai persistência de Leads
// Responsabilidade: CRUD + Queries específicas de domínio

import Leads from '../../models/Leads.js';
import Logger from '../../services/utils/Logger.js';

const logger = new Logger('LeadRepository');

/**
 * Repository de Leads - Abstrai acesso ao MongoDB
 * Implementa padrão Repository para desacoplar domínio de infraestrutura
 */
export class LeadRepository {
  /**
   * Busca lead por ID
   */
  async findById(leadId) {
    try {
      return await Leads.findById(leadId);
    } catch (error) {
      logger.error('FIND_BY_ID_ERROR', { leadId, error: error.message });
      throw error;
    }
  }

  /**
   * Atualiza contexto clínico do lead
   * @param {string} leadId
   * @param {Object} clinicalContext - Contexto clínico (bloqueios, sugestões, etc.)
   */
  async updateClinicalContext(leadId, clinicalContext) {
    try {
      const update = {
        $set: {
          'clinicalHistory.lastBlockReason': clinicalContext.lastBlockReason,
          'clinicalHistory.suggestedAlternative': clinicalContext.suggestedAlternative,
          'clinicalHistory.pendingValidation': clinicalContext.pendingValidation,
          'clinicalHistory.lastUpdate': new Date()
        }
      };

      if (clinicalContext.blocks) {
        update.$push = {
          'clinicalHistory.blocks': {
            reason: clinicalContext.lastBlockReason,
            alternative: clinicalContext.suggestedAlternative,
            timestamp: new Date()
          }
        };
      }

      const result = await Leads.findByIdAndUpdate(leadId, update, { new: true });

      logger.info('CLINICAL_CONTEXT_UPDATED', {
        leadId,
        reason: clinicalContext.lastBlockReason,
        alternative: clinicalContext.suggestedAlternative
      });

      return result;
    } catch (error) {
      logger.error('UPDATE_CLINICAL_CONTEXT_ERROR', { leadId, error: error.message });
      throw error;
    }
  }

  /**
   * Persiste slots de agendamento pendentes
   * @param {string} leadId
   * @param {Object} slots - { primary, alternativesSamePeriod, alternativesOtherPeriod }
   */
  async persistSchedulingSlots(leadId, slots) {
    try {
      const update = {
        $set: {
          pendingSchedulingSlots: {
            primary: slots.primary || [],
            alternativesSamePeriod: slots.alternativesSamePeriod || [],
            alternativesOtherPeriod: slots.alternativesOtherPeriod || [],
            offeredAt: new Date()
          }
        }
      };

      const result = await Leads.findByIdAndUpdate(leadId, update, { new: true });

      logger.info('SCHEDULING_SLOTS_PERSISTED', {
        leadId,
        primaryCount: slots.primary?.length || 0,
        alternativesCount: (slots.alternativesSamePeriod?.length || 0) + (slots.alternativesOtherPeriod?.length || 0)
      });

      return result;
    } catch (error) {
      logger.error('PERSIST_SLOTS_ERROR', { leadId, error: error.message });
      throw error;
    }
  }

  /**
   * Persiste slot escolhido pelo usuário
   * @param {string} leadId
   * @param {Object} chosenSlot
   */
  async persistChosenSlot(leadId, chosenSlot) {
    try {
      const update = {
        $set: {
          pendingChosenSlot: chosenSlot,
          'pendingChosenSlot.chosenAt': new Date()
        },
        $unset: {
          pendingSchedulingSlots: 1 // Remove slots após escolha
        }
      };

      const result = await Leads.findByIdAndUpdate(leadId, update, { new: true });

      logger.info('CHOSEN_SLOT_PERSISTED', {
        leadId,
        slot: chosenSlot?.dateTime,
        professional: chosenSlot?.professionalName
      });

      return result;
    } catch (error) {
      logger.error('PERSIST_CHOSEN_SLOT_ERROR', { leadId, error: error.message });
      throw error;
    }
  }

  /**
   * Persiste dados do paciente (nome, nascimento)
   * @param {string} leadId
   * @param {Object} patientData - { name, birthDate }
   */
  async persistPatientData(leadId, patientData) {
    try {
      const update = {
        $set: {
          'patientInfo.name': patientData.name,
          'patientInfo.birthDate': patientData.birthDate,
          'patientInfo.updatedAt': new Date()
        }
      };

      const result = await Leads.findByIdAndUpdate(leadId, update, { new: true });

      logger.info('PATIENT_DATA_PERSISTED', {
        leadId,
        hasName: !!patientData.name,
        hasBirthDate: !!patientData.birthDate
      });

      return result;
    } catch (error) {
      logger.error('PERSIST_PATIENT_DATA_ERROR', { leadId, error: error.message });
      throw error;
    }
  }

  /**
   * Limpa estado de booking (após confirmação ou cancelamento)
   * @param {string} leadId
   */
  async clearBookingState(leadId) {
    try {
      const update = {
        $unset: {
          pendingSchedulingSlots: 1,
          pendingChosenSlot: 1
        },
        $set: {
          'bookingState.clearedAt': new Date()
        }
      };

      const result = await Leads.findByIdAndUpdate(leadId, update, { new: true });

      logger.info('BOOKING_STATE_CLEARED', { leadId });

      return result;
    } catch (error) {
      logger.error('CLEAR_BOOKING_STATE_ERROR', { leadId, error: error.message });
      throw error;
    }
  }

  /**
   * Cria lock otimista para evitar race condition em booking
   * @param {string} leadId
   * @param {number} ttlSeconds - Tempo de vida do lock (padrão: 300s = 5min)
   * @returns {boolean} true se conseguiu lock, false se já está locked
   */
  async acquireBookingLock(leadId, ttlSeconds = 300) {
    try {
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

      const result = await Leads.findOneAndUpdate(
        {
          _id: leadId,
          $or: [
            { 'bookingLock.expiresAt': { $exists: false } },
            { 'bookingLock.expiresAt': { $lt: new Date() } }
          ]
        },
        {
          $set: {
            'bookingLock.acquiredAt': new Date(),
            'bookingLock.expiresAt': expiresAt
          }
        },
        { new: true }
      );

      const acquired = !!result;

      logger.info('BOOKING_LOCK_ATTEMPT', {
        leadId,
        acquired,
        expiresAt: acquired ? expiresAt : null
      });

      return acquired;
    } catch (error) {
      logger.error('ACQUIRE_BOOKING_LOCK_ERROR', { leadId, error: error.message });
      return false; // Fail-safe: não conseguiu lock
    }
  }

  /**
   * Libera lock de booking
   * @param {string} leadId
   */
  async releaseBookingLock(leadId) {
    try {
      await Leads.findByIdAndUpdate(leadId, {
        $unset: { bookingLock: 1 }
      });

      logger.info('BOOKING_LOCK_RELEASED', { leadId });
    } catch (error) {
      logger.error('RELEASE_BOOKING_LOCK_ERROR', { leadId, error: error.message });
    }
  }

  /**
   * Escalação para atendimento humano
   * @param {string} leadId
   * @param {Object} escalationData - { reason, priority, notes }
   */
  async escalateToHuman(leadId, escalationData) {
    try {
      const update = {
        $set: {
          'escalation.escalatedAt': new Date(),
          'escalation.reason': escalationData.reason,
          'escalation.priority': escalationData.priority || 'normal',
          'escalation.notes': escalationData.notes,
          'escalation.status': 'pending'
        },
        $push: {
          'escalation.history': {
            reason: escalationData.reason,
            timestamp: new Date()
          }
        }
      };

      const result = await Leads.findByIdAndUpdate(leadId, update, { new: true });

      logger.warn('LEAD_ESCALATED_TO_HUMAN', {
        leadId,
        reason: escalationData.reason,
        priority: escalationData.priority
      });

      return result;
    } catch (error) {
      logger.error('ESCALATE_TO_HUMAN_ERROR', { leadId, error: error.message });
      throw error;
    }
  }

  /**
   * Registra evento de auditoria (compliance médico)
   * @param {string} leadId
   * @param {Object} auditEvent - { type, decision, context }
   */
  async recordAuditEvent(leadId, auditEvent) {
    try {
      const event = {
        type: auditEvent.type,
        decision: auditEvent.decision,
        context: auditEvent.context,
        timestamp: new Date()
      };

      await Leads.findByIdAndUpdate(leadId, {
        $push: { 'auditLog': event }
      });

      logger.info('AUDIT_EVENT_RECORDED', {
        leadId,
        type: auditEvent.type,
        decision: auditEvent.decision
      });
    } catch (error) {
      logger.error('RECORD_AUDIT_EVENT_ERROR', { leadId, error: error.message });
      // Não lança erro - auditoria não deve quebrar fluxo
    }
  }
}

// Exporta instância singleton
export const leadRepository = new LeadRepository();
