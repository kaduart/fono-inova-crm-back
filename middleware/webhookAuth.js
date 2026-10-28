/**
 * Autenticação de webhooks externos por segredo compartilhado.
 *
 * O chamador prova que conhece o segredo por um destes meios (nesta ordem):
 *   1. parâmetro de rota `:token`      → ex.: /api/pix/webhook/<segredo>  (Sicoob)
 *   2. header `x-webhook-secret`
 *   3. header `Authorization: Bearer <segredo>`
 *
 * A comparação é em tempo constante. O segredo nunca é logado.
 */
import crypto from 'crypto';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

export function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

export function extractWebhookToken(req) {
    if (req.params?.token) return String(req.params.token);
    const header = req.headers?.['x-webhook-secret'];
    if (header) return String(header);
    const raw = req.headers?.authorization || '';
    if (raw.startsWith('Bearer ')) return raw.slice(7).trim();
    return null;
}

/**
 * @param {string} envVar nome da env com o segredo (ex.: 'PAYMENT_WEBHOOK_SECRET')
 * @param {{ allowWhenUnset?: boolean, label?: string }} options
 *   allowWhenUnset: true só para webhooks já em produção cujo provedor ainda
 *   não foi reconfigurado (ex.: Sicoob) — deixa passar com aviso enquanto a
 *   env não existir. Sem a flag, env ausente = 503 (fail-closed).
 */
export function requireWebhookSecret(envVar, { allowWhenUnset = false, label = envVar } = {}) {
    return (req, res, next) => {
        const secret = process.env[envVar];

        if (!secret) {
            if (allowWhenUnset) {
                console.warn(`[webhookAuth] ⚠️ ${label}: ${envVar} não configurado — webhook aceito SEM autenticação`);
                return next();
            }
            console.error(`[webhookAuth] ❌ ${label}: ${envVar} não configurado — webhook recusado`);
            return sendApiError(
                res,
                new AppError('WEBHOOK_NOT_CONFIGURED', 'Webhook indisponível: segredo não configurado no servidor', { status: 503 }),
                req
            );
        }

        if (!safeEqual(extractWebhookToken(req), secret)) {
            console.warn(`[webhookAuth] 🚫 ${label}: chamada recusada (segredo ausente ou inválido) ip=${req.ip}`);
            return sendApiError(
                res,
                new AppError('WEBHOOK_UNAUTHORIZED', 'Webhook não autorizado', { status: 401 }),
                req
            );
        }

        return next();
    };
}
