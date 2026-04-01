// back/domains/clinical/events/clinicalEvents.js
/**
 * Clinical Domain Events - SIMPLIFICADO
 * 
 * Eventos do domínio clínico, baseados nas regras de negócio.
 * APENAS eventos com consumidores definidos.
 * 
 * VERSÃO SIMPLIFICADA: 7 eventos (de 13)
 * Removidos: PATIENT_UPDATED, SESSION_NO_SHOW, APPOINTMENT_CONFIRMED
 * 
 * @see ../rules/ - Regras de negócio associadas
 * @see ../workers/ - Consumidores dos eventos
 */

// ============================================
// PATIENT EVENTS (2 eventos)
// ============================================

/**
 * Event: PATIENT_REGISTERED
 * 
 * Disparado quando um novo paciente é criado.
 * Fonte: RN-PATIENT-002 (leadController.js)
 * 
 * Consumers:
 * - billingWorker: criar conta a receber inicial
 * - analyticsWorker: métricas de conversão
 * - whatsappWorker: mensagem de boas-vindas
 */
export const PATIENT_REGISTERED = {
  type: 'PATIENT_REGISTERED',
  version: '1.0',
  priority: 'high',
  ttl: 86400, // 24h
  
  payloadSchema: {
    patientId: { type: 'string', required: true },
    fullName: { type: 'string', required: true },
    phone: { type: 'string', required: true },
    email: { type: 'string', required: false },
    dateOfBirth: { type: 'date', required: false },
    specialties: { type: 'array', required: false },
    healthPlan: { type: 'object', required: false },
    createdAt: { type: 'datetime', required: true },
    convertedFromLead: { type: 'boolean', default: false }
  },
  
  consumers: ['billingWorker', 'analyticsWorker', 'whatsappWorker']
};

/**
 * Event: PATIENT_PHONE_CHANGED
 * 
 * Disparado quando o telefone do paciente é alterado.
 * Fonte: RN-PATIENT-001 (whatsappController.js)
 * 
 * Consumers:
 * - whatsappWorker: atualizar vínculo do lead
 */
export const PATIENT_PHONE_CHANGED = {
  type: 'PATIENT_PHONE_CHANGED',
  version: '1.0',
  priority: 'high',
  ttl: 3600, // 1h
  
  payloadSchema: {
    patientId: { type: 'string', required: true },
    oldPhone: { type: 'string', required: true },
    newPhone: { type: 'string', required: true },
    changedAt: { type: 'datetime', required: true }
  },
  
  consumers: ['whatsappWorker']
};

// ============================================
// SESSION EVENTS (2 eventos)
// ============================================

/**
 * Event: SESSION_COMPLETED
 * 
 * ⚠️ EVENTO CRÍTICO - Aciona faturamento
 * 
 * Disparado quando uma sessão é finalizada.
 * Fonte: RN-SESSION-004 (sessionController.js)
 * 
 * Consumers:
 * - billingWorker: ⚠️ CRÍTICO - SessionCompletedAdapter
 * - packageWorker: consumir crédito do pacote
 * - analyticsWorker: métricas de produção
 */
export const SESSION_COMPLETED = {
  type: 'SESSION_COMPLETED',
  version: '1.0',
  priority: 'critical',
  ttl: 259200, // 72h
  
  payloadSchema: {
    sessionId: { type: 'string', required: true },
    appointmentId: { type: 'string', required: false },
    patientId: { type: 'string', required: true },
    doctorId: { type: 'string', required: true },
    date: { type: 'date', required: true },
    specialty: { type: 'string', required: true },
    completedAt: { type: 'datetime', required: true },
    
    // ⚠️ Dados obrigatórios para Billing (Adapter validation)
    paymentType: { 
      type: 'string', 
      required: true, 
      enum: ['convenio', 'particular', 'liminar', 'package'],
      description: 'Tipo de pagamento - convenio trigger billing'
    },
    packageType: { 
      type: 'string', 
      required: false, 
      enum: ['convenio', 'particular'],
      description: 'Se pacote, indica tipo para billing'
    },
    procedureCode: { 
      type: 'string', 
      required: false,
      description: 'Código do procedimento (TISS)'
    },
    
    // Dados de billing (RN-BILLING-001)
    billing: {
      addToBalance: { type: 'boolean', default: false },
      balanceAmount: { type: 'number', default: 0 },
      balanceDescription: { type: 'string', required: false }
    },
    
    // Dados do paciente para billing
    patientData: {
      fullName: { type: 'string' },
      healthPlan: { type: 'object' },
      insuranceProvider: { type: 'string' }
    }
  },
  
  consumers: ['billingWorker', 'packageWorker', 'analyticsWorker']
};

/**
 * Event: SESSION_CANCELLED
 * 
 * Disparado quando uma sessão é cancelada.
 * Fonte: RN-SESSION-005
 * 
 * Consumers:
 * - calendarWorker: liberar slot
 * - packageWorker: restaurar crédito (se aplicável)
 */
export const SESSION_CANCELLED = {
  type: 'SESSION_CANCELLED',
  version: '1.0',
  priority: 'medium',
  ttl: 86400,
  
  payloadSchema: {
    sessionId: { type: 'string', required: true },
    appointmentId: { type: 'string', required: false },
    patientId: { type: 'string', required: true },
    doctorId: { type: 'string', required: true },
    date: { type: 'date', required: true },
    reason: { type: 'string', required: false },
    cancelledBy: { type: 'string', required: true },
    cancelledAt: { type: 'datetime', required: true }
  },
  
  consumers: ['calendarWorker', 'packageWorker']
};

// ============================================
// APPOINTMENT EVENTS (3 eventos)
// ============================================

/**
 * Event: APPOINTMENT_SCHEDULED
 * 
 * Disparado quando uma consulta é agendada.
 * Fonte: RN-APPOINTMENT-001, RN-APPOINTMENT-002
 * 
 * Consumers:
 * - orchestratorWorker: ⚠️ decide criar SESSION
 * - calendarWorker: bloquear slot
 * - notificationWorker: lembrete
 */
export const APPOINTMENT_SCHEDULED = {
  type: 'APPOINTMENT_SCHEDULED',
  version: '1.0',
  priority: 'high',
  ttl: 86400,
  
  payloadSchema: {
    appointmentId: { type: 'string', required: true },
    patientId: { type: 'string', required: true },
    doctorId: { type: 'string', required: true },
    date: { type: 'date', required: true },
    time: { type: 'string', required: true },
    specialty: { type: 'string', required: true },
    serviceType: { type: 'string', required: true },
    
    // Vínculos
    packageId: { type: 'string', required: false },
    insuranceGuideId: { type: 'string', required: false },
    
    // Status (RN-APPOINTMENT-002 determina paymentStatus)
    paymentStatus: { type: 'string', required: true },
    notes: { type: 'string', required: false }
  },
  
  consumers: ['orchestratorWorker', 'calendarWorker', 'notificationWorker']
};

/**
 * Event: APPOINTMENT_RESCHEDULED
 * 
 * Disparado quando consulta é remarcada.
 * Fonte: RN-APPOINTMENT-007
 * 
 * Consumers:
 * - orchestratorWorker: atualizar SESSION vinculada
 * - calendarWorker: mover slot
 * - notificationWorker: notificar mudança
 */
export const APPOINTMENT_RESCHEDULED = {
  type: 'APPOINTMENT_RESCHEDULED',
  version: '1.0',
  priority: 'high',
  ttl: 86400,
  
  payloadSchema: {
    appointmentId: { type: 'string', required: true },
    patientId: { type: 'string', required: true },
    doctorId: { type: 'string', required: true },
    previousDate: { type: 'date', required: true },
    previousTime: { type: 'string', required: true },
    newDate: { type: 'date', required: true },
    newTime: { type: 'string', required: true },
    reason: { type: 'string', required: false },
    rescheduledAt: { type: 'datetime', required: true }
  },
  
  consumers: ['orchestratorWorker', 'calendarWorker', 'notificationWorker']
};

/**
 * Event: APPOINTMENT_CANCELLED
 * 
 * Disparado quando consulta é cancelada.
 * Fonte: RN-APPOINTMENT-006
 * 
 * Consumers:
 * - orchestratorWorker: cancelar SESSION vinculada
 * - calendarWorker: liberar slot
 * - packageWorker: restaurar crédito
 */
export const APPOINTMENT_CANCELLED = {
  type: 'APPOINTMENT_CANCELLED',
  version: '1.0',
  priority: 'high',
  ttl: 86400,
  
  payloadSchema: {
    appointmentId: { type: 'string', required: true },
    patientId: { type: 'string', required: true },
    doctorId: { type: 'string', required: true },
    date: { type: 'date', required: true },
    time: { type: 'string', required: true },
    reason: { type: 'string', required: false },
    notifyPatient: { type: 'boolean', default: true },
    cancelledBy: { type: 'string', required: true },
    cancelledAt: { type: 'datetime', required: true }
  },
  
  consumers: ['orchestratorWorker', 'calendarWorker', 'packageWorker']
};

// ============================================
// EXPORTS
// ============================================

export const ClinicalEvents = {
  // Patient
  PATIENT_REGISTERED,
  PATIENT_PHONE_CHANGED,
  
  // Session
  SESSION_COMPLETED,
  SESSION_CANCELLED,
  
  // Appointment
  APPOINTMENT_SCHEDULED,
  APPOINTMENT_RESCHEDULED,
  APPOINTMENT_CANCELLED
};

// Tipos para validação
export const ClinicalEventTypes = Object.keys(ClinicalEvents);

// Mapeamento Evento → Regra
export const EventToRuleMap = {
  'PATIENT_REGISTERED': ['RN-PATIENT-002', 'RN-PATIENT-004'],
  'PATIENT_PHONE_CHANGED': ['RN-PATIENT-001'],
  'SESSION_COMPLETED': ['RN-SESSION-004', 'RN-APPOINTMENT-005'],
  'SESSION_CANCELLED': ['RN-SESSION-005'],
  'APPOINTMENT_SCHEDULED': ['RN-APPOINTMENT-001', 'RN-APPOINTMENT-002'],
  'APPOINTMENT_RESCHEDULED': ['RN-APPOINTMENT-007'],
  'APPOINTMENT_CANCELLED': ['RN-APPOINTMENT-006']
};

export default ClinicalEvents;
