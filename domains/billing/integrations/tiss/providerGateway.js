// insurance/integrations/tiss/providerGateway.js
/**
 * Provider Gateway
 * 
 * Exporta as funções de integração com operadoras de saúde.
 * Re-exporta do tissGenerator para manter compatibilidade.
 */

export { 
    sendToInsuranceProvider, 
    simulateProviderResponse 
} from './tissGenerator.js';
