// back/domains/billing/rules/insuranceRules.js
/**
 * Insurance/Billing Domain Rules
 * 
 * Regras de negócio extraídas de:
 * - insuranceDomain.js
 * - SessionCompletedAdapter.js
 * - billingOrchestratorWorker.js
 * - convenioIntegrationService.js
 * - insuranceController.js
 */

// ============================================
// RN-BILLING-001: Adapters - Anti-Corruption Layer
// Fonte: SessionCompletedAdapter.js
// ============================================

/**
 * Regra: Apenas sessões de CONVÊNIO geram faturamento
 * Outros tipos (particular, liminar, etc) são tratados em outros domínios
 */
export const InsuranceAdapterRules = {
  sessionCompleted: {
    // Filtro por tipo de pagamento
    acceptedPaymentTypes: ['convenio'],
    acceptedPackageTypes: ['convenio'],
    
    // Campos obrigatórios
    requiredFields: ['patientId', 'insuranceProvider'],
    
    // Valor da sessão
    sessionValueSource: 'cadastro_do_convenio', // NÃO vem do evento clínico
    
    // Ação se não atender critérios
    onIgnore: 'return_null'
  },
  
  appointmentCompleted: {
    // Mesma lógica de filtro
    acceptedPaymentTypes: ['convenio'],
    requiredFields: ['patientId', 'insuranceProvider']
  }
};

// ============================================
// RN-BILLING-002: Processamento de Lotes
// Fonte: insuranceDomain.js
// ============================================

/**
 * Regra: Validações de lote antes de processar
 */
export const BatchProcessingRules = {
  validations: {
    requiredFields: ['items', 'insuranceProvider', 'startDate', 'endDate'],
    minItems: 1,
    dateRangeMaxDays: 31 // Lote não pode ter mais de 31 dias
  },
  
  // Agrupamento por tipo de guia
  grouping: {
    enabled: true,
    field: 'guideType'
  },
  
  // Geração de XML TISS
  xmlGeneration: {
    required: true,
    onError: 'fail_batch'
  },
  
  // Envio para operadora
  providerSend: {
    retryAttempts: 3,
    timeoutMs: 30000
  }
};

// ============================================
// RN-BILLING-003: Criação Automática de Lotes
// Fonte: convenioIntegrationService.js
// ============================================

/**
 * Regra: Sessões elegíveis para faturamento
 */
export const AutoBatchCreationRules = {
  // Critérios de seleção
  sessionCriteria: {
    status: 'completed',
    billingStatus: { $in: ['pending', null] },
    packageType: 'convenio'
  },
  
  // Filtro por período
  dateRange: {
    startDate: 'required',
    endDate: 'required',
    maxRangeDays: 31
  },
  
  // Filtro por convênio
  convenioFilter: {
    optional: true,
    field: 'package.insuranceProvider'
  },
  
  // Cálculo de valores
  valueCalculation: {
    source: 'Convenio.sessionValue',
    formula: 'sessionValue * numberOfSessions'
  },
  
  // Atualização de sessões
  sessionUpdate: {
    setBillingStatus: 'in_batch',
    setBatchId: true
  }
};

// ============================================
// RN-BILLING-004: Gestão de Guias
// Fonte: convenioIntegrationService.js
// ============================================

/**
 * Regra: Criação e vinculação de guias TISS
 */
export const InsuranceGuideRules = {
  // Busca de guia ativa
  activeGuideCriteria: {
    patientId: 'required',
    specialty: 'required',
    status: { $in: ['active', 'partial'] },
    notExpired: true
  },
  
  // Criação automática se não existir
  autoCreate: {
    enabled: true,
    tempNumberPrefix: 'TEMP-',
    defaultTotalSessions: 10,
    defaultValidityDays: 90
  },
  
  // Especialidade padrão
  defaultSpecialty: 'fonoaudiologia'
};

// ============================================
// RN-BILLING-005: Workers e Eventos
// Fonte: billingOrchestratorWorker.js
// ============================================

/**
 * Regra: Eventos consumidos pelo Billing
 */
export const BillingWorkerRules = {
  // Eventos do domínio Clinical (via ACL)
  clinicalEvents: {
    SESSION_COMPLETED: {
      handler: 'handleSessionCompleted',
      adapter: 'SessionCompletedAdapter'
    },
    APPOINTMENT_COMPLETED: {
      handler: 'handleAppointmentCompleted',
      adapter: 'SessionCompletedAdapter'
    }
  },
  
  // Eventos internos do Billing
  internalEvents: {
    INSURANCE_BATCH_CREATED: {
      handler: 'handleBatchCreated'
    },
    INSURANCE_BATCH_SEALED: {
      handler: 'handleBatchSealed'
    },
    INSURANCE_ITEM_APPROVED: {
      handler: 'handleItemApproved'
    },
    INSURANCE_ITEM_REJECTED: {
      handler: 'handleItemRejected'
    },
    INSURANCE_PAYMENT_RECEIVED: {
      handler: 'handlePaymentReceived'
    },
    INSURANCE_BATCH_REPROCESS_REQUESTED: {
      handler: 'handleReprocessRequested'
    }
  },
  
  // Idempotência
  idempotency: {
    checkField: 'eventId',
    storeIn: 'EventStore',
    statusField: 'status',
    skipIfStatus: 'processed'
  }
};

// ============================================
// RN-BILLING-006: API Controller
// Fonte: insuranceController.js
// ============================================

/**
 * Regra: Validações de API
 */
export const InsuranceApiRules = {
  createBatch: {
    requiredFields: [
      'insuranceProvider',
      'startDate',
      'endDate',
      'items'
    ],
    itemValidation: {
      minItems: 1,
      eachItemMustHave: ['referenceId', 'serviceDate']
    },
    eventPublication: {
      type: 'INSURANCE_BATCH_CREATED',
      includeCorrelationId: true,
      idempotencyKey: 'create_batch_{batchId}'
    }
  }
};

// ============================================
// RN-BILLING-007: Valores e Cobrança
// Fonte: insuranceDomain.js, convenioIntegrationService.js
// ============================================

/**
 * Regra: Cálculo de valores de sessão
 */
export const InsuranceValueRules = {
  // Origem do valor
  valueSource: {
    priority: 'convenio.sessionValue',
    fallback: 0
  },
  
  // Campos de valor em lote
  batchValues: {
    totalGross: 'sum_of_all_sessions',
    totalNet: 'after_deductions',
    calculatedAt: 'batch_creation'
  },
  
  // Status de item
  itemStatus: {
    pending: 'Aguardando processamento',
    processing: 'Em processamento',
    approved: 'Aprovado',
    rejected: 'Rejeitado',
    paid: 'Pago'
  }
};

// ============================================
// EXPORTS
// ============================================

export const InsuranceRules = {
  adapter: InsuranceAdapterRules,
  batchProcessing: BatchProcessingRules,
  autoBatch: AutoBatchCreationRules,
  guide: InsuranceGuideRules,
  worker: BillingWorkerRules,
  api: InsuranceApiRules,
  values: InsuranceValueRules
};

export default InsuranceRules;
