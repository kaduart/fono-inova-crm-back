// back/domains/clinical/rules/appointmentRules.js
/**
 * Appointment Domain Rules
 * 
 * Regras de negócio extraídas dos services:
 * - createAppointmentService.js (RN-008)
 * - appointmentCompleteService.js (RN-007)
 */

/**
 * RN-APPOINTMENT-001: Validação de Criação de Agendamento
 * Fonte: createAppointmentService.js
 * 
 * Regra: Campos obrigatórios para criar agendamento
 */
export const AppointmentValidationRules = {
  requiredFields: {
    patientId: {
      rule: 'valid_objectid',
      message: 'PACIENTE_OBRIGATORIO'
    },
    doctorId: {
      rule: 'valid_objectid',
      message: 'PROFISSIONAL_OBRIGATORIO'
    },
    date: {
      rule: 'valid_date_format',
      message: 'DATA_INVALIDA'
    },
    time: {
      rule: 'valid_time_format',
      message: 'HORARIO_INVALIDO'
    }
  },
  
  optionalFields: {
    specialty: {
      default: 'fonoaudiologia'
    },
    serviceType: {
      default: 'session',
      options: ['session', 'evaluation', 'package_session']
    },
    packageId: {
      condition: 'if_package_session'
    },
    insuranceGuideId: {
      condition: 'if_convenio'
    },
    amount: {
      default: 0
    }
  }
};

/**
 * RN-APPOINTMENT-002: Determinação de Status de Pagamento Inicial
 * Fonte: createAppointmentService.js
 * 
 * Regra: Status inicial de pagamento depende do tipo de serviço:
 * - Convênio (insuranceGuideId) → pending_receipt
 * - Pacote (package_session) → package_paid (já pago)
 * - Valor zero → pending
 * - Outros → pending
 */
export const InitialPaymentStatusRules = {
  rules: [
    {
      priority: 1,
      condition: { insuranceGuideId: { $exists: true } },
      result: 'pending_receipt',
      description: 'Convênio - aguardando recebimento do plano'
    },
    {
      priority: 2,
      condition: { serviceType: 'package_session' },
      result: 'package_paid',
      description: 'Pacote - usando crédito existente'
    },
    {
      priority: 3,
      condition: { amount: 0 },
      result: 'pending',
      description: 'Sem valor definido - aguarda pagamento'
    },
    {
      priority: 4,
      default: true,
      result: 'pending',
      description: 'Padrão - aguarda confirmação'
    }
  ]
};

/**
 * RN-APPOINTMENT-003: Status Operacional
 * 
 * Regra: Status da agenda (operacional)
 */
export const OperationalStatusRules = {
  statuses: {
    pending: 'Aguardando confirmação',
    scheduled: 'Agendado',
    confirmed: 'Confirmado pelo paciente',
    completed: 'Realizado',
    cancelled: 'Cancelado',
    rescheduled: 'Remarcado'
  },
  
  initialStatus: 'pending',
  
  transitions: {
    pending: ['scheduled', 'confirmed', 'cancelled'],
    scheduled: ['confirmed', 'completed', 'cancelled', 'rescheduled'],
    confirmed: ['completed', 'cancelled', 'rescheduled'],
    completed: [], // Terminal
    cancelled: [], // Terminal
    rescheduled: ['scheduled', 'confirmed', 'cancelled']
  }
};

/**
 * RN-APPOINTMENT-004: Status Clínico
 * 
 * Regra: Status do atendimento médico
 */
export const ClinicalStatusRules = {
  statuses: {
    pending: 'Pendente',
    in_progress: 'Em atendimento',
    completed: 'Atendimento finalizado',
    cancelled: 'Cancelado'
  },
  
  initialStatus: 'pending',
  
  transitions: {
    pending: ['in_progress', 'completed', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: [], // Terminal
    cancelled: []  // Terminal
  }
};

/**
 * RN-APPOINTMENT-005: Completamento de Agendamento
 * Fonte: appointmentCompleteService.js
 * 
 * Regra: Ao completar:
 * 1. Verificar idempotência
 * 2. Atualizar session vinculada
 * 3. Atualizar package (se houver)
 * 4. Criar/atualizar payment
 * 5. Atualizar patientBalance (se addToBalance)
 */
export const AppointmentCompletionRules = {
  idempotency: {
    checkField: 'clinicalStatus',
    expectedValue: 'completed',
    onDuplicate: {
      status: 'already_completed',
      message: 'Agendamento já foi completado anteriormente'
    }
  },
  
  sideEffects: {
    updateSession: {
      status: 'completed',
      completedAt: 'now',
      sessionConsumed: true
    },
    
    updatePackage: {
      condition: 'if_package_exists',
      action: 'decrement_session_count'
    },
    
    createPayment: {
      condition: 'if_not_convenio_and_not_package',
      fields: ['amount', 'paymentMethod', 'patient', 'doctor']
    },
    
    updatePatientBalance: {
      condition: 'if_addToBalance_true',
      action: 'add_balanceAmount'
    }
  },
  
  event: {
    type: 'APPOINTMENT_COMPLETED',
    payload: {
      appointmentId: true,
      patientId: true,
      doctorId: true,
      completedAt: true,
      sideEffects: true
    }
  }
};

/**
 * RN-APPOINTMENT-006: Cancelamento
 * 
 * Regra: Ao cancelar, liberar recursos
 */
export const AppointmentCancellationRules = {
  fieldsToUpdate: {
    operationalStatus: 'cancelled',
    clinicalStatus: 'cancelled',
    cancelledAt: 'now',
    cancelReason: 'required',
    updatedAt: 'now'
  },
  
  sideEffects: {
    releaseSlot: true, // Libera horário na agenda
    notifyPatient: 'optional', // Configurável
    
    restorePackage: {
      condition: 'if_session_consumed',
      action: 'restore_session_credit'
    }
  },
  
  validations: {
    preventCancelIfPaid: {
      condition: { paymentStatus: 'paid' },
      action: 'require_refund_first'
    }
  }
};

/**
 * RN-APPOINTMENT-007: Remarcação
 * 
 * Regra: Alterar data/hora mantendo vínculos
 */
export const AppointmentRescheduleRules = {
  preservedFields: [
    'patient',
    'doctor', 
    'specialty',
    'serviceType',
    'package',
    'payment'
  ],
  
  updatedFields: {
    date: 'new_date',
    time: 'new_time',
    operationalStatus: 'rescheduled',
    rescheduledAt: 'now',
    previousDate: 'old_date',
    previousTime: 'old_time'
  },
  
  history: {
    action: 'appointment_rescheduled',
    logPreviousAndNew: true,
    reason: 'optional'
  }
};

/**
 * RN-APPOINTMENT-008: Busca e Listagem
 * 
 * Regra: Padrões de consulta
 */
export const AppointmentQueryRules = {
  byPatient: {
    defaultSort: { date: -1, time: -1 }, // Mais recentes primeiro
    populate: ['doctor', 'package']
  },
  
  byDoctor: {
    defaultSort: { date: 1, time: 1 }, // Próximos primeiro
    populate: ['patient']
  },
  
  nextAppointment: {
    filter: {
      date: { $gte: 'today' },
      operationalStatus: { $nin: ['cancelled', 'completed'] }
    },
    sort: { date: 1, time: 1 },
    limit: 1
  }
};

// Exporta todas as regras
export const AppointmentRules = {
  validation: AppointmentValidationRules,
  initialPaymentStatus: InitialPaymentStatusRules,
  operationalStatus: OperationalStatusRules,
  clinicalStatus: ClinicalStatusRules,
  completion: AppointmentCompletionRules,
  cancellation: AppointmentCancellationRules,
  reschedule: AppointmentRescheduleRules,
  query: AppointmentQueryRules
};

export default AppointmentRules;
