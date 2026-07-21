// middleware/sanitize.js
import mongoSanitize from 'express-mongo-sanitize';
import xss from 'xss';

// ⚙️ Opções XSS: remove qualquer tag e ignora <script>/<style> por completo
const xssOptions = {
    whiteList: {},                 // sem tags permitidas
    stripIgnoreTag: true,          // remove tags não permitidas
    stripIgnoreTagBody: ['script', 'style'],
    css: false,
};

// 🧹 Campos/sentidos perigosos para prototype pollution
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// 🔎 Apenas strings devem sofrer XSS (evita quebrar tipos)
function sanitizeString(str) {
    if (typeof str !== 'string') return str;
    // normaliza: trim + colapsa espaços múltiplos
    const normalized = str.trim().replace(/\s{2,}/g, ' ');
    return xss(normalized, xssOptions);
}

// 🔁 Sanitização profunda (objetos/arrays)
function deepSanitize(value) {
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = deepSanitize(value[i]);
        return value;
    }
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) {
            if (FORBIDDEN_KEYS.has(key)) {
                delete value[key];
                continue;
            }
            value[key] = deepSanitize(value[key]);
        }
        return value;
    }
    return sanitizeString(value);
}

// ⛔ Rejeita payloads muito grandes (proteção simples anti-DoS/overposting)
function guardPayloadSize(req, res, next) {
    // Ignora uploads multipart (deixar para o multer tratar)
    if (req.headers['content-type']?.includes('multipart/form-data')) {
        return next();
    }
    const len = parseInt(req.headers['content-length'] || '0', 10);
    // Ajuste esse valor conforme sua realidade (ex.: 50 MB)
    const MAX = 50 * 1024 * 1024;
    if (len > MAX) {
        return res.status(413).json({ success: false, message: 'Payload muito grande.' });
    }
    next();
}

// 🧩 Middleware principal
export function sanitizeInput(req, _res, next) {
    // 1) Remove operadores Mongo ($, .) com express-mongo-sanitize
    //    Dica: se você precisa permitir pontos em chaves, mude allowDots: true e gerencie manualmente.
    mongoSanitize({
        allowDots: false,
        replaceWith: '_', // substitui ao invés de remover (evita colisões silenciosas)
    })(req, _res, () => {
        // 2) Sanitização profunda de XSS somente em strings
        if (req.body && typeof req.body === 'object') deepSanitize(req.body);
        if (req.query && typeof req.query === 'object') deepSanitize(req.query);
        if (req.params && typeof req.params === 'object') deepSanitize(req.params);
        next();
    });
}

// 📦 Exporta um “pacote” pronto para usar na app
export function sanitizeStack() {
    return [guardPayloadSize, sanitizeInput];
}
