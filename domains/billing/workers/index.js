// back/domains/billing/workers/index.js
/**
 * Billing Workers Index
 * 
 * Workers do domínio Billing - Arquitetura Event-Driven
 * 
 * ESTRUTURA (pós-análise documento-analise.txt):
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    BILLING DOMAIN                            │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                              │
 * │  insuranceOrchestratorWorker.js                             │
 * │  ├── Consome: Eventos de Insurance (batches, glosas)        │
 * │  └── Responsabilidade: Orquestrar fluxo de convênio         │
 * │                                                              │
 * │  packageProcessingWorker.js                                 │
 * │  └── Processamento de pacotes de sessões                    │
 * │                                                              │
 * │  packageProjectionWorker.js                                 │
 * │  └── Projeção de pacotes (CQRS)                             │
 * │                                                              │
 * └─────────────────────────────────────────────────────────────┘
 * 
 * NOTA: O fluxo de billing principal (invoice, payment) está no 
 * completeOrchestratorWorker.js na pasta /workers (raiz).
 */

export { startInsuranceOrchestratorWorker } from './insuranceOrchestratorWorker.js';
export { packageProcessingWorker } from './packageProcessingWorker.js';
export { packageProjectionWorker } from './packageProjectionWorker.js';

// TODO: Implementar TISS Worker
// export { startTissWorker } from './tissWorker.js';
