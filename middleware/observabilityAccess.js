// middleware/observabilityAccess.js
// Acesso às rotas de observabilidade, diagnóstico e filas.
//
//   público mínimo: GET /health, /api/health, /api/v2/health → só { status, timestamp }
//                   (Render usa /api/health como healthCheckPath).
//   staffOnly:      leitura de saúde, métricas e painéis (admin, secretary).
//   adminOnly:      diagnóstico que lê webhooks/mensagens, injeta eventos ou
//                   limpa Redis, e o Bull Board (/admin/queues).
//
// Ver docs/OBSERVABILIDADE_ACESSO.md.
import { auth, authorize } from './auth.js';

export const staffOnly = [auth, authorize(['admin', 'secretary'])];
export const adminOnly = [auth, authorize(['admin'])];

const BULL_COOKIE = 'token';
const BULL_COOKIE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Bull Board é aberto no navegador (link), então não há cabeçalho Authorization.
 * Primeira visita: /admin/queues?token=<jwt de admin>. Validado o token, ele vai
 * para um cookie httpOnly restrito a /admin/queues (1 h), que o `auth` já lê,
 * e o navegador é redirecionado para a URL sem o token.
 */
export function bullBoardGuard(req, res, next) {
  const fromQuery = typeof req.query?.token === 'string' ? req.query.token : null;
  // O app não usa cookie-parser: lê o cookie do Bull Board aqui.
  if (!req.headers.authorization && !fromQuery) {
    const m = /(?:^|;\s*)token=([^;]+)/.exec(req.headers.cookie || '');
    if (m) req.headers.authorization = `Bearer ${decodeURIComponent(m[1])}`;
  }
  return auth(req, res, (err) => {
    if (err) return next(err);
    return authorize(['admin'])(req, res, (err2) => {
      if (err2) return next(err2);
      if (fromQuery) {
        res.cookie(BULL_COOKIE, fromQuery, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          path: '/admin/queues',
          maxAge: BULL_COOKIE_MAX_AGE_MS
        });
        const clean = req.originalUrl.replace(/([?&])token=[^&]*(&|$)/, (m, a, b) => (b ? a : '')).replace(/[?&]$/, '');
        if (req.method === 'GET') return res.redirect(302, clean || '/admin/queues');
      }
      return next();
    });
  });
}

/** Corpo público mínimo de health check. */
export function minimalHealthBody(ok) {
  return { status: ok ? 'ok' : 'degraded', timestamp: new Date().toISOString() };
}
