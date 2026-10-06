// middleware/errorHandler.js
import { buildErrorResponse } from '../errors/buildErrorResponse.js';
import '../errors/registerHumanizers.js';

/**
 * Wrapper para handlers async - captura erros automaticamente
 */
export const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

/**
 * Cria erro de negócio padronizado
 */
export const createBusinessError = (message, statusCode = 400, code = 'BUSINESS_ERROR') => {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    error.isBusinessError = true;
    return error;
};

export const errorHandler = async (err, req, res, next) => {
    // Resposta já iniciada: delega ao handler padrão do Express.
    if (res.headersSent) return next(err);

    // Log estruturado do erro
    console.error({
        timestamp: new Date().toISOString(),
        error: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        userId: req.user?.id
    });

    // Envelope único (ver docs/MENSAGERIA_PADRAO.md): mantém `error` e `code` de sempre e acrescenta
    // `message`, `title`, `action`, `items`, `technicalMessage`.
    const { status, body } = await buildErrorResponse(err, {
        correlationId: req.headers['x-correlation-id'] || req.correlationId,
        includeStack: process.env.NODE_ENV === 'development'
    });
    res.status(status).json(body);
};
