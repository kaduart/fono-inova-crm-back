// workers/registry.js
// 🏗️ Registry de workers por domínio — execução baseada em EVENTOS (não ordem)

import { startPaymentWorker } from './paymentWorker.js';
import { startBalanceWorker } from './balanceWorker.js';
import { startPackageValidationWorker } from './packageValidationWorker.js';
import { startReconciliationWorker } from './reconciliationWorker.js';
import { startAppointmentWorker } from './appointmentWorker.js';
import { startPreAgendamentoWorker } from './preAgendamentoWorker.js';
import { startAppointmentIntegrationWorker } from './appointmentIntegrationWorker.js';
import { startUpdateOrchestratorWorker } from './updateOrchestratorWorker.js';
import { startCancelOrchestratorWorkerV2 } from './cancelOrchestratorWorker.v2.js';
import { startCompleteOrchestratorWorker } from './completeOrchestratorWorker.js';
import { startCreateAppointmentWorker } from './createAppointmentWorker.js';
import { startOutboxWorker } from './outboxWorker.js';
import { startInvoiceWorker } from './invoiceWorker.js';
import { startSyncMedicalWorker } from './syncMedicalWorker.js';
import { startSyncWorker } from './syncWorker.js';
import { startLeadRecoveryWorker } from './leadRecoveryWorker.js';
import { startTotalsWorker } from './totalsWorker.js';
import { startDailyClosingWorker } from './dailyClosingWorker.js';
import { startEvolutionWorker } from './evolutionWorker.js';
import { startFollowupOrchestratorWorker } from './followupOrchestratorWorker.js';
import { startNotificationOrchestratorWorker } from './notificationOrchestratorWorker.js';

import { patientWorker } from '../domains/clinical/workers/patientWorker.js';
import { patientProjectionWorker } from '../domains/clinical/workers/patientProjectionWorker.js';

import { packageProjectionWorker } from '../domains/billing/workers/packageProjectionWorker.js';
import { packageProcessingWorker } from '../domains/billing/workers/packageProcessingWorker.js';
import { startClinicalOrchestratorWorker } from '../domains/clinical/workers/clinicalOrchestrator.js';
import { startSessionWorker } from '../domains/clinical/workers/sessionWorker.js';

import { startIntegrationOrchestratorWorker } from '../domains/integration/workers/integrationOrchestratorWorker.js';
import { startBillingConsumerWorker } from '../domains/billing/workers/billingConsumerWorker.js';
import { startInsuranceOrchestratorWorker } from '../domains/billing/workers/insuranceOrchestratorWorker.js';

import { startLeadOrchestratorWorkerV2 } from '../domains/whatsapp/workers/leadOrchestratorWorker.v2.js';

import { createWhatsappInboundWorker } from '../domains/whatsapp/workers/whatsappInboundWorker.js';
import { createMessagePersistenceWorker } from '../domains/whatsapp/workers/messagePersistenceWorker.js';
import { createConversationStateWorker } from '../domains/whatsapp/workers/conversationStateWorker.js';
import { createContextBuilderWorker } from '../domains/whatsapp/workers/contextBuilderWorker.js';
import { createMessageResponseWorker } from '../domains/whatsapp/workers/messageResponseWorker.js';
import { createWhatsappAutoReplyWorker } from '../domains/whatsapp/workers/whatsappAutoReplyWorker.js';
import { createLeadInteractionWorker } from '../domains/whatsapp/workers/leadInteractionWorker.js';
import { createRealtimeWorker } from '../domains/whatsapp/workers/realtimeWorker.js';
import { createChatProjectionWorker } from '../domains/whatsapp/workers/chatProjectionWorker.js';

// optional safety worker (se existir)
import { createWhatsappSendWorker } from '../domains/whatsapp/workers/whatsappSendWorker.js';
import { createIntentClassifierWorker } from '../domains/whatsapp/workers/intentClassifierWorker.js';
import { createFsmRouterWorker } from '../domains/whatsapp/workers/fsmRouterWorker.js';

// 🎯 Feature flag helper — default true para backward compatibility
const isEnabled = (flag, defaultValue = true) => {
  const val = process.env[flag];
  if (val === undefined || val === '') return defaultValue;
  return val === 'true';
};

const GROUPS = {

  // =========================
  // SCHEDULING
  // =========================
  scheduling: async (workers) => {
    if (isEnabled('ENABLE_SCHEDULING_CREATE_APPOINTMENT')) workers.push(startCreateAppointmentWorker());

    if (isEnabled('ENABLE_SCHEDULING_CANCEL')) {
      try { workers.push(await startCancelOrchestratorWorkerV2()); } catch {}
    }
    if (isEnabled('ENABLE_SCHEDULING_COMPLETE')) {
      try { workers.push(await startCompleteOrchestratorWorker()); } catch {}
    }

    if (isEnabled('ENABLE_SCHEDULING_APPOINTMENT')) workers.push(startAppointmentWorker());
    if (isEnabled('ENABLE_SCHEDULING_PRE_AGENDAMENTO')) workers.push(startPreAgendamentoWorker());
    if (isEnabled('ENABLE_SCHEDULING_APPOINTMENT_INTEGRATION')) workers.push(startAppointmentIntegrationWorker());
    if (isEnabled('ENABLE_SCHEDULING_UPDATE')) workers.push(startUpdateOrchestratorWorker());
    if (isEnabled('ENABLE_SCHEDULING_SYNC_MEDICAL')) workers.push(startSyncMedicalWorker());

    console.log('[Registry] scheduling ok');
  },

  // =========================
  // BILLING
  // =========================
  billing: async (workers) => {
    if (isEnabled('ENABLE_BILLING_PAYMENT')) workers.push(startPaymentWorker());
    if (isEnabled('ENABLE_BILLING_BALANCE')) workers.push(startBalanceWorker());
    if (isEnabled('ENABLE_BILLING_PACKAGE_VALIDATION')) workers.push(startPackageValidationWorker());
    if (isEnabled('ENABLE_BILLING_INVOICE')) workers.push(startInvoiceWorker());
    if (isEnabled('ENABLE_BILLING_TOTALS')) workers.push(startTotalsWorker());
    if (isEnabled('ENABLE_BILLING_PACKAGE_PROJECTION')) workers.push(packageProjectionWorker);
    if (isEnabled('ENABLE_BILLING_PACKAGE_PROCESSING')) workers.push(packageProcessingWorker);
    if (isEnabled('ENABLE_BILLING_CONSUMER')) workers.push(startBillingConsumerWorker());
    if (isEnabled('ENABLE_BILLING_INSURANCE')) workers.push(startInsuranceOrchestratorWorker());

    console.log('[Registry] billing ok');
  },

  // =========================
  // CLINICAL
  // =========================
  clinical: async (workers) => {
    if (isEnabled('ENABLE_CLINICAL_EVOLUTION')) workers.push(startEvolutionWorker());
    if (isEnabled('ENABLE_CLINICAL_PATIENT')) workers.push(patientWorker);
    if (isEnabled('ENABLE_CLINICAL_PATIENT_PROJECTION')) workers.push(patientProjectionWorker);
    if (isEnabled('ENABLE_CLINICAL_ORCHESTRATOR')) workers.push(startClinicalOrchestratorWorker());
    if (isEnabled('ENABLE_CLINICAL_SESSION')) workers.push(startSessionWorker());
    if (isEnabled('ENABLE_CLINICAL_SYNC')) workers.push(startSyncWorker());

    console.log('[Registry] clinical ok');
  },

  // =========================
  // WHATSAPP V2 (EVENT-DRIVEN PIPELINE)
  // =========================
  whatsapp: async (workers) => {
    const started = [];

    // 1. entrada (CRÍTICO)
    if (isEnabled('ENABLE_WHATSAPP_INBOUND', true)) {
      workers.push(createWhatsappInboundWorker());
      started.push('inbound');
    }

    // 2. persistência + lead resolve (CRÍTICO)
    if (isEnabled('ENABLE_WHATSAPP_PERSISTENCE', true)) {
      workers.push(createMessagePersistenceWorker());
      started.push('persistence');
    }

    // 3. estado (Redis hot state) (CRÍTICO)
    if (isEnabled('ENABLE_WHATSAPP_CONVERSATION_STATE', true)) {
      workers.push(createConversationStateWorker());
      started.push('conversation-state');
    }

    // 4. contexto IA (otimização — pode ser desligado se usar contexto inline)
    if (isEnabled('ENABLE_WHATSAPP_CONTEXT_BUILDER', true)) {
      workers.push(createContextBuilderWorker());
      started.push('context-builder');
    }

    // 5. detecta resposta / follow-up (otimização)
    if (isEnabled('ENABLE_WHATSAPP_MESSAGE_RESPONSE', true)) {
      workers.push(createMessageResponseWorker({}));
      started.push('message-response');
    }

    // 6. decisão do CRM / FSM brain (CRÍTICO)
    if (isEnabled('ENABLE_WHATSAPP_LEAD_ORCHESTRATOR', true)) {
      workers.push(startLeadOrchestratorWorkerV2());
      started.push('lead-orchestrator');
    }

    // 7. resposta automática IA (CRÍTICO)
    if (isEnabled('ENABLE_WHATSAPP_AUTO_REPLY', true)) {
      workers.push(createWhatsappAutoReplyWorker());
      started.push('auto-reply');
    }

    // 8. tracking e analytics (NÃO CRÍTICO — pode desligar)
    if (isEnabled('ENABLE_WHATSAPP_LEAD_INTERACTION', false)) {
      workers.push(createLeadInteractionWorker());
      started.push('lead-interaction');
    }

    // 9. realtime frontend (ESSENCIAL para atualizar sidebar e notificações)
    if (isEnabled('ENABLE_WHATSAPP_REALTIME', true)) {
      workers.push(createRealtimeWorker());
      started.push('realtime');
    }

    // 10. read model / dashboard (NÃO CRÍTICO — pode desligar)
    if (isEnabled('ENABLE_WHATSAPP_CHAT_PROJECTION', true)) {
      workers.push(createChatProjectionWorker());
      started.push('chat-projection');
    }

    // 11. classificação de intenção de follow-up (NÃO CRÍTICO — pode ser inline)
    if (isEnabled('ENABLE_WHATSAPP_INTENT_CLASSIFIER', false)) {
      workers.push(createIntentClassifierWorker());
      started.push('intent-classifier');
    }

    // 12. roteamento FSM baseado na intenção (NÃO CRÍTICO — pode ser inline)
    if (isEnabled('ENABLE_WHATSAPP_FSM_ROUTER', false)) {
      workers.push(createFsmRouterWorker());
      started.push('fsm-router');
    }

    // envio de mensagens (ESSENCIAL — sempre ativo)
    workers.push(createWhatsappSendWorker());
    started.push('send');

    console.log(`[Registry] whatsapp V2 ok (${started.length} workers: ${started.join(', ')})`);
    console.log(`[Registry] Workers ativos: ${JSON.stringify(started)}`);
  },

  // =========================
  // RECONCILIATION
  // =========================
  reconciliation: async (workers) => {
    if (isEnabled('ENABLE_RECONCILIATION_RECONCILIATION')) workers.push(startReconciliationWorker());
    if (isEnabled('ENABLE_RECONCILIATION_LEAD_RECOVERY')) workers.push(startLeadRecoveryWorker());
    if (isEnabled('ENABLE_RECONCILIATION_OUTBOX')) workers.push(startOutboxWorker());
    if (isEnabled('ENABLE_RECONCILIATION_INTEGRATION')) workers.push(startIntegrationOrchestratorWorker());
    if (isEnabled('ENABLE_RECONCILIATION_DAILY_CLOSING')) workers.push(startDailyClosingWorker());
    if (isEnabled('ENABLE_RECONCILIATION_FOLLOWUP')) workers.push(startFollowupOrchestratorWorker());
    if (isEnabled('ENABLE_RECONCILIATION_NOTIFICATION')) workers.push(startNotificationOrchestratorWorker());

    console.log('[Registry] reconciliation ok');
  }
};

export const VALID_GROUPS = Object.keys(GROUPS);

export async function startWorkerGroup(groupName, workers = []) {
  const fn = GROUPS[groupName];

  if (!fn) {
    throw new Error(`Grupo inválido: ${groupName}`);
  }

  console.log(`[Registry] start: ${groupName}`);
  try {
    await fn(workers);
  } catch (err) {
    console.error(`[Registry] ❌ Grupo '${groupName}' falhou:`, err.message);
    // Não propaga o erro — permite que outros grupos continuem iniciando
  }
  return workers;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function startAllWorkerGroups(workers = []) {
  for (const g of VALID_GROUPS) {
    await startWorkerGroup(g, workers);
    // 🎯 Staggered boot: espera 2s entre grupos para evitar pico de conexões Redis
    await sleep(2000);
  }
  return workers;
}