// workers/followupOrchestratorWorker.js
// Orquestra o fluxo de followups - Versão Event-Driven
// Integra com a lógica existente do followup.worker.js

import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Lead from '../models/Leads.js';
import Followup from '../models/Followup.js';
import Message from '../models/Message.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../utils/logger.js';
import { sendTextMessage } from '../services/whatsappService.js';
import { analyzeLeadMessage } from '../services/intelligence/leadIntelligence.js';
import enrichLeadContext from '../services/leadContext.js';
import {
  eventExists,
  processWithGuarantees,
  appendEvent
} from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';

export function startFollowupOrchestratorWorker() {
  console.log('[FollowupOrchestrator] 🚀 Worker iniciado');

  const worker = new Worker('followup-processing', async (job) => {
    const { eventId, correlationId, idempotencyKey, payload } = job.data;
    const { followupId, leadId, stage, attempt } = payload;

    const log = createContextLogger(correlationId, 'followup');

    log.info('start', 'Processando followup', {
      followupId,
      leadId,
      stage,
      attempt,
      eventId
    });

    try {
      // 🛡️ IDEMPOTÊNCIA VIA EVENT STORE
      const existingEvent = await EventStore.findOne({ eventId });
      if (existingEvent) {
        if (existingEvent.status === 'processed') {
          log.info('idempotent', 'Evento já processado', { eventId, status: 'processed' });
          return {
            status: 'already_processed',
            followupId,
            eventId,
            idempotent: true
          };
        }
        if (existingEvent.status === 'processing') {
          const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
          if (existingEvent.updatedAt < fiveMinutesAgo) {
            log.warn('stale_processing', 'Evento travado em processing, reprocessando', { eventId });
          } else {
            log.info('concurrent', 'Evento em processamento por outro worker', { eventId });
            return {
              status: 'concurrent_processing',
              followupId,
              eventId,
              idempotent: true
            };
          }
        }
      }

      // 🛡️ IDEMPOTÊNCIA GLOBAL VIA EVENT STORE
      if (idempotencyKey && await eventExists(idempotencyKey)) {
        const existingByKey = await EventStore.findOne({ idempotencyKey });
        if (existingByKey?.status === 'processed') {
          log.info('idempotent', 'IdempotencyKey já processada', { idempotencyKey });
          return {
            status: 'already_processed',
            followupId,
            idempotencyKey,
            idempotent: true
          };
        }
      }

      // Cria/registra evento no Event Store
      const storedEvent = await appendEvent({
        eventId,
        eventType: EventTypes.FOLLOWUP_SCHEDULED,
        aggregateType: 'followup',
        aggregateId: followupId,
        payload: job.data.payload,
        metadata: { correlationId, idempotencyKey, source: 'followupOrchestratorWorker' },
        idempotencyKey: idempotencyKey || `followup_${followupId}_${Date.now()}`
      });

      // Processa com garantias de idempotência
      return await processWithGuarantees(storedEvent, async () => {

      // Busca followup e lead
      const followup = await Followup.findById(followupId).populate('lead');
      if (!followup) {
        throw new Error('FOLLOWUP_NOT_FOUND');
      }

      if (['sent', 'failed', 'canceled'].includes(followup.status)) {
        log.info('terminal_status', 'Followup já em status terminal', {
          status: followup.status
        });
        return {
          status: 'already_terminal',
          followupId,
          followupStatus: followup.status
        };
      }

      const lead = followup.lead;
      if (!lead) {
        throw new Error('LEAD_NOT_FOUND');
      }

      // Verifica se deve suprimir (lead convertido, etc)
      if (shouldSuppressFollowup(lead)) {
        log.info('suppressed', 'Followup suprimido - lead convertido ou terminal', {
          leadId: lead._id,
          stage: lead.stage,
          status: lead.status
        });

        await Followup.findByIdAndUpdate(followupId, {
          status: 'canceled',
          canceledReason: 'Lead em estado terminal'
        });

        return {
          status: 'suppressed',
          reason: 'lead_terminal_state'
        };
      }

      // Enriquece contexto
      const enriched = await enrichLeadContext(lead._id).catch(() => null);

      // Gera mensagem usando inteligência
      const messageResult = await generateFollowupMessage({
        lead,
        followup,
        enriched,
        attempt
      });

      if (!messageResult || !messageResult.text) {
        throw new Error('MESSAGE_GENERATION_FAILED');
      }

      log.info('message_generated', 'Mensagem gerada', {
        messageLength: messageResult.text.length,
        version: messageResult.version
      });

      // Envia mensagem WhatsApp
      const phone = lead.contact?.phone;
      if (!phone) {
        throw new Error('LEAD_NO_PHONE');
      }

      const sendResult = await sendTextMessage({
        to: phone,
        text: messageResult.text,
        lead: lead._id,
        sentBy: 'amanda'
      });

      log.info('message_sent', 'Mensagem enviada', {
        waMessageId: sendResult?.messages?.[0]?.id
      });

      // Atualiza followup
      await Followup.findByIdAndUpdate(followupId, {
        status: 'sent',
        sentAt: new Date(),
        message: messageResult.text,
        sentBy: 'amanda'
      });

      // 🎯 PUBLICA EVENTO: FOLLOWUP_SENT
      await publishEvent(
        EventTypes.FOLLOWUP_SENT,
        {
          followupId: followupId.toString(),
          leadId: lead._id.toString(),
          messageLength: messageResult.text.length,
          sentAt: new Date().toISOString()
        },
        { correlationId }
      );

      log.info('completed', 'Followup completado', {
        followupId,
        leadId
      });

      return {
        status: 'sent',
        followupId,
        leadId,
        messageSent: messageResult.text
      };

      }, 'followupOrchestratorWorker'); // Fim do processWithGuarantees

    } catch (error) {
      log.error('error', 'Erro no followup', {
        error: error.message,
        followupId
      });

      // Atualiza followup como failed
      await Followup.findByIdAndUpdate(followupId, {
        status: 'failed',
        error: error.message,
        failedAt: new Date()
      });

      // 🎯 PUBLICA EVENTO: FOLLOWUP_FAILED
      await publishEvent(
        EventTypes.FOLLOWUP_FAILED,
        {
          followupId: followupId.toString(),
          leadId,
          error: error.message,
          failedAt: new Date().toISOString()
        },
        { correlationId }
      );

      if (job.attemptsMade >= 3) {
        await moveToDLQ(job, error);
      }

      throw error;
    }
  }, {
    connection: redisConnection,
    concurrency: 3
  });

  worker.on('completed', (job, result) => {
    console.log(`[FollowupOrchestrator] Job ${job.id}: ${result.status}`);
  });

  worker.on('failed', (job, error) => {
    console.error(`[FollowupOrchestrator] Job ${job?.id} falhou:`, error.message);
  });

  console.log('[FollowupOrchestrator] Worker iniciado');
  return worker;
}

// Helper: verifica se deve suprimir followup
function shouldSuppressFollowup(lead) {
  const terminalStages = [
    'visit_scheduled',
    'scheduled',
    'patient',
    'paciente',
    'agendado',
    'visita_marcada',
    'converted'
  ];

  const stage = (lead?.stage || lead?.status || '').toString().toLowerCase();

  return (
    lead?.convertedToPatient ||
    terminalStages.includes(stage) ||
    isFuture(lead?.nextAppointmentAt) ||
    isFuture(lead?.visitAt)
  );
}

function isFuture(d) {
  if (!d) return false;
  const dt = new Date(d);
  return !isNaN(dt) && dt > new Date();
}

// Helper: gera mensagem de followup
async function generateFollowupMessage({ lead, followup, enriched, attempt }) {
  // Amanda 2.0 - usa smartFollowup se disponível
  try {
    const { generateContextualFollowup } = await import('../services/intelligence/smartFollowup.js');

    const context = {
      leadName: lead.name,
      specialty: enriched?.specialty || 'fonoaudiologia',
      lastMessage: enriched?.lastMessage,
      conversationSummary: enriched?.conversationSummary,
      attempt
    };

    const message = await generateContextualFollowup(context);

    return {
      text: message,
      version: '2.0'
    };
  } catch (err) {
    // Fallback Amanda 1.0
    const { generateFollowupMessage } = await import('../services/aiAmandaService.js');

    const message = await generateFollowupMessage({
      lead,
      stage: followup.stage,
      attempt
    });

    return {
      text: message,
      version: '1.0'
    };
  }
}
