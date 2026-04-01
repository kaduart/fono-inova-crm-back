// workers/notificationOrchestratorWorker.js
// Orquestra notificações (WhatsApp, Email, SMS) - Versão Event-Driven

import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../utils/logger.js';
import { sendTextMessage, sendTemplateMessage } from '../services/whatsappService.js';
import Message from '../models/Message.js';
import Lead from '../models/Leads.js';
import {
  eventExists,
  processWithGuarantees,
  appendEvent
} from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';

/**
 * Worker de Notificações - Processa eventos de notificação
 * e roteia para o canal apropriado (WhatsApp, Email, SMS)
 */
export function startNotificationOrchestratorWorker() {
  console.log('[NotificationOrchestrator] 🚀 Worker iniciado');

  const worker = new Worker('notification', async (job) => {
    const { eventId, correlationId, idempotencyKey, payload } = job.data;
    const {
      type,           // 'whatsapp', 'email', 'sms', 'push'
      channel,        // canal específico
      to,             // destinatário (phone, email)
      content,        // conteúdo da mensagem
      template,       // template (se houver)
      leadId,         // referência ao lead
      patientId,      // referência ao paciente
      metadata = {}   // metadados extras
    } = payload;

    const log = createContextLogger(correlationId, 'notification');

    log.info('start', 'Processando notificação', {
      type,
      channel,
      to: to?.substring(0, 10) + '...', // log parcial por privacidade
      leadId,
      eventId
    });

    try {
      // 🛡️ IDEMPOTÊNCIA - Verifica via Event Store
      // (usa safeIdempotencyKey definido abaixo, mas verificação preliminar aqui)
      const checkKey = (idempotencyKey && typeof idempotencyKey === 'string') ? idempotencyKey : null;
      if (checkKey && await eventExists(checkKey)) {
        log.info('idempotent', 'Notificação já processada', { idempotencyKey: checkKey });
        return {
          status: 'already_processed',
          idempotent: true
        };
      }

      // 🛡️ IDEMPOTÊNCIA - Verifica via eventId
      if (eventId && await EventStore.findOne({ eventId })) {
        log.info('idempotent', 'Evento já existe no Event Store', { eventId });
        return {
          status: 'already_processed',
          idempotent: true
        };
      }

      // Validações
      if (!type || !to) {
        throw new Error('TYPE_AND_TO_REQUIRED');
      }

      // 🔄 WRAP do processamento com garantias
      const processNotification = async () => {
        let result;

        // Roteia pelo tipo de canal
        switch (type || channel) {
          case 'whatsapp':
            result = await sendWhatsAppNotification({
              to,
              content,
              template,
              leadId,
              patientId,
              metadata,
              correlationId
            });
            break;

          case 'email':
            result = await sendEmailNotification({
              to,
              content,
              template,
              leadId,
              patientId,
              metadata,
              correlationId
            });
            break;

          case 'sms':
            result = await sendSMSNotification({
              to,
              content,
              leadId,
              patientId,
              metadata,
              correlationId
            });
            break;

          case 'push':
            result = await sendPushNotification({
              to,
              content,
              leadId,
              patientId,
              metadata,
              correlationId
            });
            break;

          default:
            throw new Error(`UNKNOWN_CHANNEL: ${type || channel}`);
        }

        // 🎯 PUBLICA EVENTO: NOTIFICATION_SENT
        await publishEvent(
          EventTypes.NOTIFICATION_SENT,
          {
            notificationId: result.notificationId,
            type: type || channel,
            to: to.substring(0, 10) + '***', // mascarado
            leadId: leadId?.toString(),
            patientId: patientId?.toString(),
            sentAt: new Date().toISOString(),
            channelResult: result
          },
          { correlationId }
        );

        // 🛡️ REGISTRA EVENTO NO EVENT STORE
        await appendEvent({
          eventType: EventTypes.NOTIFICATION_REQUESTED,
          aggregateType: 'notification',
          aggregateId: result.notificationId,
          payload: {
            type: type || channel,
            to: to.substring(0, 10) + '***',
            leadId: leadId?.toString(),
            patientId: patientId?.toString(),
            content: content?.substring(0, 100),
            template: template?.name
          },
          metadata: {
            correlationId,
            channelResult: result
          },
          idempotencyKey: effectiveIdempotencyKey,
          correlationId
        });

        return result;
      };

      // 🛡️ SANITIZAÇÃO DEFENSIVA (idempotencyKey SEMPRE string)
      const safeEventId = eventId || `notif_${Date.now()}`;
      const safeIdempotencyKey = (idempotencyKey && typeof idempotencyKey === 'string')
        ? idempotencyKey 
        : `${type || channel}_${to?.substring(0, 10) || 'unknown'}_${Date.now()}`;
      
      // Atualiza idempotencyKey para uso no processNotification
      const effectiveIdempotencyKey = safeIdempotencyKey;
      
      const result = await processWithGuarantees(
        { eventId: safeEventId, idempotencyKey: effectiveIdempotencyKey },
        processNotification,
        'notificationOrchestratorWorker'
      );

      log.info('completed', 'Notificação enviada com sucesso', {
        type: type || channel,
        notificationId: result.result?.notificationId
      });

      return {
        status: 'sent',
        type: type || channel,
        notificationId: result.result?.notificationId,
        correlationId
      };

    } catch (error) {
      log.error('error', 'Erro ao enviar notificação', {
        error: error.message,
        type: type || channel,
        to: to?.substring(0, 10) + '...'
      });

      // 🎯 PUBLICA EVENTO: NOTIFICATION_FAILED
      await publishEvent(
        EventTypes.NOTIFICATION_FAILED,
        {
          type: type || channel,
          to: to?.substring(0, 10) + '***',
          leadId: leadId?.toString(),
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
    concurrency: 5
  });

  worker.on('completed', (job, result) => {
    console.log(`[NotificationOrchestrator] Job ${job.id}: ${result.status}`);
  });

  worker.on('failed', (job, error) => {
    console.error(`[NotificationOrchestrator] Job ${job?.id} falhou:`, error.message);
  });

  console.log('[NotificationOrchestrator] Worker iniciado');
  return worker;
}

// ============ HELPERS ============

/**
 * Envia notificação via WhatsApp
 */
async function sendWhatsAppNotification({ to, content, template, leadId, patientId, metadata, correlationId }) {
  const log = createContextLogger(correlationId, 'notification_whatsapp');

  log.info('whatsapp_start', 'Enviando WhatsApp', {
    to: to.substring(0, 10) + '...',
    hasTemplate: !!template
  });

  let result;

  if (template) {
    // Usa template message
    result = await sendTemplateMessage({
      to,
      templateName: template.name,
      languageCode: template.language || 'pt_BR',
      components: template.components || []
    });
  } else {
    // Usa texto simples
    result = await sendTextMessage({
      to,
      text: content,
      lead: leadId,
      patientId,
      ...metadata
    });
  }

  log.info('whatsapp_success', 'WhatsApp enviado', {
    waMessageId: result?.messages?.[0]?.id
  });

  return {
    notificationId: result?.messages?.[0]?.id || `wa_${Date.now()}`,
    provider: 'whatsapp',
    waMessageId: result?.messages?.[0]?.id
  };
}

/**
 * Envia notificação via Email
 */
async function sendEmailNotification({ to, content, template, leadId, patientId, metadata, correlationId }) {
  const log = createContextLogger(correlationId, 'notification_email');

  log.info('email_start', 'Enviando Email', {
    to: to.substring(0, 5) + '...',
    subject: metadata.subject
  });

  // TODO: Implementar integração com serviço de email
  // Por enquanto, loga e retorna mock
  log.warn('email_mock', 'Email service não implementado, usando mock');

  return {
    notificationId: `email_${Date.now()}`,
    provider: 'email',
    status: 'mock_sent'
  };
}

/**
 * Envia notificação via SMS
 */
async function sendSMSNotification({ to, content, leadId, patientId, metadata, correlationId }) {
  const log = createContextLogger(correlationId, 'notification_sms');

  log.info('sms_start', 'Enviando SMS', {
    to: to.substring(0, 10) + '...'
  });

  // TODO: Implementar integração com serviço de SMS
  log.warn('sms_mock', 'SMS service não implementado, usando mock');

  return {
    notificationId: `sms_${Date.now()}`,
    provider: 'sms',
    status: 'mock_sent'
  };
}

/**
 * Envia notificação Push
 */
async function sendPushNotification({ to, content, leadId, patientId, metadata, correlationId }) {
  const log = createContextLogger(correlationId, 'notification_push');

  log.info('push_start', 'Enviando Push', {
    token: to.substring(0, 10) + '...'
  });

  // Importa dinamicamente para não quebrar se não estiver configurado
  try {
    const { sendPushNotification } = await import('../services/notificationService.js');

    await sendPushNotification({
      token: to,
      title: metadata.title || 'Notificação',
      body: content,
      data: {
        leadId: leadId?.toString(),
        patientId: patientId?.toString(),
        ...metadata.data
      }
    });

    return {
      notificationId: `push_${Date.now()}`,
      provider: 'fcm',
      status: 'sent'
    };
  } catch (error) {
    log.error('push_error', 'Erro ao enviar push', { error: error.message });
    throw error;
  }
}
