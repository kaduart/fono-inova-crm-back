// back/domains/whatsapp/rules/index.js
/**
 * WhatsApp Domain Rules - Entry Point
 * 
 * Exporta todas as regras de negócio do domínio WhatsApp.
 * 
 * @see ./whatsappRules.js - Regras principais
 */

export { 
  WhatsAppRules,
  WhatsAppLockRules,
  WhatsAppBufferRules,
  WhatsAppIdempotencyRules,
  WhatsAppDebounceRules,
  WhatsAppLeadReloadRules,
  WhatsAppManualControlRules,
  WhatsAppAutoResumeRules,
  WhatsAppGlobalFlagRules,
  WhatsAppContextWindowRules,
  WhatsAppFirstContactRules,
  WhatsAppOrchestratorRules,
  WhatsAppCommandRules,
  WhatsAppFormattingRules,
  WhatsAppPersistenceRules,
  WhatsAppRealtimeRules,
  WhatsAppFeatureFlagRules,
  WhatsAppNotificationEventRules,
  WhatsAppEventPriorityRules,
  WhatsAppCorrelationRules,
  WhatsAppFallbackRules
} from './whatsappRules.js';

// Namespace unificado
import { WhatsAppRules } from './whatsappRules.js';

export const WhatsAppDomain = {
  Rules: WhatsAppRules
};

export default WhatsAppDomain;
