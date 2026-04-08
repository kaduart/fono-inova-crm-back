// workers/index.js
import { startPaymentWorker } from './paymentWorker.js';
import { startBalanceWorker } from './balanceWorker.js';
import { startPackageValidationWorker } from './packageValidationWorker.js';
import { startAppointmentWorker } from './appointmentWorker.js';
import { startCancelOrchestratorWorker } from './cancelOrchestratorWorker.js';
import { startCompleteOrchestratorWorker } from './completeOrchestratorWorker.js';
import { startCreateAppointmentWorker } from './createAppointmentWorker.js';
import { startOutboxWorker } from './outboxWorker.js';
import { startInvoiceWorker } from './invoiceWorker.js';
import { startSyncMedicalWorker } from './syncMedicalWorker.js';
import { startLeadOrchestratorWorker } from './leadOrchestratorWorker.js';
import { startFollowupOrchestratorWorker } from './followupOrchestratorWorker.js';
import { startNotificationOrchestratorWorker } from './notificationOrchestratorWorker.js';
import { startUpdateOrchestratorWorker } from './updateOrchestratorWorker.js';
import { startInsuranceOrchestratorWorker } from '../domains/billing/workers/index.js';
import { startBillingConsumerWorker } from '../domains/billing/workers/billingConsumerWorker.js';
import { startDailyClosingWorker } from './dailyClosingWorker.js';
import { startTotalsWorker } from './totalsWorker.js';
// 🆕 Patients V2 Workers
import { patientWorker } from '../domains/clinical/workers/patientWorker.js';
import { patientProjectionWorker } from '../domains/clinical/workers/patientProjectionWorker.js';
// 🆕 Packages V2 Workers
import { packageProjectionWorker } from '../domains/billing/workers/packageProjectionWorker.js';
import { packageProcessingWorker } from '../domains/billing/workers/packageProcessingWorker.js';
// 🆕 Clinical V2 Workers
import { startClinicalOrchestratorWorker } from '../domains/clinical/workers/clinicalOrchestrator.js';
import { startSessionWorker } from '../domains/clinical/workers/sessionWorker.js';
// 🔗 Integration Layer
import { startIntegrationOrchestratorWorker } from '../domains/integration/workers/integrationOrchestratorWorker.js';
// 📲 WhatsApp — Lead Orchestrator V2 (reage a eventos clínicos/financeiros)
import { startLeadOrchestratorWorkerV2 } from '../domains/whatsapp/workers/leadOrchestratorWorker.v2.js';
import { createMessageResponseWorker } from '../domains/whatsapp/workers/messageResponseWorker.js';
import { createWhatsappSendWorker } from '../domains/whatsapp/workers/whatsappSendWorker.js';
import { createWhatsappInboundWorker } from '../domains/whatsapp/workers/whatsappInboundWorker.js';

/**
 * Inicializa todos os workers da aplicação
 * 
 * Ordem de inicialização:
 * 1. Workers de domínio (independentes)
 * 2. Workers orquestradores (dependem de outros)
 */

const workers = [];

export async function startAllWorkers() {
    console.log('[Workers] Iniciando workers...\n');

    // 1. Workers de domínio base
    workers.push(startPaymentWorker());
    workers.push(startBalanceWorker());
    workers.push(startPackageValidationWorker());
    
    // 2. Workers de agendamento
    workers.push(startCreateAppointmentWorker());
    
    // 3. Workers orquestradores (novos - 4.0 completa)
    // 🔴 Agora são async para garantir conexão Mongo
    workers.push(await startCancelOrchestratorWorker());
    workers.push(await startCompleteOrchestratorWorker());
    
    // 4. Workers financeiros
    workers.push(startInvoiceWorker());
    workers.push(startDailyClosingWorker());
    workers.push(startTotalsWorker());
    
    // 5. Sync Medical Worker (processa eventos médicos)
    workers.push(startSyncMedicalWorker());
    
    // 6. Lead + Followup Workers (event-driven)
    workers.push(startLeadOrchestratorWorker());
    workers.push(startFollowupOrchestratorWorker());
    
    // 7. Update Worker (genérico para edits)
    workers.push(startUpdateOrchestratorWorker());
    
    // 8. Notification Worker (desacoplado)
    workers.push(startNotificationOrchestratorWorker());
    
    // 8. Outbox Worker (garante entrega de eventos)
    workers.push(startOutboxWorker());
    
    // 9. Insurance Worker (faturamento convênio/lotes) - Domain: Billing
    workers.push(startInsuranceOrchestratorWorker());
    
    // 9.1 🆕 Billing Consumer Worker V2 (Event-Driven - Insurance Billing)
    workers.push(startBillingConsumerWorker());
    console.log('[Workers] ✅ BillingConsumerWorker V2 iniciado');
    
    // 10. 🆕 Patients V2 Workers (CQRS)
    workers.push(patientWorker);
    workers.push(patientProjectionWorker);
    console.log('[Workers] ✅ PatientWorker iniciado');
    console.log('[Workers] ✅ PatientProjectionWorker iniciado');
    
    // 11. 🆕 Packages V2 Workers (CQRS)
    workers.push(packageProjectionWorker);
    workers.push(packageProcessingWorker);
    console.log('[Workers] ✅ PackageProjectionWorker iniciado');
    console.log('[Workers] ✅ PackageProcessingWorker iniciado');

    // 12. 🆕 Clinical V2 Workers (Event-Driven)
    workers.push(startClinicalOrchestratorWorker());
    workers.push(startSessionWorker());
    console.log('[Workers] ✅ ClinicalOrchestratorWorker iniciado');
    console.log('[Workers] ✅ SessionWorker iniciado');

    // 13. 🔗 Integration Layer (tradução e roteamento entre domínios)
    workers.push(startIntegrationOrchestratorWorker());
    console.log('[Workers] ✅ IntegrationOrchestratorWorker iniciado');

    // 14. 📲 Lead Orchestrator V2 (WhatsApp reativo a eventos clínicos/financeiros)
    workers.push(startLeadOrchestratorWorkerV2());
    console.log('[Workers] ✅ LeadOrchestratorWorkerV2 iniciado');

    // 15. 📲 Message Response Worker (detecta respostas a follow-ups)
    workers.push(createMessageResponseWorker({}));
    console.log('[Workers] ✅ MessageResponseWorker iniciado');

    // 16. 📤 WhatsApp Send Worker (envio assíncrono via Evolution API)
    workers.push(createWhatsappSendWorker());
    console.log('[Workers] ✅ WhatsappSendWorker iniciado');

    // 17. 📲 WhatsApp Inbound Worker (processa mensagens recebidas de forma async)
    workers.push(createWhatsappInboundWorker());
    console.log('[Workers] ✅ WhatsappInboundWorker iniciado');

    console.log('\n[Workers] Todos os workers iniciados!\n');

    return workers;
}

export function stopAllWorkers() {
    console.log('[Workers] Parando workers...');
    
    for (const worker of workers) {
        worker.close();
    }
    
    workers.length = 0;
    
    console.log('[Workers] Todos os workers parados');
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[Workers] SIGTERM recebido, parando...');
    stopAllWorkers();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[Workers] SIGINT recebido, parando...');
    stopAllWorkers();
    process.exit(0);
});
