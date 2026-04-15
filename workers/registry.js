// workers/registry.js
// 🏗️ Registry de workers por domínio — permite escalar horizontalmente

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
import { startLeadOrchestratorWorker } from './leadOrchestratorWorker.js';
import { startFollowupOrchestratorWorker } from './followupOrchestratorWorker.js';
import { startNotificationOrchestratorWorker } from './notificationOrchestratorWorker.js';
import { startUpdateOrchestratorWorker } from './updateOrchestratorWorker.js';
import { startAppointmentIntegrationWorker } from './appointmentIntegrationWorker.js';
import { startInsuranceOrchestratorWorker } from '../domains/billing/workers/index.js';
import { startBillingConsumerWorker } from '../domains/billing/workers/billingConsumerWorker.js';
import { startDailyClosingWorker } from './dailyClosingWorker.js';
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
import { createMessageResponseWorker } from '../domains/whatsapp/workers/messageResponseWorker.js';
import { createWhatsappSendWorker } from '../domains/whatsapp/workers/whatsappSendWorker.js';
import { createWhatsappInboundWorker } from '../domains/whatsapp/workers/whatsappInboundWorker.js';
import { createWhatsappAutoReplyWorker } from '../domains/whatsapp/workers/whatsappAutoReplyWorker.js';
import { createContextBuilderWorker } from '../domains/whatsapp/workers/contextBuilderWorker.js';
import { createConversationStateWorker } from '../domains/whatsapp/workers/conversationStateWorker.js';
import { createMessagePersistenceWorker } from '../domains/whatsapp/workers/messagePersistenceWorker.js';
import { createLeadInteractionWorker } from '../domains/whatsapp/workers/leadInteractionWorker.js';
import { createRealtimeWorker } from '../domains/whatsapp/workers/realtimeWorker.js';
import { createChatProjectionWorker } from '../domains/whatsapp/workers/chatProjectionWorker.js';

const GROUPS = {
  scheduling: async (workers) => {
    workers.push(startCreateAppointmentWorker());
    try {
      workers.push(await startCancelOrchestratorWorkerV2());
      console.log('[Registry] ✅ CancelOrchestratorWorkerV2 iniciado');
    } catch (err) {
      console.error('[Registry] ❌ Erro ao iniciar CancelOrchestratorWorkerV2:', err.message);
    }
    try {
      workers.push(await startCompleteOrchestratorWorker());
      console.log('[Registry] ✅ CompleteOrchestratorWorker iniciado');
    } catch (err) {
      console.error('[Registry] ❌ Erro ao iniciar CompleteOrchestratorWorker:', err.message);
    }
    workers.push(startUpdateOrchestratorWorker());
    workers.push(startAppointmentIntegrationWorker());
    workers.push(startSyncMedicalWorker());
    workers.push(startAppointmentWorker());
    console.log('[Registry] ✅ Scheduling workers iniciados');
  },

  billing: async (workers) => {
    workers.push(startPaymentWorker());
    workers.push(startBalanceWorker());
    workers.push(startPackageValidationWorker());
    workers.push(startInvoiceWorker());
    workers.push(startDailyClosingWorker());
    workers.push(startTotalsWorker());
    workers.push(startInsuranceOrchestratorWorker());
    workers.push(startBillingConsumerWorker());
    workers.push(packageProjectionWorker);
    workers.push(packageProcessingWorker);
    console.log('[Registry] ✅ Billing workers iniciados');
  },

  clinical: async (workers) => {
    workers.push(patientWorker);
    workers.push(patientProjectionWorker);
    workers.push(startClinicalOrchestratorWorker());
    workers.push(startSessionWorker());
    console.log('[Registry] ✅ Clinical workers iniciados');
  },

  whatsapp: async (workers) => {
    workers.push(startLeadOrchestratorWorker());
    workers.push(startFollowupOrchestratorWorker());
    workers.push(startNotificationOrchestratorWorker());
    workers.push(startLeadOrchestratorWorkerV2());
    workers.push(createMessageResponseWorker({}));
    workers.push(createWhatsappSendWorker());
    workers.push(createWhatsappInboundWorker());
    workers.push(createWhatsappAutoReplyWorker());
    workers.push(createContextBuilderWorker());
    workers.push(createConversationStateWorker());
    workers.push(createMessagePersistenceWorker());
    workers.push(createLeadInteractionWorker());
    workers.push(createRealtimeWorker());
    workers.push(createChatProjectionWorker());
    console.log('[Registry] ✅ WhatsApp workers iniciados');
  },

  reconciliation: async (workers) => {
    workers.push(startReconciliationWorker());
    workers.push(startLeadRecoveryWorker());
    workers.push(startOutboxWorker());
    workers.push(startIntegrationOrchestratorWorker());
    console.log('[Registry] ✅ Reconciliation workers iniciados');
  }
};

export const VALID_GROUPS = Object.keys(GROUPS);

export async function startWorkerGroup(groupName, workers = []) {
  const initializer = GROUPS[groupName];
  if (!initializer) {
    throw new Error(`Grupo de workers desconhecido: ${groupName}. Válidos: ${VALID_GROUPS.join(', ')}`);
  }
  console.log(`[Registry] Iniciando grupo: ${groupName}`);
  await initializer(workers);
  return workers;
}

export async function startAllWorkerGroups(workers = []) {
  for (const groupName of VALID_GROUPS) {
    await startWorkerGroup(groupName, workers);
  }
  return workers;
}
