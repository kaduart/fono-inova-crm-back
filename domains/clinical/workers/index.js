// back/domains/clinical/workers/index.js
/**
 * Clinical Workers Index
 * 
 * Exporta todos os workers do domínio clínico:
 * - ClinicalOrchestrator: Orquestração de appointments/sessions
 * - SessionWorker: Side effects de eventos de sessão
 * 
 * @see clinicalOrchestrator.js - Orquestrador principal
 * @see sessionWorker.js - Worker de sessões
 */

export { createClinicalOrchestrator, OrchestratorRules } from './clinicalOrchestrator.js';
export { createSessionWorker, SessionWorkerRules } from './sessionWorker.js';
