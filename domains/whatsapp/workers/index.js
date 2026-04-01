// back/domains/whatsapp/workers/index.js
/**
 * WhatsApp Workers Index
 * 
 * Workers do domínio WhatsApp - Arquitetura Event-Driven
 * 
 * Baseado no documento-analise.txt (Ponto 2)
 * 
 * ESTRUTURA:
 * ┌─────────────────────────────────────────────────────────────┐
 * │                   WHATSAPP DOMAIN                            │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                              │
 * │  MessageBufferWorker                                        │
 * │  ├── Evento: WHATSAPP_MESSAGE_RECEIVED                      │
 * │  └── Responsabilidade: Lock, buffer, idempotência, debounce│
 * │                                                              │
 * │  LeadStateWorker                                            │
 * │  ├── Evento: LEAD_STATE_CHECK_REQUESTED                     │
 * │  └── Responsabilidade: Recarrega estado, controle manual   │
 * │                                                              │
 * │  OrchestratorWorker                                         │
 * │  ├── Evento: ORCHESTRATOR_RUN_REQUESTED                     │
 * │  └── Responsabilidade: Agrega contexto, decide resposta    │
 * │                                                              │
 * │  NotificationWorker                                         │
 * │  ├── Evento: NOTIFICATION_REQUESTED                         │
 * │  └── Responsabilidade: Formata e envia mensagens           │
 * │                                                              │
 * │  RealtimeWorker                                             │
 * │  ├── Evento: MESSAGE_SENT                                   │
 * │  └── Responsabilidade: Emite via socket, atualiza dashboards│
 * │                                                              │
 * └─────────────────────────────────────────────────────────────┘
 * 
 * FLUXO:
 * 
 * WhatsApp Webhook
 *      ↓
 * MessageBufferWorker (Anti-flood, debounce)
 *      ↓
 * LeadStateWorker (Carrega contexto do lead)
 *      ↓
 * OrchestratorWorker (IA decide resposta)
 *      ↓
 * NotificationWorker (Envia resposta)
 *      ↓
 * RealtimeWorker (Atualiza UI em tempo real)
 */

export { createMessageBufferWorker } from './messageBufferWorker.js';
export { createLeadStateWorker } from './leadStateWorker.js';
export { createOrchestratorWorker } from './orchestratorWorker.js';
export { createNotificationWorker } from './notificationWorker.js';
export { createRealtimeWorker } from './realtimeWorker.js';
