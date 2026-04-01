// infrastructure/events/updateHelper.js
// Helper para fazer updates via event-driven ou legado

import { publishEvent, EventTypes } from './eventPublisher.js';
import { isEnabled } from '../featureFlags/featureFlags.js';
import { createContextLogger } from '../../utils/logger.js';

/**
 * Atualiza uma entidade via event-driven ou legado (direto)
 * 
 * USO NOS CONTROLLERS:
 * 
 * // Antes (legado):
 * await Appointment.findByIdAndUpdate(id, { status: 'confirmed' });
 * 
 * // Depois (event-driven):
 * await updateEntity('appointment', id, { status: 'confirmed' }, {
 *   reason: 'Confirmação manual',
 *   userId: req.user?.id,
 *   correlationId: req.correlationId
 * });
 * 
 * @param {string} entityType - Tipo da entidade ('appointment', 'lead', 'invoice', 'payment')
 * @param {string} entityId - ID da entidade
 * @param {Object} changes - Campos a alterar { field: newValue }
 * @param {Object} options - Opções
 * @param {string} options.reason - Motivo da alteração
 * @param {string} options.userId - ID do usuário que fez a alteração
 * @param {string} options.correlationId - ID de correlação
 * @param {boolean} options.forceDirect - Força update direto (ignora feature flag)
 * @returns {Promise<Object>} Resultado da operação
 */
export async function updateEntity(entityType, entityId, changes, options = {}) {
  const {
    reason = '',
    userId = null,
    correlationId = null,
    forceDirect = false
  } = options;

  const log = createContextLogger(correlationId, 'update_helper');

  // Verifica se deve usar event-driven
  const featureFlagName = `FF_${entityType.toUpperCase()}_UPDATE_EVENT_DRIVEN`;
  const useEventDriven = !forceDirect && isEnabled(featureFlagName);

  if (useEventDriven) {
    log.info('event_driven', `Update via evento (${entityType})`, {
      entityId,
      changes: Object.keys(changes),
      reason
    });

    // Mapeia para o tipo de evento correto
    const eventTypeMap = {
      appointment: EventTypes.APPOINTMENT_UPDATE_REQUESTED,
      lead: EventTypes.LEAD_UPDATE_REQUESTED,
      invoice: EventTypes.INVOICE_UPDATE_REQUESTED,
      payment: EventTypes.PAYMENT_UPDATE_REQUESTED
    };

    const eventType = eventTypeMap[entityType];
    if (!eventType) {
      throw new Error(`UPDATE_NOT_SUPPORTED_FOR_ENTITY: ${entityType}`);
    }

    // Publica evento
    const result = await publishEvent(
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
        idempotencyKey: `${entityType}_${entityId}_${JSON.stringify(changes)}_${Date.now()}`
      }
    );

    log.info('event_published', 'Evento de update publicado', {
      eventType,
      eventId: result.eventId
    });

    return {
      success: true,
      method: 'event-driven',
      eventId: result.eventId,
      queued: true,
      entityType,
      entityId
    };

  } else {
    // Legado: update direto no banco
    log.info('direct_update', `Update direto (${entityType})`, {
      entityId,
      changes: Object.keys(changes)
    });

    // Importa model dinamicamente
    const modelMap = {
      appointment: () => import('../../models/Appointment.js').then(m => m.default),
      lead: () => import('../../models/Leads.js').then(m => m.default),
      invoice: () => import('../../models/Invoice.js').then(m => m.default),
      payment: () => import('../../models/Payment.js').then(m => m.default)
    };

    const Model = await modelMap[entityType]();

    // Adiciona metadata
    const updateData = {
      ...changes,
      updatedAt: new Date()
    };

    if (userId) {
      updateData.updatedBy = userId;
    }

    // Executa update
    const result = await Model.findByIdAndUpdate(
      entityId,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!result) {
      throw new Error(`${entityType.toUpperCase()}_NOT_FOUND`);
    }

    log.info('direct_updated', 'Update direto completado', {
      entityId
    });

    return {
      success: true,
      method: 'direct',
      queued: false,
      entityType,
      entityId,
      data: result
    };
  }
}

/**
 * Atualiza múltiplas entidades em batch
 * 
 * @param {string} entityType - Tipo da entidade
 * @param {Array<string>} entityIds - IDs das entidades
 * @param {Object} changes - Campos a alterar
 * @param {Object} options - Opções
 */
export async function updateManyEntities(entityType, entityIds, changes, options = {}) {
  const { correlationId = null } = options;
  const log = createContextLogger(correlationId, 'update_helper');

  log.info('batch_update', `Batch update (${entityType})`, {
    count: entityIds.length
  });

  const results = [];
  for (const entityId of entityIds) {
    try {
      const result = await updateEntity(entityType, entityId, changes, options);
      results.push({ entityId, success: true, ...result });
    } catch (error) {
      results.push({ entityId, success: false, error: error.message });
    }
  }

  const successCount = results.filter(r => r.success).length;
  const failCount = results.length - successCount;

  log.info('batch_complete', 'Batch update completado', {
    total: entityIds.length,
    success: successCount,
    failed: failCount
  });

  return {
    success: failCount === 0,
    total: entityIds.length,
    successCount,
    failCount,
    results
  };
}

/**
 * Verifica se uma entidade pode ser atualizada
 * 
 * @param {string} entityType - Tipo da entidade
 * @param {string} entityId - ID da entidade
 * @returns {Promise<Object>} { canUpdate: boolean, reason?: string }
 */
export async function canUpdateEntity(entityType, entityId) {
  try {
    const modelMap = {
      appointment: () => import('../../models/Appointment.js').then(m => m.default),
      lead: () => import('../../models/Leads.js').then(m => m.default),
      invoice: () => import('../../models/Invoice.js').then(m => m.default),
      payment: () => import('../../models/Payment.js').then(m => m.default)
    };

    const Model = await modelMap[entityType]();
    const entity = await Model.findById(entityId).lean();

    if (!entity) {
      return { canUpdate: false, reason: 'ENTITY_NOT_FOUND' };
    }

    // Regras específicas
    switch (entityType) {
      case 'appointment':
        if (entity.operationalStatus === 'canceled') {
          return { canUpdate: false, reason: 'APPOINTMENT_CANCELED' };
        }
        if (entity.clinicalStatus === 'completed') {
          return { canUpdate: false, reason: 'APPOINTMENT_COMPLETED' };
        }
        break;

      case 'invoice':
        if (entity.status === 'canceled') {
          return { canUpdate: false, reason: 'INVOICE_CANCELED' };
        }
        break;

      case 'payment':
        if (entity.status === 'canceled') {
          return { canUpdate: false, reason: 'PAYMENT_CANCELED' };
        }
        break;
    }

    return { canUpdate: true };

  } catch (error) {
    return { canUpdate: false, reason: error.message };
  }
}
