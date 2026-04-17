// domains/notification/contracts/NotificationEvents.contract.js
/**
 * Contract oficial de eventos do domínio Notification.
 */

import { defineEventContract, V } from '../../../infrastructure/events/eventContractRegistry.js';

export function registerNotificationEventContracts() {
    defineEventContract('NOTIFICATION_REQUESTED', {
        version: 1,
        required: ['type', 'recipientId'],
        optional: ['appointmentId', 'patientId', 'channels', 'payload', 'correlationId'],
        validators: {
            type: V.isString('type deve ser uma string'),
            recipientId: V.isString('recipientId deve ser uma string'),
            appointmentId: V.isOptionalMongoId(),
            patientId: V.isOptionalMongoId(),
        },
        description: 'Solicitação de envio de notificação'
    });

    defineEventContract('NOTIFICATION_SENT', {
        version: 1,
        required: ['notificationId'],
        optional: ['channel', 'sentAt', 'correlationId'],
        validators: {
            notificationId: V.isMongoId(),
        },
        description: 'Notificação enviada com sucesso'
    });

    defineEventContract('NOTIFICATION_FAILED', {
        version: 1,
        required: ['notificationId'],
        optional: ['channel', 'error', 'correlationId'],
        validators: {
            notificationId: V.isMongoId(),
        },
        description: 'Falha no envio de notificação'
    });

    defineEventContract('WHATSAPP_MESSAGE_REQUESTED', {
        version: 1,
        required: ['leadId', 'message'],
        optional: ['mediaUrl', 'templateName', 'correlationId'],
        validators: {
            leadId: V.isMongoId(),
        },
        description: 'Solicitação de envio de mensagem WhatsApp'
    });

    defineEventContract('EMAIL_MESSAGE_REQUESTED', {
        version: 1,
        required: ['to', 'subject'],
        optional: ['body', 'templateId', 'correlationId'],
        validators: {
            to: V.isString('to deve ser uma string'),
            subject: V.isString('subject deve ser uma string'),
        },
        description: 'Solicitação de envio de email'
    });
}
