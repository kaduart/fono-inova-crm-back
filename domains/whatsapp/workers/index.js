/**
 * WhatsApp Workers Index
 *
 * Exporta apenas os workers que existem fisicamente no domínio WhatsApp.
 * Workers removidos: messageBuffer, leadState, orchestrator, notification.
 * Esses papéis foram consolidados nos workers atuais (whatsappInbound,
 * conversationState, contextBuilder, autoReply, whatsappSend, etc.).
 */

export { default as realtimeWorker } from './realtimeWorker.js';
export { default as messageResponseWorker } from './messageResponseWorker.js';
export { default as intentClassifierWorker } from './intentClassifierWorker.js';
export { default as fsmRouterWorker } from './fsmRouterWorker.js';
