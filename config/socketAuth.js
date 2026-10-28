// config/socketAuth.js
/**
 * Autenticação do handshake Socket.IO.
 *
 * Aceita o mesmo JWT da API (o front já envia em `auth: { token }`) ou um
 * token de serviço (ADMIN_API_TOKEN / AGENDA_EXPORT_TOKEN, usados pela Amanda
 * e pela Agenda Externa — ver middleware/amandaAuth.js).
 *
 * SOCKET_AUTH_MODE:
 *   - "warn"    (padrão) conexão sem token válido é ACEITA, mas logada.
 *               Serve para descobrir clientes que ainda não mandam token.
 *   - "enforce" conexão sem token válido é RECUSADA (connect_error "unauthorized").
 *   - "off"     não verifica nada (comportamento antigo).
 */
import jwt from 'jsonwebtoken';
import { safeEqual } from '../middleware/webhookAuth.js';

const VALID_MODES = new Set(['off', 'warn', 'enforce']);

export function getSocketAuthMode() {
    const mode = String(process.env.SOCKET_AUTH_MODE || 'warn').toLowerCase();
    return VALID_MODES.has(mode) ? mode : 'warn';
}

export function extractSocketToken(handshake = {}) {
    const fromAuth = handshake.auth?.token;
    if (fromAuth) return String(fromAuth);
    const raw = handshake.headers?.authorization || '';
    if (raw.startsWith('Bearer ')) return raw.slice(7).trim();
    const fromQuery = handshake.query?.token;
    if (fromQuery) return String(fromQuery);
    return null;
}

/**
 * @returns {{ ok: true, user: object } | { ok: false, reason: string }}
 */
export function verifySocketToken(token) {
    if (!token) return { ok: false, reason: 'missing_token' };

    const serviceTokens = [
        ['service:amanda', process.env.ADMIN_API_TOKEN],
        ['service:agenda', process.env.AGENDA_EXPORT_TOKEN],
    ];
    for (const [role, expected] of serviceTokens) {
        if (expected && safeEqual(token, expected)) {
            return { ok: true, user: { id: role, role } };
        }
    }

    if (!process.env.JWT_SECRET) return { ok: false, reason: 'jwt_secret_unset' };

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded?.id) return { ok: false, reason: 'invalid_payload' };
        return { ok: true, user: { id: decoded.id, role: decoded.role } };
    } catch (err) {
        return { ok: false, reason: err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token' };
    }
}

export function socketAuthMiddleware(socket, next) {
    const mode = getSocketAuthMode();
    if (mode === 'off') return next();

    const result = verifySocketToken(extractSocketToken(socket.handshake));
    if (result.ok) {
        socket.data.user = result.user;
        return next();
    }

    const origin = socket.handshake?.headers?.origin || 'sem-origin';
    if (mode === 'enforce') {
        console.warn(`🚫 [socket-auth] conexão recusada (${result.reason}) origin=${origin}`);
        const err = new Error('unauthorized');
        err.data = { code: 'SOCKET_UNAUTHORIZED', reason: result.reason };
        return next(err);
    }

    console.warn(`⚠️ [socket-auth] conexão SEM token válido aceita em modo warn (${result.reason}) origin=${origin}`);
    return next();
}
