// middleware/errorHandler.js

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

export const errorHandler = (err, req, res, next) => {
    let error = { ...err };
    error.message = err.message;

    // Log estruturado do erro
    console.error({
        timestamp: new Date().toISOString(),
        error: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        userId: req.user?.id
    });

    // Tratamento específico por tipo de erro
    if (err.name === 'ValidationError') {
        const errors = Object.values(err.errors).map(val => ({
            field: val.path,
            message: val.message
        }));
        return res.status(400).json({
            success: false,
            error: 'Dados inválidos',
            errors,
            code: 'VALIDATION_ERROR'
        });
    }

    // Outros tipos de erro...

    res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || 'Erro interno do servidor',
        code: error.code || 'INTERNAL_ERROR',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};