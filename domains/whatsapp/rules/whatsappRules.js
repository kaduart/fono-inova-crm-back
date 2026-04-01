// back/domains/whatsapp/rules/whatsappRules.js
/**
 * WhatsApp Domain Rules
 * 
 * Regras de negócio extraídas de whatsappController.js
 * Especialmente do fluxo handleAutoReply (CORE DO SISTEMA)
 * 
 * @see ../../../controllers/whatsappController.js
 */

// ============================================
// RN-WHATSAPP-001 — LOCK GLOBAL (anti-corrida)
// Fonte: handleAutoReply - Redis SET NX + TTL (30s)
// ============================================
export const WhatsAppLockRules = {
  redisKey: 'processing:${from}',
  command: 'SET NX', // Set if Not Exists
  ttlSeconds: 30,
  
  onLockExists: {
    action: 'buffer_message',
    storeIn: 'pending:ai:${from}',
    reason: 'processamento_em_andamento'
  },
  
  // Essencial para eventual consistency
  pattern: 'distributed_lock'
};

// ============================================
// RN-WHATSAPP-002 — BUFFER DE MENSAGENS
// Fonte: handleAutoReply - pending:ai:${from}
// ============================================
export const WhatsAppBufferRules = {
  redisKey: 'pending:ai:${from}',
  
  // Mensagens durante lock são acumuladas
  aggregation: {
    enabled: true,
    strategy: 'append_to_list',
    maxSize: 100 // Limite de segurança
  },
  
  // Depois agregadas em único contexto
  postProcessing: {
    when: 'lock_released',
    action: 'aggregate_and_process'
  },
  
  // Pattern: Event Aggregation / Message Collapsing
  pattern: 'message_aggregation'
};

// ============================================
// RN-WHATSAPP-003 — ANTI-DUPLICAÇÃO (IDEMPOTÊNCIA)
// Fonte: handleAutoReply - md5(content)
// ============================================
export const WhatsAppIdempotencyRules = {
  keyGenerator: 'md5(content)',
  windowSeconds: 10,
  
  onDuplicate: {
    action: 'ignore',
    logLevel: 'debug',
    reason: 'mensagem_duplicada'
  },
  
  // Pattern: Idempotency Key
  pattern: 'idempotency_key'
};

// ============================================
// RN-WHATSAPP-004 — DEBOUNCE DE RESPOSTA
// Fonte: handleAutoReply - 30s window
// ============================================
export const WhatsAppDebounceRules = {
  windowSeconds: 30,
  
  checkKey: 'lastReply:${from}',
  
  onRecentReply: {
    action: 'skip_response',
    thresholdSeconds: 30
  },
  
  // Protege contra: spam, loops, reprocessamento
  protections: ['spam', 'loops', 'reprocessing'],
  
  pattern: 'debounce'
};

// ============================================
// RN-WHATSAPP-005 — RELOAD DO LEAD (FONTE DA VERDADE)
// Fonte: handleAutoReply - Lead.findById(...)
// ============================================
export const WhatsAppLeadReloadRules = {
  // Nunca confiar no lead em memória
  alwaysReload: true,
  
  query: {
    method: 'Lead.findById(id)',
    populate: ['manualControl', 'lastAppointment']
  },
  
  // Pattern: Read-after-write consistency
  pattern: 'read_after_write'
};

// ============================================
// RN-WHATSAPP-006 — CONTROLE MANUAL
// Fonte: handleAutoReply - lead.manualControl.active
// ============================================
export const WhatsAppManualControlRules = {
  checkField: 'lead.manualControl.active',
  
  whenActive: {
    action: 'skip_ai_response',
    reason: 'human_override',
    log: true
  },
  
  // Priority: human > system
  priority: {
    human: 100,
    system: 10
  },
  
  pattern: 'priority_override'
};

// ============================================
// RN-WHATSAPP-007 — TIMEOUT OU BLOQUEIO PERMANENTE
// Fonte: handleAutoReply - autoResumeAfter
// ============================================
export const WhatsAppAutoResumeRules = {
  field: 'lead.manualControl.autoResumeAfter',
  
  modes: {
    timeout: {
      condition: 'autoResumeAfter != null',
      action: 'auto_resume_after_timestamp'
    },
    permanent: {
      condition: 'autoResumeAfter == null',
      action: 'block_permanently_until_manual_intervention'
    }
  },
  
  // State machine com 2 modos
  pattern: 'state_machine_with_timeout'
};

// ============================================
// RN-WHATSAPP-008 — AUTO-REPLY GLOBAL FLAG
// Fonte: handleAutoReply - autoReplyEnabled === false
// ============================================
export const WhatsAppGlobalFlagRules = {
  flag: 'autoReplyEnabled',
  
  whenDisabled: {
    action: 'never_respond',
    reason: 'system_kill_switch'
  },
  
  // Kill switch do sistema
  pattern: 'circuit_breaker_global'
};

// ============================================
// RN-WHATSAPP-009 — CONTEXTO HISTÓRICO LIMITADO
// Fonte: handleAutoReply - limit 12 mensagens
// ============================================
export const WhatsAppContextWindowRules = {
  maxMessages: 12,
  strategy: 'sliding_window',
  
  selection: {
    order: 'desc',
    sortBy: 'timestamp'
  },
  
  // Performance protection
  pattern: 'sliding_window_context'
};

// ============================================
// RN-WHATSAPP-010 — PRIMEIRO CONTATO DETECTADO
// Fonte: handleAutoReply - greetings regex
// ============================================
export const WhatsAppFirstContactRules = {
  detection: {
    method: 'regex',
    patterns: [
      '^(oi|olá|ola|bom dia|boa tarde|boa noite|hi|hello)',
      '^\\s*(oi|olá|ola)\\s*$'
    ]
  },
  
  whenFirstContact: {
    specialTone: true,
    welcomeStrategy: 'first_contact_flow',
    affects: ['tone', 'strategy', 'response']
  },
  
  pattern: 'first_contact_detection'
};

// ============================================
// RN-WHATSAPP-011 — ORQUESTRADOR É O CÉREBRO
// Fonte: handleAutoReply - runOrchestrator()
// ============================================
export const WhatsAppOrchestratorRules = {
  // A resposta NÃO vem do controller
  decisionLayer: 'orchestrator',
  
  flow: {
    controller: 'receive_message',
    orchestrator: 'decide_response',
    controller: 'execute_command'
  },
  
  // Decision layer centralizada
  pattern: 'centralized_decision_layer'
};

// ============================================
// RN-WHATSAPP-012 — RESPOSTA SÓ SE COMANDO
// Fonte: handleAutoReply - result.command === SEND_MESSAGE
// ============================================
export const WhatsAppCommandRules = {
  commandField: 'result.command',
  
  allowedCommands: ['SEND_MESSAGE', 'SEND_TEMPLATE', 'TRANSFER_HUMAN'],
  
  onNoCommand: {
    action: 'do_not_respond',
    reason: 'orchestrator_did_not_command'
  },
  
  // Evita respostas indevidas, lógica espalhada
  pattern: 'command_based_response'
};

// ============================================
// RN-WHATSAPP-013 — FORMATAÇÃO OBRIGATÓRIA
// Fonte: handleAutoReply - formatWhatsAppResponse()
// ============================================
export const WhatsAppFormattingRules = {
  required: true,
  function: 'formatWhatsAppResponse()',
  
  transformations: [
    'normalize_whitespace',
    'limit_length',
    'escape_special_chars',
    'apply_persona_tone'
  ],
  
  // Output normalization
  pattern: 'output_normalization'
};

// ============================================
// RN-WHATSAPP-014 — PERSISTÊNCIA ANTES DO ENVIO
// Fonte: handleAutoReply - sendTextMessage()
// ============================================
export const WhatsAppPersistenceRules = {
  order: 'persistence_before_send',
  
  steps: [
    'save_to_database',
    'confirm_save',
    'send_to_whatsapp_api'
  ],
  
  // Outbox Pattern (confirmado)
  pattern: 'outbox_pattern'
};

// ============================================
// RN-WHATSAPP-015 — EVENT EM TEMPO REAL
// Fonte: handleAutoReply - io.emit("message:new")
// ============================================
export const WhatsAppRealtimeRules = {
  event: 'message:new',
  transport: 'socket.io',
  
  emitAfter: 'save_to_database',
  
  payload: {
    messageId: true,
    content: true,
    timestamp: true,
    sender: true
  },
  
  pattern: 'realtime_event'
};

// ============================================
// RN-EVENT-001 — FEATURE FLAG
// Fonte: event-driven helpers
// ============================================
export const WhatsAppFeatureFlagRules = {
  flag: 'FF_WHATSAPP_EVENT_DRIVEN',
  
  modes: {
    legacy: {
      condition: 'flag === false',
      flow: 'direct_controller_processing'
    },
    eventDriven: {
      condition: 'flag === true',
      flow: 'event_publish_and_worker_processing'
    }
  },
  
  // ESSENCIAL para migração gradual
  pattern: 'feature_flag_migration'
};

// ============================================
// RN-EVENT-002 — NOTIFICATION EVENT
// Fonte: event-driven helpers - NOTIFICATION_REQUESTED
// ============================================
export const WhatsAppNotificationEventRules = {
  eventType: 'NOTIFICATION_REQUESTED',
  
  transformation: {
    from: 'sendMessage()',
    to: 'publishEvent(NOTIFICATION_REQUESTED)'
  },
  
  pattern: 'event_sourcing'
};

// ============================================
// RN-EVENT-003 — PRIORIDADE DE EVENTO
// Fonte: event-driven helpers - priority: manual = 8
// ============================================
export const WhatsAppEventPriorityRules = {
  levels: {
    manual: 8,
    system: 5,
    automated: 3
  },
  
  default: 'system',
  
  // Manual > automático
  pattern: 'priority_queue'
};

// ============================================
// RN-EVENT-004 — ID DE CORRELAÇÃO
// Fonte: event-driven helpers - correlationId
// ============================================
export const WhatsAppCorrelationRules = {
  required: true,
  field: 'correlationId',
  
  propagation: [
    'webhook',
    'orchestrador',
    'envio',
    'resposta'
  ],
  
  // Todo evento rastreável ponta-a-ponta
  pattern: 'distributed_tracing'
};

// ============================================
// RN-EVENT-005 — FALLBACK LEGADO
// Fonte: event-driven helpers
// ============================================
export const WhatsAppFallbackRules = {
  condition: 'event_driven === OFF',
  
  fallback: {
    action: 'use_legacy_system',
    path: 'direct_whatsapp_api_call'
  },
  
  pattern: 'graceful_degradation'
};

// ============================================
// EXPORTS
// ============================================

export const WhatsAppRules = {
  lock: WhatsAppLockRules,
  buffer: WhatsAppBufferRules,
  idempotency: WhatsAppIdempotencyRules,
  debounce: WhatsAppDebounceRules,
  leadReload: WhatsAppLeadReloadRules,
  manualControl: WhatsAppManualControlRules,
  autoResume: WhatsAppAutoResumeRules,
  globalFlag: WhatsAppGlobalFlagRules,
  contextWindow: WhatsAppContextWindowRules,
  firstContact: WhatsAppFirstContactRules,
  orchestrator: WhatsAppOrchestratorRules,
  command: WhatsAppCommandRules,
  formatting: WhatsAppFormattingRules,
  persistence: WhatsAppPersistenceRules,
  realtime: WhatsAppRealtimeRules,
  
  // Event-driven rules
  featureFlag: WhatsAppFeatureFlagRules,
  notificationEvent: WhatsAppNotificationEventRules,
  eventPriority: WhatsAppEventPriorityRules,
  correlation: WhatsAppCorrelationRules,
  fallback: WhatsAppFallbackRules
};

export default WhatsAppRules;
