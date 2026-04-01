// back/domains/clinical/rules/sessionRules.js
/**
 * Session Domain Rules
 * 
 * Regras de negócio extraídas dos controllers e services:
 * - doctorController.js (RN-003)
 * - financialDashboardController.js (RN-004)
 * - appointmentCompleteService.js (RN-007)
 */

/**
 * RN-SESSION-001: Filtro de Sessões para Dashboard Médico
 * Fonte: doctorController.js
 * 
 * Regra: Médicos veem apenas suas próprias sessões,
 * ordenadas por data decrescente (mais recentes primeiro)
 */
export const DoctorSessionViewRules = {
  // Sessões são filtradas por doctorId
  filterBy: 'doctor',
  
  // Ordenação padrão
  sort: {
    field: 'date',
    order: 'desc' // Mais recentes primeiro
  },
  
  // População de dados relacionados
  populate: [
    { field: 'patient', select: 'fullName' },
    { field: 'appointment', select: 'date time' }
  ]
};

/**
 * RN-SESSION-002: Cálculo de Produção Financeira
 * Fonte: financialDashboardController.js
 * 
 * Regra: Produção é calculada apenas de sessões com status 'completed'
 * Sessões canceladas NÃO entram no cálculo
 * Categorização por paymentMethod:
 *   - 'convenio' → produção de convênio
 *   - com package → produção de pacotes
 *   - outros → produção particular
 */
export const ProductionCalculationRules = {
  // Apenas sessões completadas contam
  eligibleStatus: ['completed'],
  
  // Sessões excluídas
  excludedStatus: ['cancelled', 'no_show'],
  
  // Categorias de produção
  categories: {
    convenio: {
      condition: { paymentMethod: 'convenio' },
      valueField: 'sessionValue || package.insuranceGrossAmount'
    },
    pacotes: {
      condition: { package: { $exists: true } },
      valueField: 'package.insuranceGrossAmount'
    },
    particular: {
      condition: { paymentMethod: { $ne: 'convenio' }, package: null },
      valueField: 'sessionValue'
    }
  }
};

/**
 * RN-SESSION-003: Cálculo de Valores a Receber
 * Fonte: financialDashboardController.js
 * 
 * Regra: Valores pendentes de recebimento:
 * - Convênio: completadas mas isPaid = false
 * - Particular: completadas mas isPaid = false
 */
export const PendingReceiptRules = {
  convenio: {
    status: 'completed',
    paymentMethod: 'convenio',
    isPaid: { $or: [false, { $exists: false }] }
  },
  
  particular: {
    status: 'completed',
    paymentMethod: { $ne: 'convenio' },
    isPaid: { $or: [false, { $exists: false }] }
  }
};

/**
 * RN-SESSION-004: Completamento de Sessão
 * Fonte: appointmentCompleteService.js
 * 
 * Regra: Ao completar uma sessão:
 * 1. Verificar idempotência (não completar 2x)
 * 2. Atualizar session.status = 'completed'
 * 3. Atualizar session.completedAt
 * 4. Marcar session.sessionConsumed = true
 * 5. Publicar evento SESSION_COMPLETED (consumido pelo billing)
 */
export const SessionCompletionRules = {
  // Idempotência
  idempotency: {
    checkField: 'clinicalStatus',
    expectedValue: 'completed',
    actionIfDuplicate: 'return_already_completed'
  },
  
  // Campos a atualizar
  fieldsToUpdate: {
    status: 'completed',
    completedAt: 'now',
    sessionConsumed: true,
    updatedAt: 'now'
  },
  
  // Efeitos colaterais
  sideEffects: {
    publishEvent: 'SESSION_COMPLETED',
    notifyBilling: true,
    updatePackageCount: true // Se tiver pacote
  },
  
  // Dados do evento
  eventPayload: {
    sessionId: true,
    patientId: true,
    doctorId: true,
    completedAt: true,
    billing: {
      addToBalance: 'optional',
      balanceAmount: 'optional'
    }
  }
};

/**
 * RN-SESSION-005: Validações de Status
 * 
 * Regra: Fluxo de status permitido
 */
export const SessionStatusRules = {
  // Status válidos
  validStatuses: [
    'scheduled',    // Agendada
    'confirmed',    // Confirmada pelo paciente
    'completed',    // Realizada
    'cancelled',    // Cancelada
    'no_show'       // Não compareceu
  ],
  
  // Transições permitidas
  allowedTransitions: {
    scheduled: ['confirmed', 'completed', 'cancelled', 'no_show'],
    confirmed: ['completed', 'cancelled', 'no_show'],
    completed: [], // Terminal
    cancelled: [], // Terminal
    no_show: []    // Terminal
  },
  
  // Quem pode mudar cada status
  permissions: {
    scheduled: ['system', 'receptionist'],
    confirmed: ['patient', 'receptionist'],
    completed: ['doctor', 'receptionist'],
    cancelled: ['patient', 'receptionist', 'system'],
    no_show: ['receptionist', 'system']
  }
};

/**
 * RN-SESSION-006: Criação de Sessão
 * 
 * Regra: Sessão deve ter vínculo obrigatório
 */
export const SessionCreationRules = {
  requiredFields: {
    patient: 'Referência ao paciente',
    doctor: 'Referência ao profissional',
    date: 'Data da sessão (YYYY-MM-DD)',
    time: 'Horário da sessão (HH:MM)'
  },
  
  optionalFields: {
    appointment: 'Referência ao agendamento (se houver)',
    specialty: 'Especialidade (default: fonoaudiologia)',
    notes: 'Observações'
  },
  
  defaultValues: {
    status: 'scheduled',
    sessionConsumed: false
  }
};

// Exporta todas as regras
export const SessionRules = {
  doctorView: DoctorSessionViewRules,
  production: ProductionCalculationRules,
  pendingReceipt: PendingReceiptRules,
  completion: SessionCompletionRules,
  status: SessionStatusRules,
  creation: SessionCreationRules
};

export default SessionRules;
