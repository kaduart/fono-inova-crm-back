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
