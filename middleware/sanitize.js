// middleware/sanitize.js
import mongoSanitize from 'express-mongo-sanitize';
import xss from 'xss';

export const sanitizeInput = (req, res, next) => {
    // Remove caracteres perigosos para MongoDB
    mongoSanitize.sanitize(req.body);
    mongoSanitize.sanitize(req.query);
    mongoSanitize.sanitize(req.params);

    // Sanitiza XSS em campos de texto
    if (req.body) {
        Object.keys(req.body).forEach(key => {
            if (typeof req.body[key] === 'string') {
                req.body[key] = xss(req.body[key]);
            }
        });
    }

    next();
};