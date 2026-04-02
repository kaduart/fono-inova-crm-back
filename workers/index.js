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
import { startDailyClosingWorker } from './dailyClosingWorker.js';
import { startTotalsWorker } from './totalsWorker.js';
import { startPreAgendamentoWorker } from './preAgendamentoWorker.js';
// 🆕 Patients V2 Workers
import { patientWorker } from '../domains/clinical/workers/patientWorker.js';
import { patientProjectionWorker } from '../domains/clinical/workers/patientProjectionWorker.js';
// 🆕 Packages V2 Workers
import { packageProjectionWorker } from '../domains/billing/workers/packageProjectionWorker.js';
import { packageProcessingWorker } from '../domains/billing/workers/packageProcessingWorker.js';
// 🆕 Clinical V2 Workers
import { startClinicalOrchestratorWorker } from '../domains/clinical/workers/clinicalOrchestrator.js';
import { startSessionWorker } from '../domains/clinical/workers/sessionWorker.js';

/**
 * Inicializa todos os workers da aplicação
 * 
 * Ordem de inicialização:
 * 1. Workers de domínio (independentes)
 * 2. Workers orquestradores (dependem de outros)
 */

const workers = [];

export function startAllWorkers() {
    console.log('[Workers] Iniciando workers...\n');

    // 1. Workers de domínio base
    workers.push(startPaymentWorker());
    workers.push(startBalanceWorker());
    workers.push(startPackageValidationWorker());
    
    // 2. Workers de agendamento
    workers.push(startAppointmentWorker());
    workers.push(startCreateAppointmentWorker());
    
    // 3. Workers orquestradores (novos - 4.0 completa)
    workers.push(startCancelOrchestratorWorker());
    workers.push(startCompleteOrchestratorWorker());
    
    // 4. Workers financeiros
    workers.push(startInvoiceWorker());
    workers.push(startDailyClosingWorker());
    workers.push(startTotalsWorker());
    workers.push(startPreAgendamentoWorker());
    
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
