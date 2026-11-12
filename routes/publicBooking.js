/**
 * 🌐 Agendamento público — link da bio do Instagram / página /agendar do site.
 * Montado em /api/public/booking. SEM login, por isso:
 *  - desligado por padrão (PUBLIC_BOOKING_ENABLED=true para ligar);
 *  - rate limit por IP; captcha Cloudflare Turnstile quando TURNSTILE_SECRET_KEY existe; campo isca;
 *  - respostas nunca trazem ids, nomes de profissionais, contagem de vagas nem se o paciente já existia.
 * Doc: docs/flows/public_booking_flow.md
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  allowedSpecialties,
  isHoneypotFilled,
  isPublicBookingEnabled,
  isValidBookingCode,
  validateHoldPayload,
} from '../services/publicBooking/publicBookingRules.js';
import { PublicBookingError, createHold, getOptions, getStatus } from '../services/publicBooking/publicBookingService.js';

const TOO_MANY = { success: false, error: 'TOO_MANY_REQUESTS', message: 'Muitas tentativas. Tente de novo mais tarde ou fale com a gente no WhatsApp.' };

const buildLimiter = (windowMs, max, label) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`⚠️ [PUBLIC-BOOKING] limite ${label} atingido`);
    res.status(429).json(TOO_MANY);
  },
});

const MESSAGES = {
  DISABLED: 'O agendamento online está pausado. Fale com a gente no WhatsApp.',
  PERIOD_FULL: 'Esse período acabou de lotar. Escolha outro horário.',
  SLOT_TAKEN: 'Esse horário acabou de ser reservado. Escolha outro.',
  DAILY_CAP: 'Hoje as reservas online já esgotaram. Fale com a gente no WhatsApp.',
  TOO_MANY_REQUESTS: TOO_MANY.message,
  CAPTCHA: 'Não conseguimos confirmar que você não é um robô. Recarregue a página e tente de novo.',
  INTERNAL: 'Não conseguimos reservar agora. Fale com a gente no WhatsApp.',
};

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ success: false, error, message: MESSAGES[error] || MESSAGES.INTERNAL, ...extra });
}

export async function verifyTurnstile(token, ip, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // captcha ainda não configurado: valem rate limit + isca + teto diário
  if (!token || typeof token !== 'string') return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const json = await r.json();
    return json?.success === true;
  } catch (err) {
    console.error('[PUBLIC-BOOKING] turnstile', err.message);
    return false;
  }
}

export function createPublicBookingRouter({ env = process.env, limits = {} } = {}) {
  const router = express.Router();
  const optionsLimiter = buildLimiter(10 * 60 * 1000, limits.options ?? 60, 'options');
  const holdLimiter = buildLimiter(60 * 60 * 1000, limits.hold ?? 5, 'hold');
  const statusLimiter = buildLimiter(10 * 60 * 1000, limits.status ?? 30, 'status');

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!isPublicBookingEnabled(env)) return fail(res, 503, 'DISABLED');
    return next();
  });

  router.get('/options', optionsLimiter, async (req, res) => {
    try {
      const specialty = String(req.query.specialty || '').toLowerCase();
      if (!allowedSpecialties(env).includes(specialty)) {
        return res.status(400).json({ success: false, error: 'BAD_REQUEST', message: 'Especialidade inválida.', specialties: allowedSpecialties(env) });
      }
      const data = await getOptions({ specialty, from: req.query.from, days: req.query.days });
      return res.json({ success: true, ...data });
    } catch (err) {
      console.error('[PUBLIC-BOOKING] options', err.message);
      return fail(res, 500, 'INTERNAL');
    }
  });

  router.post('/hold', holdLimiter, async (req, res) => {
    try {
      // Robô preencheu o campo isca: responde como sucesso e não grava nada.
      if (isHoneypotFilled(req.body)) {
        console.warn('[PUBLIC-BOOKING] isca preenchida, descartado');
        return res.status(201).json({ success: true, code: 'FI-000000', display: '' });
      }

      const parsed = validateHoldPayload(req.body, { env });
      if (!parsed.ok) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Confira os campos destacados.', fields: parsed.errors });
      }

      if (!(await verifyTurnstile(req.body.captchaToken, req.ip, { env }))) {
        return fail(res, 400, 'CAPTCHA');
      }

      const result = await createHold(parsed.data, { env });
      return res.status(201).json({ success: true, code: result.code, display: result.display });
    } catch (err) {
      if (err instanceof PublicBookingError) return fail(res, err.status, err.code, err.extra);
      console.error('[PUBLIC-BOOKING] hold', err.message);
      return fail(res, 500, 'INTERNAL');
    }
  });

  router.get('/:code', statusLimiter, async (req, res) => {
    try {
      const code = String(req.params.code || '').toUpperCase();
      if (!isValidBookingCode(code)) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      const status = await getStatus(code);
      if (!status) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      return res.json({ success: true, ...status });
    } catch (err) {
      console.error('[PUBLIC-BOOKING] status', err.message);
      return fail(res, 500, 'INTERNAL');
    }
  });

  return router;
}

export default createPublicBookingRouter();
