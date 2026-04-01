// workers/leadOrchestratorWorker.js
// Orquestra o fluxo de leads - Versão Event-Driven

import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Lead from '../models/Leads.js';
import Followup from '../models/Followup.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { calculateOptimalFollowupTime } from '../services/intelligence/smartFollowup.js';
import { createContextLogger } from '../utils/logger.js';
import {
  eventExists,
  processWithGuarantees,
  appendEvent
} from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';

export function startLeadOrchestratorWorker() {
  console.log('[LeadOrchestrator] 🚀 Worker iniciado');

  const worker = new Worker('lead-processing', async (job) => {
    const { eventId, correlationId, idempotencyKey, payload } = job.data;
    const { leadId, leadData, origin } = payload;

    const log = createContextLogger(correlationId || leadId, 'lead');

    log.info('start', 'Processando lead', {
      leadId,
      eventId,
      origin,
      attempt: job.attemptsMade + 1
    });

    try {
      // 🛡️ IDEMPOTÊNCIA - Verifica via Event Store
      if (idempotencyKey && await eventExists(idempotencyKey)) {
        log.info('idempotent', 'Lead já processado', { idempotencyKey });
        return {
          status: 'already_processed',
          leadId,
          idempotencyKey,
          idempotent: true
        };
      }

      // Verifica se evento já existe pelo eventId
      if (eventId && await EventStore.findOne({ eventId })) {
        log.info('idempotent', 'Evento já existe no Event Store', { eventId });
        return {
          status: 'already_processed',
          leadId,
          eventId,
          idempotent: true
        };
      }

      // 🔄 WRAP do processamento com garantias
      const processResult = await processWithGuarantees(
        {
          eventId: eventId || `lead-${leadId}-${Date.now()}`,
          aggregateType: 'lead',
          aggregateId: leadId,
          payload: { leadId, leadData, origin, idempotencyKey, correlationId }
        },
        async (event) => {
          return await processLeadLogic(event.payload, log);
        },
        'leadOrchestratorWorker'
      );

      // 🛡️ REGISTRA EVENTO DE CONCLUSÃO
      await appendEvent({
        eventType: 'LEAD_PROCESSING_COMPLETED',
        aggregateType: 'lead',
        aggregateId: leadId,
        payload: {
          leadId,
          followupId: processResult.result.followupId,
          followupTime: processResult.result.followupTime
        },
        idempotencyKey,
        correlationId,
        metadata: { worker: 'leadOrchestratorWorker', status: 'completed' }
      });

      return processResult.result;

    } catch (error) {
      log.error('error', 'Erro ao processar lead', {
        error: error.message,
        leadId
      });

      // Registra evento de falha
      await appendEvent({
        eventType: 'LEAD_PROCESSING_FAILED',
        aggregateType: 'lead',
        aggregateId: leadId,
        payload: { leadId, error: error.message },
        idempotencyKey,
        correlationId,
        metadata: { worker: 'leadOrchestratorWorker', error: error.message }
      });

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
    console.log(`[LeadOrchestrator] Job ${job.id}: ${result.status}`);
  });

  worker.on('failed', (job, error) => {
    console.error(`[LeadOrchestrator] Job ${job?.id} falhou:`, error.message);
  });

  console.log('[LeadOrchestrator] Worker iniciado');
  return worker;
}

/**
 * Processa a lógica principal do lead
 * @param {Object} payload - Dados do payload
 * @param {Object} log - Logger com contexto
 * @returns {Object} Resultado do processamento
 */
async function processLeadLogic(payload, log) {
  const { leadId, leadData, origin, correlationId } = payload;

  // Busca lead
  const lead = await Lead.findById(leadId);
  if (!lead) {
    throw new Error('LEAD_NOT_FOUND');
  }

  log.info('lead_found', 'Lead encontrado', {
    leadId: lead._id,
    name: lead.name,
    score: lead.conversionScore
  });

  // Calcula tempo ótimo de followup
  const followupTime = calculateOptimalFollowupTime({
    lead,
    score: lead.conversionScore,
    lastInteraction: lead.lastInteractionAt,
    attempt: 1
  });

  // Cria followup no banco
  const followup = await Followup.create({
    lead: lead._id,
    stage: 'primeiro_contato',
    scheduledAt: followupTime,
    status: 'scheduled',
    aiOptimized: true,
    origin: origin || 'event-driven',
    note: `Auto-agendado via event-driven`,
    correlationId
  });

  log.info('followup_created', 'Followup criado', {
    followupId: followup._id,
    scheduledAt: followupTime
  });

  // 🎯 PUBLICA EVENTO: FOLLOWUP_REQUESTED
  await publishEvent(
    EventTypes.FOLLOWUP_REQUESTED,
    {
      followupId: followup._id.toString(),
      leadId: lead._id.toString(),
      scheduledAt: followupTime.toISOString(),
      stage: 'primeiro_contato',
      attempt: 1
    },
    {
      correlationId,
      delay: Math.max(0, followupTime.getTime() - Date.now())
    }
  );

  log.info('completed', 'Lead processado com sucesso', {
    leadId,
    followupId: followup._id,
    followupTime
  });

  return {
    status: 'completed',
    leadId,
    followupId: followup._id,
    followupTime,
    correlationId
  };
}
