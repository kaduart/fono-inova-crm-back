/**
 * Decision Module - Exports centralizados do sistema de decisão
 * 
 * Este módulo consolida 8 camadas de decisão em 2 níveis:
 * - Level 1: Domain Selection (qual domínio/intenção vence)
 * - Level 2: Action Decision (RULE / HYBRID / AI)
 * 
 * Integração com RNs:
 * - BusinessRulesAdapter: Aplica constraints, modifiers e context
 */

export {
  resolveDecision,
  extractDetectorResults,
  isAmbiguousDecision,
  getResolverStats,
  DOMAIN_CONFIG
} from './DecisionResolver.js';

export {
  applyBusinessRules,
  enrichInputWithBusinessRules,
  HARD_CONSTRAINTS,
  SCORE_MODIFIERS,
  CONTEXT_PROVIDERS
} from './BusinessRulesAdapter.js';

// NOTA: Não exportamos responseHandlers - usamos ResponseBuilder.js existente

export { logDecision } from './decisionLogger.js';

export { default } from './DecisionResolver.js';
