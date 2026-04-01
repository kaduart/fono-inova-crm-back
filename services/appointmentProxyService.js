// services/appointmentProxyService.js
/**
 * Proxy Service - Decide entre legado e 4.0
 * Responsável pela transição gradual dos fluxos
 */

import { FeatureFlags } from '../config/featureFlags.js';
import { logger } from '../utils/logger.js';

// Import V2 services
import { 
  createAppointment as createV2,
  completeAppointment as completeV2,
  cancelAppointment as cancelV2 
} from './appointmentV2Service.js';

// Import Legacy services (placeholder - ajustar caminho real)
import * as legacyService from './appointmentService.js';

const log = logger;

export async function createAppointment(data, context = {}) {
  const { patientId } = data;
  const useV2 = FeatureFlags.shouldUseV2('CREATE', patientId);
  
  if (useV2) {
    log.info('proxy', 'create_v2', { patientId, correlationId: context.correlationId });
    try {
      const result = await createV2(data, context);
      log.info('proxy', 'create_v2_success', { appointmentId: result.appointmentId });
      return result;
    } catch (error) {
      log.error('proxy', 'create_v2_failed', error.message, { patientId });
      // Fallback para legado
      log.warn('proxy', 'create_fallback_legacy', { patientId });
      return await legacyService.createAppointment(data);
    }
  }
  
  log.debug('proxy', 'create_legacy', { patientId });
  return await legacyService.createAppointment(data);
}

export async function completeAppointment(id, data, context = {}) {
  const { patientId } = data;
  const useV2 = FeatureFlags.shouldUseV2('COMPLETE', patientId);
  
  if (useV2) {
    log.info('proxy', 'complete_v2', { appointmentId: id, patientId });
    try {
      const result = await completeV2(id, data, context);
      log.info('proxy', 'complete_v2_success', { appointmentId: id });
      return result;
    } catch (error) {
      log.error('proxy', 'complete_v2_failed', error.message, { appointmentId: id });
      log.warn('proxy', 'complete_fallback_legacy', { appointmentId: id });
      return await legacyService.completeAppointment(id, data);
    }
  }
  
  log.debug('proxy', 'complete_legacy', { appointmentId: id });
  return await legacyService.completeAppointment(id, data);
}

export async function cancelAppointment(id, data, context = {}) {
  const { patientId } = data;
  const useV2 = FeatureFlags.shouldUseV2('CANCEL', patientId);
  
  if (useV2) {
    log.info('proxy', 'cancel_v2', { appointmentId: id, patientId });
    try {
      const result = await cancelV2(id, data, context);
      log.info('proxy', 'cancel_v2_success', { appointmentId: id });
      return result;
    } catch (error) {
      log.error('proxy', 'cancel_v2_failed', error.message, { appointmentId: id });
      log.warn('proxy', 'cancel_fallback_legacy', { appointmentId: id });
      return await legacyService.cancelAppointment(id, data);
    }
  }
  
  log.debug('proxy', 'cancel_legacy', { appointmentId: id });
  return await legacyService.cancelAppointment(id, data);
}

export function getMigrationStatus() {
  return {
    flags: FeatureFlags.getStatus(),
    timestamp: new Date().toISOString()
  };
}
