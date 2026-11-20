import crypto from 'node:crypto';

// utils/metaWebhookVerify.js
// Handshake de assinatura do webhook da Meta (GET com hub.mode=subscribe).
// Sem valor padrão: o repositório é público, então um token fixo no código vale para qualquer um.
// Devolve { status, body }: 200 com o challenge, ou 403.
// Usado no webhook de leads (META_VERIFY_TOKEN) e no do WhatsApp (WHATSAPP_VERIFY_TOKEN).
// Nunca registre nem devolva o token esperado.
export function verifyMetaSubscription(query = {}, expected = process.env.META_VERIFY_TOKEN) {
  const want = typeof expected === 'string' ? expected.trim() : '';
  const got = typeof query['hub.verify_token'] === 'string' ? query['hub.verify_token'].trim() : '';
  if (query['hub.mode'] !== 'subscribe') return { status: 403, body: null, reason: 'hub.mode não é subscribe' };
  if (!want) return { status: 403, body: null, reason: 'token de verificação não configurado' };
  if (got !== want) return { status: 403, body: null, reason: 'token de verificação inválido' };
  return { status: 200, body: query['hub.challenge'] };
}

// ── Assinatura das NOTIFICAÇÕES (POST) da Meta ──────────────────────────────────
// A verificação do token acima só vale para a assinatura do webhook (GET hub.mode=subscribe).
// Cada POST da Meta traz X-Hub-Signature-256: sha256=<HMAC-SHA256 do corpo CRU com o
// App Secret>. Sem conferir isso, qualquer um que saiba a URL cria lead falso.
// Política META_LEAD_SIGNATURE: off | log (padrão: confere e só registra) | on (recusa).

export function metaSignaturePolicy(env = process.env) {
  const v = String(env.META_LEAD_SIGNATURE ?? '').trim().toLowerCase();
  return ['off', 'log', 'on'].includes(v) ? v : 'log';
}

export function verifyMetaSignature(rawBody, header, secret = process.env.META_APP_SECRET) {
  const key = typeof secret === 'string' ? secret.trim() : '';
  if (!key) return { ok: false, reason: 'app_secret_nao_configurado' };
  const h = typeof header === 'string' ? header.trim() : '';
  const m = /^sha256=([0-9a-f]{64})$/i.exec(h);
  if (!m) return { ok: false, reason: h ? 'assinatura_mal_formada' : 'sem_assinatura' };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? '');
  const want = crypto.createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(m[1].toLowerCase(), 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, reason: 'assinatura_invalida' };
  return { ok: true };
}

// Decide o que fazer com um POST: { accept, reason, policy }. Com a política "on", nada sem
// assinatura válida passa (inclusive se o App Secret faltar: falha fechada).
export function checkMetaNotification(rawBody, headers = {}, env = process.env) {
  const policy = metaSignaturePolicy(env);
  if (policy === 'off') return { accept: true, policy, reason: 'politica_off' };
  const r = verifyMetaSignature(rawBody, headers['x-hub-signature-256'], env.META_APP_SECRET);
  if (r.ok) return { accept: true, policy, reason: 'assinatura_ok' };
  return { accept: policy !== 'on', policy, reason: r.reason };
}

// Middleware do POST: recebe o corpo CRU (express.raw), confere a assinatura ANTES de criar
// lead ou enfileirar qualquer coisa, e só então transforma o corpo em JSON (req.body).
// Nunca registra a assinatura, o segredo nem o corpo.
export function metaNotificationGuard({ env = process.env, log = console } = {}) {
  return (req, res, next) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const check = checkMetaNotification(raw, req.headers || {}, env);
    if (!check.accept) {
      log.warn?.(`[META-LEADS] 🚫 notificação recusada: ${check.reason}`);
      return res.sendStatus(403);
    }
    if (check.reason !== 'assinatura_ok' && check.policy === 'log') {
      log.warn?.(`[META-LEADS] ⚠️ notificação sem assinatura válida (${check.reason}); aceita porque META_LEAD_SIGNATURE=log`);
    }
    try {
      req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    } catch {
      return res.sendStatus(400);
    }
    return next();
  };
}
