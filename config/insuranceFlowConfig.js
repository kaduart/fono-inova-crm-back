// back/config/insuranceFlowConfig.js
/**
 * Configuração runtime do InsuranceFlowOrchestrator.
 *
 * Evita depender de env vars (Render) para rollback/ativação em produção.
 * A env `FF_INSURANCE_ORCHESTRATOR` continua sendo o default de bootstrap,
 * mas pode ser sobrescrita em runtime via `setInsuranceFlowOverride()`.
 */

const DEFAULT_FROM_ENV = process.env.FF_INSURANCE_ORCHESTRATOR === 'true';

let runtimeOverride = null;

/**
 * Retorna a configuração atual do fluxo de convênio.
 * O override runtime vence sobre a env var.
 */
export function getInsuranceFlowConfig() {
    return {
        useOrchestrator: runtimeOverride !== null ? runtimeOverride : DEFAULT_FROM_ENV,
    };
}

/**
 * Sobrescreve em runtime a decisão de usar o orquestrador.
 *
 * @param {boolean|null} value
 *   - true  → força uso do orquestrador
 *   - false → força fallback para completeSessionV2
 *   - null  → remove override e volta ao default da env var
 */
export function setInsuranceFlowOverride(value) {
    if (value !== null && typeof value !== 'boolean') {
        throw new TypeError('InsuranceFlow override deve ser boolean ou null');
    }
    runtimeOverride = value;
    console.log(`[insuranceFlowConfig] Override atualizado: ${value} (useOrchestrator=${getInsuranceFlowConfig().useOrchestrator})`);
}

/**
 * Reseta para o comportamento default (env var).
 */
export function resetInsuranceFlowOverride() {
    runtimeOverride = null;
    console.log(`[insuranceFlowConfig] Override resetado (useOrchestrator=${getInsuranceFlowConfig().useOrchestrator})`);
}

export default {
    getInsuranceFlowConfig,
    setInsuranceFlowOverride,
    resetInsuranceFlowOverride,
};
