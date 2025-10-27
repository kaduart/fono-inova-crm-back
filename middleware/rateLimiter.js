// middleware/rateLimiter.js
import rateLimit from 'express-rate-limit';

export const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 5, // máximo 5 tentativas por IP
    message: 'Muitas tentativas de login. Tente novamente em 15 minutos.',
    standardHeaders: true,
    legacyHeaders: false,
});

export const mediaLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    max: 60,             // 60 req/min por IP
    standardHeaders: true,
    legacyHeaders: false,
});

export const rateLimitStrict = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 min
    max: 5,                   // 5 req por IP
    standardHeaders: true,
    legacyHeaders: false,
});
