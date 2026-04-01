// utils/apiMessages.js
/**
 * Sistema de Mensagens Padronizadas da API
 * 
 * Todas as mensagens de erro/sucesso centralizadas
 * para manter consistência entre endpoints.
 */

export const Messages = {
  // 🎯 SUCESSO
  SUCCESS: {
    APPOINTMENT_CREATED: 'Agendamento registrado e em processamento',
    APPOINTMENT_CANCELED: 'Agendamento cancelado com sucesso',
    APPOINTMENT_COMPLETED: 'Sessão completada com sucesso',
    PAYMENT_PROCESSED: 'Pagamento processado',
    BALANCE_UPDATED: 'Saldo atualizado',
    REUSE_CREDIT: 'Crédito reaproveitado com sucesso'
  },

  // 🔄 PROCESSAMENTO ASYNC
  PROCESSING: {
    CREATE: 'Agendamento em processamento. Verifique o status em alguns segundos.',
    CANCEL: 'Cancelamento em processamento. Aguarde confirmação.',
    COMPLETE: 'Finalização em processamento. Aguarde confirmação.',
    PAYMENT: 'Pagamento sendo processado.'
  },

  // ❌ ERROS DE VALIDAÇÃO
  VALIDATION: {
    // Campos obrigatórios
    PATIENT_REQUIRED: 'Paciente é obrigatório',
    DOCTOR_REQUIRED: 'Profissional é obrigatório',
    DATE_REQUIRED: 'Data é obrigatória (formato: YYYY-MM-DD)',
    TIME_REQUIRED: 'Horário é obrigatório (formato: HH:MM)',
    REASON_REQUIRED: 'Motivo do cancelamento é obrigatório',
    
    // Formatos
    INVALID_DATE: 'Data inválida. Use o formato YYYY-MM-DD',
    INVALID_TIME: 'Horário inválido. Use o formato HH:MM',
    INVALID_OBJECT_ID: (field) => `${field}: ID inválido`,
    INVALID_AMOUNT: 'Valor deve ser um número positivo',
    
    // Relacionamentos
    PACKAGE_REQUIRED: 'ID do pacote é obrigatório para sessões de pacote',
    SESSION_REQUIRED: 'ID da sessão é obrigatório'
  },

  // ❌ ERROS DE NEGÓCIO
  BUSINESS: {
    // Estados
    ALREADY_CANCELED: 'Este agendamento já foi cancelado',
    ALREADY_COMPLETED: 'Esta sessão já foi completada',
    ALREADY_PROCESSING_CANCEL: 'Cancelamento já está em andamento',
    ALREADY_PROCESSING_COMPLETE: 'Finalização já está em andamento',
    CANNOT_CANCEL_COMPLETED: 'Não é possível cancelar uma sessão já completada',
    CANNOT_COMPLETE_CANCELED: 'Não é possível completar um agendamento cancelado',
    
    // Pacote
    PACKAGE_NOT_FOUND: 'Pacote não encontrado',
    PACKAGE_NO_CREDIT: 'Pacote sem créditos disponíveis',
    PACKAGE_EXHAUSTED: 'Créditos do pacote esgotados',
    
    // Agendamento
    APPOINTMENT_NOT_FOUND: 'Agendamento não encontrado',
    SESSION_NOT_FOUND: 'Sessão não encontrada',
    PAYMENT_NOT_FOUND: 'Pagamento não encontrado',
    
    // Convênio
    INSURANCE_GUIDE_NOT_FOUND: 'Guia de convênio não encontrada',
    INSURANCE_GUIDE_EXHAUSTED: 'Guia de convênio esgotada',
    INSURANCE_GUIDE_INACTIVE: 'Guia de convênio não está ativa',
    
    // Conflitos
    TIME_CONFLICT: 'Já existe um agendamento neste horário',
    DOCTOR_UNAVAILABLE: 'Profissional não disponível neste horário'
  },

  // ❌ ERROS DE SISTEMA
  SYSTEM: {
    INTERNAL_ERROR: 'Erro interno do servidor. Tente novamente em alguns instantes.',
    DATABASE_ERROR: 'Erro ao acessar o banco de dados',
    REDIS_ERROR: 'Erro ao acessar fila de processamento',
    WORKER_ERROR: 'Erro no processamento assíncrono',
    TIMEOUT_ERROR: 'Tempo de processamento excedido. Verifique o status posteriormente.',
    IDEMPOTENCY_ERROR: 'Erro ao verificar idempotência'
  },

  // 🔍 INFO/DEBUG
  INFO: {
    CHECK_STATUS: (url) => `Verifique o status em: ${url}`,
    RETRY_IN: (seconds) => `Tente novamente em ${seconds} segundos`,
    ASYNC_PROCESSING: 'Processamento em andamento',
    IDEMPOTENCY_CACHED: 'Requisição já processada anteriormente'
  }
};

/**
 * Formata mensagem de erro para response padronizada
 */
export function formatError(code, message, details = null) {
  return {
    success: false,
    error: {
      code,
      message,
      details,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Formata mensagem de sucesso
 */
export function formatSuccess(data, meta = {}) {
  return {
    success: true,
    data,
    meta: {
      ...meta,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Códigos de erro padronizados
 */
export const ErrorCodes = {
  // 400 - Bad Request
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_OBJECT_ID: 'INVALID_OBJECT_ID',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  
  // 409 - Conflict
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  ALREADY_PROCESSING: 'ALREADY_PROCESSING',
  CONFLICT_STATE: 'CONFLICT_STATE',
  
  // 404 - Not Found
  NOT_FOUND: 'NOT_FOUND',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  
  // 422 - Unprocessable Entity
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INSUFFICIENT_CREDIT: 'INSUFFICIENT_CREDIT',
  
  // 500 - Internal Server Error
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  WORKER_ERROR: 'WORKER_ERROR'
};
