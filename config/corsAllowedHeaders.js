// Cabeçalhos que o navegador pode enviar ao back (preflight CORS).
// Idempotency-Key: sem ele na lista, o navegador bloqueia o POST de pagamento
// antes de chegar ao servidor (o front chama https://fono-inova-crm-back.onrender.com,
// outra origem). Por isso o back precisa ser implantado ANTES do front que envia a chave.
export const CORS_ALLOWED_HEADERS = Object.freeze([
  'Content-Type',
  'Authorization',
  'x-correlation-id',
  'x-client-request-id',
  'Idempotency-Key',
  'Cache-Control',
  'Pragma',
  'X-Client'
]);
