// back/domains/whatsapp/workers/leadStateWorker.js
/**
 * Lead State Worker
 * 
 * Papel: Carregar e validar estado do lead antes da orquestração
 * 
 * Evento Consumido: LEAD_STATE_CHECK_REQUESTED
 * Evento Publicado: ORCHESTRATOR_RUN_REQUESTED (se tudo OK)
 * 
 * Regras:
 * - RN-WHATSAPP-005: Recarregar estado do lead (último contexto)
 * - RN-WHATSAPP-006: Verificar controle manual (bloqueio humano)
 * - RN-WHATSAPP-007: Timeout de inatividade (bloqueio temporário)
 * - RN-WHATSAPP-008: Kill switch global (emergência)
 */

import { Worker } from 'bullmq';
import { getRedisConnection } from '../../../infra/redis/redisClient.js';
import { logger } from '../../../infra/logger.js';

const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutos
const MANUAL_CONTROL_KEY = 'whatsapp:manual-control';
const KILL_SWITCH_KEY = 'whatsapp:kill-switch';

/**
 * Cria o Lead State Worker
 * 
 * @param {Object} deps - Dependências
 * @param {Object} deps.Lead - Modelo Lead
 * @param {Object} deps.redis - Cliente Redis
 * @param {Function} deps.publishEvent - Função para publicar eventos
 */
export function createLeadStateWorker(deps) {
  const { Lead, redis, publishEvent } = deps;

  return new Worker(
    'whatsapp-lead-state',
    async (job) => {
      const { eventId, payload, metadata } = job.data;
      const { phone, message, originalEventId } = payload;
      const correlationId = metadata?.correlationId || eventId;

      logger.info('[LeadStateWorker] Processing', {
        phone,
        correlationId
      });

      try {
        // RN-WHATSAPP-008: Kill Switch Global
        const killSwitchEnabled = await redis.get(KILL_SWITCH_KEY);
        if (killSwitchEnabled === 'true') {
          logger.warn('[LeadStateWorker] Kill switch enabled, blocking all messages');
          return { 
            status: 'blocked', 
            reason: 'kill_switch_enabled',
            action: 'notify_admin'
          };
        }

        // RN-WHATSAPP-005: Recarregar estado do lead
        let lead = await Lead.findOne({ phone }).lean();
        
        if (!lead) {
          // Lead novo - criar registro inicial
          logger.info('[LeadStateWorker] New lead detected', { phone });
          
          // Emitir evento para criar lead depois (não bloqueia)
          lead = {
            phone,
            status: 'new',
            isNew: true
          };
        }

        // RN-WHATSAPP-007: Timeout de inatividade
        if (lead.lastInteractionAt) {
          const lastInteraction = new Date(lead.lastInteractionAt).getTime();
          const now = Date.now();
          const inactiveTime = now - lastInteraction;
          
          if (inactiveTime > INACTIVITY_TIMEOUT) {
            logger.info('[LeadStateWorker] Lead inactive, resetting context', {
              phone,
              inactiveTime: Math.round(inactiveTime / 60000) + 'min'
            });
            
            // Reset de contexto por inatividade
            lead.context = null;
            lead.sessionState = 'reset_by_inactivity';
          }
        }

        // RN-WHATSAPP-006: Verificar controle manual
        const manualControl = await checkManualControl(redis, phone, lead._id);
        
        if (manualControl.isBlocked) {
          logger.info('[LeadStateWorker] Lead under manual control', {
            phone,
            blockedBy: manualControl.blockedBy,
            reason: manualControl.reason
          });
          
          return {
            status: 'manual_control',
            reason: manualControl.reason,
            blockedBy: manualControl.blockedBy,
            until: manualControl.until
          };
        }

        // RN-WHATSAPP-006: Verificar se está em atendimento humano
        if (lead.attendanceStatus === 'human_attending') {
          logger.info('[LeadStateWorker] Human attending, skip AI', {
            phone,
            attendedBy: lead.attendedBy
          });
          
          return {
            status: 'human_attending',
            attendedBy: lead.attendedBy,
            action: 'notify_human'
          };
        }

        // Detectar mensagem inbound para tracking de respostas
        const isInbound = payload.direction === 'inbound' || !payload.direction;
        if (isInbound && lead._id) {
          await publishEvent('MESSAGE_RESPONSE_DETECTED', {
            leadId: lead._id.toString(),
            phone,
            timestamp: new Date().toISOString(),
            correlationId
          }, { correlationId });
          
          logger.debug('[LeadStateWorker] Emitted MESSAGE_RESPONSE_DETECTED', {
            leadId: lead._id,
            phone
          });
        }

        // Tudo OK - avança para orquestração
        const enrichedContext = {
          leadId: lead._id,
          phone,
          leadStatus: lead.status,
          isNewLead: lead.isNew || false,
          patientId: lead.patientId || null,
          previousContext: lead.context || null,
          sessionState: lead.sessionState || 'active',
          messageCount: payload.messageCount || 1,
          originalMessage: message,
          correlationId
        };

        await publishEvent('ORCHESTRATOR_RUN_REQUESTED', {
          originalEventId,
          leadContext: enrichedContext,
          message,
          timestamp: payload.timestamp,
          correlationId
        }, { correlationId });

        logger.info('[LeadStateWorker] Lead state validated, emitted ORCHESTRATOR_RUN_REQUESTED', {
          phone,
          leadId: lead._id,
          isNew: lead.isNew
        });

        return {
          status: 'validated',
          nextEvent: 'ORCHESTRATOR_RUN_REQUESTED',
          leadId: lead._id,
          isNewLead: lead.isNew || false
        };

      } catch (error) {
        logger.error('[LeadStateWorker] Error', {
          error: error.message,
          phone,
          correlationId
        });
        throw error;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 10,
      limiter: {
        max: 50,
        duration: 1000
      }
    }
  );
}

// ============================================
// HELPERS
// ============================================

async function checkManualControl(redis, phone, leadId) {
  // Verifica bloqueio global
  const globalBlock = await redis.get(`${MANUAL_CONTROL_KEY}:global`);
  if (globalBlock) {
    const blockData = JSON.parse(globalBlock);
    if (new Date(blockData.until) > new Date()) {
      return {
        isBlocked: true,
        blockedBy: blockData.by,
        reason: blockData.reason,
        until: blockData.until
      };
    }
  }

  // Verifica bloqueio específico do lead
  const leadBlock = await redis.get(`${MANUAL_CONTROL_KEY}:${leadId || phone}`);
  if (leadBlock) {
    const blockData = JSON.parse(leadBlock);
    if (new Date(blockData.until) > new Date()) {
      return {
        isBlocked: true,
        blockedBy: blockData.by,
        reason: blockData.reason,
        until: blockData.until
      };
    }
  }

  return { isBlocked: false };
}

// ============================================
// REGRAS DOCUMENTADAS
// ============================================

export const LeadStateRules = {
  'RN-WHATSAPP-005': 'Recarregar estado do lead - busca último contexto no banco',
  'RN-WHATSAPP-006': 'Verificar controle manual - bloqueio humano (global ou por lead)',
  'RN-WHATSAPP-007': 'Timeout de inatividade - reset de contexto após 30min',
  'RN-WHATSAPP-008': 'Kill switch global - emergência para bloquear todo sistema'
};

export default createLeadStateWorker;
