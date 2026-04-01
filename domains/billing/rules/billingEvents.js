// back/domains/billing/rules/billingEvents.js
/**
 * Insurance/Billing Domain Events
 * 
 * Eventos extraídos das regras de negócio do domínio Billing.
 * 
 * @see ./insuranceRules.js - Regras associadas
 */

// ============================================
// BATCH EVENTS
// ============================================

/**
 * Event: INSURANCE_BATCH_CREATED
 * 
 * Disparado quando um novo lote de faturamento é criado.
 * Fonte: insuranceController.js, convenioIntegrationService.js
 * 
 * Consumers:
 * - billingOrchestratorWorker (processa o lote)
 * - analytics (métricas de faturamento)
 */
export const INSURANCE_BATCH_CREATED = {
  type: 'INSURANCE_BATCH_CREATED',
  version: '1.0',
  description: 'Novo lote de faturamento criado',
  source: 'insuranceController.createBatchHandler',
  rules: ['RN-BILLING-006'],
  
  payloadSchema: {
    batchId: { type: 'string', required: true },
    batchNumber: { type: 'string', required: true },
    insuranceProvider: { type: 'string', required: true },
    insuranceProviderCode: { type: 'string', required: true },
    startDate: { type: 'date', required: true },
    endDate: { type: 'date', required: true },
    totalItems: { type: 'number', required: true },
    totalGross: { type: 'number', required: true },
    items: {
      type: 'array',
      required: true,
      itemSchema: {
        referenceId: { type: 'string' },
        referenceType: { type: 'string', enum: ['session', 'appointment'] },
        patientId: { type: 'string' },
        serviceDate: { type: 'date' },
        grossAmount: { type: 'number' }
      }
    }
  },
  
  consumers: ['billingOrchestratorWorker', 'analyticsWorker']
};

/**
 * Event: INSURANCE_BATCH_SEALED
 * 
 * Disparado quando o lote é fechado e pronto para envio.
 * Fonte: billingOrchestratorWorker.js
 */
export const INSURANCE_BATCH_SEALED = {
  type: 'INSURANCE_BATCH_SEALED',
  version: '1.0',
  description: 'Lote fechado e pronto para envio à operadora',
  source: 'billingOrchestratorWorker.handleBatchSealed',
  rules: ['RN-BILLING-002'],
  
  payloadSchema: {
    batchId: { type: 'string', required: true },
    batchNumber: { type: 'string', required: true },
    sealedAt: { type: 'datetime', required: true },
    xmlContent: { type: 'string', required: true },
    xmlHash: { type: 'string', required: true },
    totalItems: { type: 'number', required: true },
    totalGross: { type: 'number', required: true }
  },
  
  consumers: ['providerGatewayWorker', 'notificationWorker']
};

/**
 * Event: INSURANCE_BATCH_SENT
 * 
 * Disparado quando o lote é enviado para a operadora.
 */
export const INSURANCE_BATCH_SENT = {
  type: 'INSURANCE_BATCH_SENT',
  version: '1.0',
  description: 'Lote enviado para operadora',
  source: 'insuranceDomain.sendBatchToProvider',
  rules: ['RN-BILLING-002'],
  
  payloadSchema: {
    batchId: { type: 'string', required: true },
    batchNumber: { type: 'string', required: true },
    sentAt: { type: 'datetime', required: true },
    protocolNumber: { type: 'string', required: false },
    providerResponse: { type: 'object', required: false }
  },
  
  consumers: ['trackingWorker']
};

// ============================================
// ITEM EVENTS
// ============================================

/**
 * Event: INSURANCE_ITEM_CREATED
 * 
 * Disparado quando um item é adicionado ao faturamento.
 * Fonte: SessionCompletedAdapter (via billingOrchestratorWorker)
 */
export const INSURANCE_ITEM_CREATED = {
  type: 'INSURANCE_ITEM_CREATED',
  version: '1.0',
  description: 'Item de faturamento criado a partir de sessão',
  source: 'billingOrchestratorWorker.handleSessionCompleted',
  rules: ['RN-BILLING-001', 'RN-BILLING-005'],
  
  payloadSchema: {
    itemId: { type: 'string', required: true },
    batchId: { type: 'string', required: false }, // Null até ser adicionado a lote
    referenceType: { type: 'string', enum: ['session', 'appointment'], required: true },
    referenceId: { type: 'string', required: true },
    patientId: { type: 'string', required: true },
    doctorId: { type: 'string', required: true },
    specialty: { type: 'string', required: true },
    serviceDate: { type: 'date', required: true },
    insuranceProvider: { type: 'string', required: true },
    procedureCode: { type: 'string', required: false },
    grossAmount: { type: 'number', required: true },
    guideId: { type: 'string', required: false }
  },
  
  consumers: ['batchAssemblerWorker']
};

/**
 * Event: INSURANCE_ITEM_APPROVED
 * 
 * Disparado quando operadora aprova o item.
 */
export const INSURANCE_ITEM_APPROVED = {
  type: 'INSURANCE_ITEM_APPROVED',
  version: '1.0',
  description: 'Item aprovado pela operadora',
  source: 'billingOrchestratorWorker.handleItemApproved',
  rules: ['RN-BILLING-005'],
  
  payloadSchema: {
    itemId: { type: 'string', required: true },
    batchId: { type: 'string', required: true },
    approvedAt: { type: 'datetime', required: true },
    approvedAmount: { type: 'number', required: true },
    glosaAmount: { type: 'number', default: 0 },
    glosaReason: { type: 'string', required: false }
  },
  
  consumers: ['financialWorker', 'notificationWorker']
};

/**
 * Event: INSURANCE_ITEM_REJECTED
 * 
 * Disparado quando operadora rejeita o item.
 */
export const INSURANCE_ITEM_REJECTED = {
  type: 'INSURANCE_ITEM_REJECTED',
  version: '1.0',
  description: 'Item rejeitado pela operadora',
  source: 'billingOrchestratorWorker.handleItemRejected',
  rules: ['RN-BILLING-005'],
  
  payloadSchema: {
    itemId: { type: 'string', required: true },
    batchId: { type: 'string', required: true },
    rejectedAt: { type: 'datetime', required: true },
    rejectionCode: { type: 'string', required: true },
    rejectionReason: { type: 'string', required: true },
    suggestedAction: { type: 'string', enum: ['fix_resubmit', 'charge_patient', 'write_off'] }
  },
  
  consumers: ['glosaWorker', 'notificationWorker']
};

// ============================================
// PAYMENT EVENTS
// ============================================

/**
 * Event: INSURANCE_PAYMENT_RECEIVED
 * 
 * Disparado quando o pagamento do convênio é recebido.
 */
export const INSURANCE_PAYMENT_RECEIVED = {
  type: 'INSURANCE_PAYMENT_RECEIVED',
  version: '1.0',
  description: 'Pagamento recebido da operadora',
  source: 'billingOrchestratorWorker.handlePaymentReceived',
  rules: ['RN-BILLING-005'],
  
  payloadSchema: {
    batchId: { type: 'string', required: true },
    paymentId: { type: 'string', required: true },
    receivedAt: { type: 'datetime', required: true },
    totalAmount: { type: 'number', required: true },
    bankAccount: { type: 'string', required: false },
    items: {
      type: 'array',
      required: true,
      itemSchema: {
        itemId: { type: 'string' },
        paidAmount: { type: 'number' },
        glosaAmount: { type: number }
      }
    }
  },
  
  consumers: ['financialWorker', 'reconciliationWorker']
};

/**
 * Event: INSURANCE_GLOSA_DETECTED
 * 
 * Disparado quando há divergência entre valor esperado e pago.
 */
export const INSURANCE_GLOSA_DETECTED = {
  type: 'INSURANCE_GLOSA_DETECTED',
  version: '1.0',
  description: 'Glosa detectada no pagamento',
  source: 'reconciliationWorker',
  
  payloadSchema: {
    itemId: { type: 'string', required: true },
    expectedAmount: { type: 'number', required: true },
    paidAmount: { type: 'number', required: true },
    glosaAmount: { type: 'number', required: true },
    glosaType: { type: 'string', enum: ['procedimento', 'quantidade', 'valor', 'carater'] },
    detectedAt: { type: 'datetime', required: true }
  },
  
  consumers: ['glosaWorker', 'notificationWorker']
};

// ============================================
// GUIDE EVENTS
// ============================================

/**
 * Event: INSURANCE_GUIDE_CREATED
 * 
 * Disparado quando uma guia TISS é criada.
 * Fonte: convenioIntegrationService.js
 */
export const INSURANCE_GUIDE_CREATED = {
  type: 'INSURANCE_GUIDE_CREATED',
  version: '1.0',
  description: 'Guia TISS criada',
  source: 'convenioIntegrationService.findOrCreateGuideForSession',
  rules: ['RN-BILLING-004'],
  
  payloadSchema: {
    guideId: { type: 'string', required: true },
    guideNumber: { type: 'string', required: true },
    patientId: { type: 'string', required: true },
    specialty: { type: 'string', required: true },
    totalSessions: { type: 'number', required: true },
    status: { type: 'string', enum: ['active', 'partial', 'exhausted'] },
    expiresAt: { type: 'date', required: true },
    isTemporary: { type: 'boolean', default: false }
  },
  
  consumers: ['guideTrackingWorker']
};

/**
 * Event: INSURANCE_GUIDE_SESSION_USED
 * 
 * Disparado quando uma sessão consome crédito da guia.
 */
export const INSURANCE_GUIDE_SESSION_USED = {
  type: 'INSURANCE_GUIDE_SESSION_USED',
  version: '1.0',
  description: 'Sessão utilizada na guia',
  source: 'billingOrchestratorWorker',
  rules: ['RN-BILLING-004'],
  
  payloadSchema: {
    guideId: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    usedAt: { type: 'datetime', required: true },
    remainingSessions: { type: 'number', required: true }
  },
  
  consumers: ['guideTrackingWorker']
};

// ============================================
// EXPORTS
// ============================================

export const BillingEvents = {
  // Batch
  INSURANCE_BATCH_CREATED,
  INSURANCE_BATCH_SEALED,
  INSURANCE_BATCH_SENT,
  
  // Item
  INSURANCE_ITEM_CREATED,
  INSURANCE_ITEM_APPROVED,
  INSURANCE_ITEM_REJECTED,
  
  // Payment
  INSURANCE_PAYMENT_RECEIVED,
  INSURANCE_GLOSA_DETECTED,
  
  // Guide
  INSURANCE_GUIDE_CREATED,
  INSURANCE_GUIDE_SESSION_USED
};

export const BillingEventTypes = Object.keys(BillingEvents);

export default BillingEvents;
