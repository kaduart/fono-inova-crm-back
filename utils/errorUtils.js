// utils/errorUtils.js
// Utilitários para criação de erros padronizados

export const ERROR_CODES = {
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  GUIDE_NOT_FOUND: 'GUIDE_NOT_FOUND',
  LOCK_LOST: 'LOCK_LOST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

export function createError(message, code = ERROR_CODES.INTERNAL_ERROR, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export default {
  createError,
  ERROR_CODES
};
