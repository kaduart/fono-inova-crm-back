// workers/updateOrchestratorWorker.js
// Worker genérico para processar UPDATES/EDITS de qualquer entidade
// 
// PADRÃO DE EVENTO ESPERADO:
// {
//   eventType: 'APPOINTMENT_UPDATE_REQUESTED',
//   payload: {
//     entityType: 'appointment',
//     entityId: '...',
//     changes: { field: newValue },
//     reason: 'motivo da alteração',
//     userId: '...'
//   }
// }

import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { markEventProcessed, markEventFailed, markEventDeadLetter, eventExists } from '../infrastructure/events/eventStoreService.js';
import { createContextLogger } from '../utils/logger.js';
import mongoose from 'mongoose';

// Mapeamento de entidades para models
const entityModels = {
  appointment: () => import('../models/Appointment.js').then(m => m.default),
  lead: () => import('../models/Leads.js').then(m => m.default),
  invoice: () => import('../models/Invoice.js').then(m => m.default),
  payment: () => import('../models/Payment.js').then(m => m.default),
  patient: () => import('../models/Patient.js').then(m => m.default),
  package: () => import('../models/Package.js').then(m => m.default)
};

// Mapeamento de entidade para evento de resultado
const resultEventMap = {
  appointment: EventTypes.APPOINTMENT_UPDATED,
  lead: EventTypes.LEAD_UPDATED,
  invoice: EventTypes.INVOICE_PAID, // Invoice geralmente não é atualizado, é pago
  payment: EventTypes.PAYMENT_COMPLETED,
  patient: 'PATIENT_UPDATED',
  package: 'PACKAGE_UPDATED'
};

export function startUpdateOrchestratorWorker() {
  console.log('[UpdateOrchestrator] 🚀 Worker iniciado');

  const worker = new Worker('update-orchestrator', async (job) => {
    const { eventId, correlationId, idempotencyKey, payload } = job.data;
    const {
      entityType,      // 'appointment', 'lead', 'invoice', etc
      entityId,        // ID da entidade
      changes,         // { field: newValue }
      reason = '',     // motivo da alteração
      userId = null,   // quem fez a alteração
      options = {}     // opções extras (upsert, etc)
    } = payload;

    const log = createContextLogger(correlationId, 'update');

    log.info('start', 'Processando update', {
      entityType,
      entityId,
      changes: Object.keys(changes),
      reason,
      eventId
    });

    try {
      // 🛡️ Validações
      if (!entityType || !entityId || !changes) {
        throw new Error('INVALID_PAYLOAD: entityType, entityId e changes são obrigatórios');
      }

      if (!entityModels[entityType]) {
        throw new Error(`UNKNOWN_ENTITY_TYPE: ${entityType}`);
      }

      // 🛡️ IDEMPOTÊNCIA PERSISTENTE (via Event Store)
      if (idempotencyKey && await eventExists(idempotencyKey)) {
        log.info('idempotent', 'Update já processado', { idempotencyKey });
        
        // Marca como processed no Event Store também
        if (eventId) {
          await markEventProcessed(eventId, 'updateOrchestratorWorker');
        }
        
        return {
          status: 'already_processed',
          entityType,
          entityId,
          idempotent: true
        };
      }

      // Busca o model dinamicamente
      const Model = await entityModels[entityType]();

      // Valida ID
      if (!mongoose.Types.ObjectId.isValid(entityId)) {
        throw new Error('INVALID_ENTITY_ID');
      }

      // Busca entidade atual
      const entity = await Model.findById(entityId);
      if (!entity) {
        throw new Error(`${entityType.toUpperCase()}_NOT_FOUND`);
      }

      log.info('entity_found', 'Entidade encontrada', {
        entityType,
        entityId,
        currentStatus: entity.status || entity.operationalStatus || 'N/A'
      });

      // 🛡️ Validações de regra de negócio
      const validation = validateBusinessRules(entityType, entity, changes, log);
      if (!validation.valid) {
        throw new Error(`BUSINESS_RULE_VIOLATION: ${validation.reason}`);
      }

      // Aplica as mudanças
      const previousValues = {};
      const updatedFields = {};

      for (const [field, newValue] of Object.entries(changes)) {
        // Guarda valor anterior para audit
        previousValues[field] = entity[field];
        
        // Aplica mudança
        entity[field] = newValue;
        updatedFields[field] = newValue;
      }

      // Adiciona metadata de atualização
      entity.updatedAt = new Date();
      if (userId) {
        entity.updatedBy = userId;
      }

      // Salva no banco
      await entity.save();

      log.info('entity_updated', 'Entidade atualizada', {
        entityType,
        entityId,
        updatedFields: Object.keys(updatedFields)
      });

      // 📝 Cria registro de audit (opcional)
      await createAuditLog({
        entityType,
        entityId,
        action: 'UPDATE',
        previousValues,
        newValues: updatedFields,
        reason,
        userId,
        correlationId
      });

      // 🎯 PUBLICA EVENTO: {ENTITY}_UPDATED
      const resultEventType = resultEventMap[entityType];
      if (resultEventType) {
        await publishEvent(
          resultEventType,
          {
            entityType,
            entityId: entityId.toString(),
            changes: updatedFields,
            previousValues,
            reason,
            updatedBy: userId,
            updatedAt: new Date().toISOString()
          },
          { correlationId }
        );

        log.info('event_published', 'Evento de update publicado', {
          eventType: resultEventType
        });
      }

      // 🛡️ MARCA COMO PROCESSADO NO EVENT STORE
      if (eventId) {
        await markEventProcessed(eventId, 'updateOrchestratorWorker');
      }

      log.info('completed', 'Update completado com sucesso', {
        entityType,
        entityId
      });

      return {
        status: 'updated',
        entityType,
        entityId,
        changes: updatedFields,
        previousValues,
        correlationId
      };

    } catch (error) {
      log.error('error', 'Erro ao processar update', {
        error: error.message,
        entityType,
        entityId,
        stack: error.stack
      });

      // 🛡️ MARCA COMO FALHO NO EVENT STORE
      if (eventId) {
        if (job.attemptsMade >= 2) { // 3 tentativas = 0, 1, 2
          await markEventDeadLetter(eventId, error);
          log.error('dead_letter', 'Evento movido para DLQ', { eventId });
        } else {
          await markEventFailed(eventId, error);
        }
      }

      if (job.attemptsMade >= 3) {
        await moveToDLQ(job, error);
      }

      throw error;
    }
  }, {
    connection: redisConnection,
    concurrency: 5
  });

  worker.on('completed', (job, result) => {
    console.log(`[UpdateOrchestrator] Job ${job.id}: ${result.status} (${result.entityType})`);
  });

  worker.on('failed', (job, error) => {
    console.error(`[UpdateOrchestrator] Job ${job?.id} falhou:`, error.message);
  });

  console.log('[UpdateOrchestrator] Worker iniciado');
  return worker;
}

// ============ HELPERS ============

/**
 * Valida regras de negócio específicas por entidade
 */
function validateBusinessRules(entityType, entity, changes, log) {
  switch (entityType) {
    case 'appointment':
      // Não permite alterar agendamento cancelado
      if (entity.operationalStatus === 'canceled' && changes.operationalStatus !== 'canceled') {
        return {
          valid: false,
          reason: 'Cannot modify canceled appointment'
        };
      }
      
      // Não permite alterar agendamento completed
      if (entity.clinicalStatus === 'completed' && changes.clinicalStatus !== 'completed') {
        return {
          valid: false,
          reason: 'Cannot modify completed appointment'
        };
      }
      break;

    case 'invoice':
      // Invoice pago não pode ser alterado (só cancelado)
      if (entity.status === 'paid') {
        const allowedFields = ['status', 'notes']; // só pode cancelar ou adicionar nota
        const attemptedFields = Object.keys(changes);
        const hasDisallowed = attemptedFields.some(f => !allowedFields.includes(f));
        
        if (hasDisallowed) {
          return {
            valid: false,
            reason: 'Paid invoice can only be canceled or annotated'
          };
        }
      }
      break;

    case 'payment':
      // Payment canceled não pode ser alterado
      if (entity.status === 'canceled') {
        return {
          valid: false,
          reason: 'Cannot modify canceled payment'
        };
      }
      break;

    case 'lead':
      // Lead convertido tem restrições
      if (entity.convertedToPatient && changes.status && changes.status !== 'converted') {
        log.warn('lead_already_converted', 'Tentativa de alterar lead já convertido', {
          leadId: entity._id
        });
        // Permite, mas loga warning
      }
      break;
  }

  return { valid: true };
}

/**
 * Cria registro de audit (simplificado - em produção usar collection separada)
 */
async function createAuditLog({ entityType, entityId, action, previousValues, newValues, reason, userId, correlationId }) {
  try {
    // Em produção, isso poderia salvar em uma collection 'AuditLog'
    // Por enquanto, só loga
    const log = createContextLogger(correlationId, 'audit');
    
    log.info('audit_log', 'Registro de alteração', {
      entityType,
      entityId,
      action,
      changedFields: Object.keys(newValues),
      reason,
      userId
    });

    // TODO: Persistir em collection AuditLog para auditoria completa
    // await AuditLog.create({ ... });

  } catch (error) {
    // Falha em audit não quebra o fluxo principal
    console.error('Erro ao criar audit log:', error.message);
  }
}

/**
 * Helper para criar evento de update (usado pelos controllers)
 */
export async function publishUpdateEvent(entityType, entityId, changes, options = {}) {
  const { reason = '', userId = null, correlationId = null } = options;

  const eventTypeMap = {
    appointment: EventTypes.APPOINTMENT_UPDATE_REQUESTED,
    lead: EventTypes.LEAD_UPDATE_REQUESTED,
    invoice: EventTypes.INVOICE_UPDATE_REQUESTED,
    payment: EventTypes.PAYMENT_UPDATE_REQUESTED
  };

  const eventType = eventTypeMap[entityType];
  if (!eventType) {
    throw new Error(`UPDATE_NOT_SUPPORTED_FOR: ${entityType}`);
  }

  return await publishEvent(
    eventType,
    {
      entityType,
      entityId: entityId.toString(),
      changes,
      reason,
      userId
    },
    {
      correlationId: correlationId || `update_${entityType}_${Date.now()}`,
      idempotencyKey: `${entityType}_${entityId}_${JSON.stringify(changes)}`
    }
  );
}
