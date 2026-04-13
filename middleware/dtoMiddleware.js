// middleware/dtoMiddleware.js
// 🎯 DTO Middleware - Garante contrato de API em todas as respostas V2

import { createCompleteSessionResponse, createErrorResponse } from '../dtos/completeSessionResponse.dto.js';

/**
 * Middleware que aplica DTO de forma consistente
 * 
 * Uso: app.use('/api/v2', dtoMiddleware);
 */
export function dtoMiddleware(req, res, next) {
  // Só aplica em rotas V2
  if (!req.path.startsWith('/v2')) {
    return next();
  }

  // Guarda resposta original
  const originalJson = res.json;

  // Override res.json para aplicar DTO
  res.json = function(data) {
    // Se já tem formato DTO (success + data/meta), passa direto
    if (data && typeof data === 'object' && 'success' in data && 'data' in data) {
      return originalJson.call(this, data);
    }

    // Se é erro, aplica DTO de erro
    if (data instanceof Error || (data && data.error)) {
      const errorDto = createErrorResponse({
        code: data.code || 'UNKNOWN_ERROR',
        message: data.message || 'Erro desconhecido'
      });
      return originalJson.call(this, errorDto);
    }

    // Se não tem formato DTO, converte
    const wrapped = {
      success: true,
      data: data,
      meta: {
        version: 'v2',
        timestamp: new Date().toISOString(),
        path: req.path,
        method: req.method
      }
    };

    return originalJson.call(this, wrapped);
  };

  next();
}

/**
 * Helper específico para complete session
 * Aplica DTO correto baseado no tipo de billing
 */
export function completeSessionDtoMapper(result) {
  return createCompleteSessionResponse({
    appointmentId: result.appointmentId,
    sessionId: result.sessionId,
    packageId: result.packageId,
    clinicalStatus: 'completed',
    operationalStatus: 'completed',
    paymentStatus: result.paymentStatus || 'unpaid',
    balanceAmount: result.balanceAmount || 0,
    sessionValue: result.sessionValue || 0,
    isPaid: result.isPaid || false,
    completedAt: new Date(),
    correlationId: result.correlationId,
    idempotent: result.idempotent || false
  });
}

/**
 * Middleware de erro que garante DTO em erros
 */
export function dtoErrorMiddleware(err, req, res, next) {
  // Só aplica em rotas V2
  if (!req.path.startsWith('/v2')) {
    return next(err);
  }

  const statusCode = err.statusCode || err.status || 500;
  
  const errorDto = createErrorResponse({
    code: err.code || `HTTP_${statusCode}`,
    message: err.message || 'Erro interno do servidor'
  });

  res.status(statusCode).json(errorDto);
}

export default {
  dtoMiddleware,
  completeSessionDtoMapper,
  dtoErrorMiddleware
};
