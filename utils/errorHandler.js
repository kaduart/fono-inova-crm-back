// src/middlewares/errorHandler.js
export const errorHandler = (err, req, res, next) => {
    console.error('[API Error]', {
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
    });

    // Erros conhecidos
    const errorHandlers = {
        TokenExpiredError: () => res.status(401).json({
            code: 'TOKEN_EXPIRED',
            message: 'Sessão expirada. Faça login novamente.',
            redirect: true
        }),

        JsonWebTokenError: () => res.status(401).json({
            code: 'INVALID_TOKEN',
            message: 'Token inválido'
        }),

        CastError: () => res.status(400).json({
            code: 'INVALID_ID',
            message: 'ID inválido'
        }),

        ValidationError: () => res.status(400).json({
            code: 'VALIDATION_ERROR',
            errors: Object.values(err.errors).map(e => e.message)
        }),

        default: () => res.status(err.status || 500).json({
            code: 'SERVER_ERROR',
            message: process.env.NODE_ENV === 'production'
                ? 'Erro interno no servidor'
                : err.message
        })
    };

    // Executa o handler específico ou o default
    const handler = errorHandlers[err.name] || errorHandlers.default;
    handler();
};