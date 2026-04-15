// workers/registry.js
// 🏗️ Registry de workers por domínio — execução baseada em EVENTOS (não ordem)

import { startPaymentWorker } from './paymentWorker.js';
import { startBalanceWorker } from './balanceWorker.js';
import { startPackageValidationWorker } from './packageValidationWorker.js';
import { startReconciliationWorker } from './reconciliationWorker.js';
import { startAppointmentWorker } from './appointmentWorker.js';
import { startCancelOrchestratorWorkerV2 } from './cancelOrchestratorWorker.v2.js';
import { startCompleteOrchestratorWorker } from './completeOrchestratorWorker.js';
import { startCreateAppointmentWorker } from './createAppointmentWorker.js';
import { startOutboxWorker } from './outboxWorker.js';
import { startInvoiceWorker } from './invoiceWorker.js';
import { startSyncMedicalWorker } from './syncMedicalWorker.js';
import { startLeadRecoveryWorker } from './leadRecoveryWorker.js';
import { startTotalsWorker } from './totalsWorker.js';

import { patientWorker } from '../domains/clinical/workers/patientWorker.js';
import { patientProjectionWorker } from '../domains/clinical/workers/patientProjectionWorker.js';

import { packageProjectionWorker } from '../domains/billing/workers/packageProjectionWorker.js';
import { packageProcessingWorker } from '../domains/billing/workers/packageProcessingWorker.js';
import { startClinicalOrchestratorWorker } from '../domains/clinical/workers/clinicalOrchestrator.js';
import { startSessionWorker } from '../domains/clinical/workers/sessionWorker.js';

import { startIntegrationOrchestratorWorker } from '../domains/integration/workers/integrationOrchestratorWorker.js';

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

const GROUPS = {

  // =========================
  // SCHEDULING
  // =========================
  scheduling: async (workers) => {
    workers.push(startCreateAppointmentWorker());

    try { workers.push(await startCancelOrchestratorWorkerV2()); } catch {}
    try { workers.push(await startCompleteOrchestratorWorker()); } catch {}

    workers.push(startAppointmentWorker());
    workers.push(startSyncMedicalWorker());

    console.log('[Registry] scheduling ok');
  },

  // =========================
  // BILLING
  // =========================
  billing: async (workers) => {
    workers.push(startPaymentWorker());
    workers.push(startBalanceWorker());
    workers.push(startPackageValidationWorker());
    workers.push(startInvoiceWorker());
    workers.push(startTotalsWorker());
    workers.push(packageProjectionWorker);
    workers.push(packageProcessingWorker);

    console.log('[Registry] billing ok');
  },

  // =========================
  // CLINICAL
  // =========================
  clinical: async (workers) => {
    workers.push(patientWorker);
    workers.push(patientProjectionWorker);
    workers.push(startClinicalOrchestratorWorker());
    workers.push(startSessionWorker());

    console.log('[Registry] clinical ok');
  },

  // =========================
  // WHATSAPP V2 (EVENT-DRIVEN PIPELINE)
  // =========================
  whatsapp: async (workers) => {

    // 1. entrada
    workers.push(createWhatsappInboundWorker());

    // 2. persistência + lead resolve
    workers.push(createMessagePersistenceWorker());

    // 3. estado (Redis hot state)
    workers.push(createConversationStateWorker());

    // 4. contexto IA
    workers.push(createContextBuilderWorker());

    // 5. detecta resposta / follow-up
    workers.push(createMessageResponseWorker({}));

    // 6. decisão do CRM / FSM brain
    workers.push(startLeadOrchestratorWorkerV2());

    // 7. resposta automática IA
    workers.push(createWhatsappAutoReplyWorker());

    // 8. tracking e analytics
    workers.push(createLeadInteractionWorker());

    // 9. realtime frontend
    workers.push(createRealtimeWorker());

    // 10. read model / dashboard
    workers.push(createChatProjectionWorker());

    // 11. classificação de intenção de follow-up
    workers.push(createIntentClassifierWorker());

    // 12. roteamento FSM baseado na intenção
    workers.push(createFsmRouterWorker());

    // opcional (envio direto se necessário)
    if (process.env.ENABLE_SEND_WORKER === 'true') {
      workers.push(createWhatsappSendWorker());
    }

    console.log('[Registry] whatsapp V2 ok');
  },

  // =========================
  // RECONCILIATION
  // =========================
  reconciliation: async (workers) => {
    workers.push(startReconciliationWorker());
    workers.push(startLeadRecoveryWorker());
    workers.push(startOutboxWorker());
    workers.push(startIntegrationOrchestratorWorker());

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
  await fn(workers);
  return workers;
}

export async function startAllWorkerGroups(workers = []) {
  for (const g of VALID_GROUPS) {
    await startWorkerGroup(g, workers);
  }
  return workers;
}