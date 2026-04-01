// back/domains/billing/rules/index.js
/**
 * Billing Domain Rules & Events - Entry Point
 * 
 * Exporta todas as regras de negócio e eventos do domínio Billing/Insurance.
 */

// Regras de negócio
export { InsuranceRules } from './insuranceRules.js';

// Eventos
export { 
  BillingEvents,
  BillingEventTypes,
  INSURANCE_BATCH_CREATED,
  INSURANCE_BATCH_SEALED,
  INSURANCE_BATCH_SENT,
  INSURANCE_ITEM_CREATED,
  INSURANCE_ITEM_APPROVED,
  INSURANCE_ITEM_REJECTED,
  INSURANCE_PAYMENT_RECEIVED,
  INSURANCE_GLOSA_DETECTED,
  INSURANCE_GUIDE_CREATED,
  INSURANCE_GUIDE_SESSION_USED
} from './billingEvents.js';

// Namespace unificado
import { InsuranceRules } from './insuranceRules.js';
import { BillingEvents } from './billingEvents.js';

export const BillingDomain = {
  Rules: InsuranceRules,
  Events: BillingEvents
};

export default BillingDomain;
