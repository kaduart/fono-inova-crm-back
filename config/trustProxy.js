// config/trustProxy.js
// Configuração segura de proxy do Express (Render: Cloudflare → load balancer → app).
//
// `trust proxy` = número de saltos de proxy CONFIÁVEIS. O Express então calcula `req.ip` a partir do
// X-Forwarded-For contando desse número a partir da direita — valores que o visitante forja à esquerda
// são ignorados. Nunca usar `true` (confia em qualquer X-Forwarded-For e permite burlar rate limit).
//
// Padrão 1 (falha "segura"): se a topologia real tiver mais saltos, visitantes que passam pelo mesmo
// proxy compartilham o limite (mais restritivo), mas ninguém consegue forjar o próprio IP.
// Ajuste com a env TRUST_PROXY_HOPS depois de confirmar quantos saltos o Render adiciona.

const DEFAULT_HOPS = 1;
const MAX_HOPS = 5;

export const resolveTrustProxy = (raw = process.env.TRUST_PROXY_HOPS) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_HOPS;

    const hops = Number(raw);
    if (Number.isInteger(hops) && hops >= 0 && hops <= MAX_HOPS) return hops;

    console.warn(`⚠️ [TRUST_PROXY] TRUST_PROXY_HOPS inválido (${raw}); usando ${DEFAULT_HOPS}`);
    return DEFAULT_HOPS;
};

export const configureTrustProxy = (app, raw = process.env.TRUST_PROXY_HOPS) => {
    const hops = resolveTrustProxy(raw);
    app.set('trust proxy', hops);
    return hops;
};

export default configureTrustProxy;
