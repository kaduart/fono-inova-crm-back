# Autenticação de webhooks e Socket.IO

> Criado em 2026-10-28. Ler antes de mexer em `routes/payment.v2.js` (webhook),
> `routes/pix.js`, `services/sicoobService.js` ou `config/socket.js`.

## Por que existe

Até 2026-10-28 três portas de entrada não tinham autenticação nenhuma:

| Porta | Risco |
|---|---|
| `POST /api/v2/payments/webhook` | Qualquer pessoa com um `paymentId` publicava `PAYMENT_COMPLETED` / `PAYMENT_STATUS_CHANGED` (baixa de pagamento falsa) |
| `POST /api/pix/webhook` e rotas administrativas de `/api/pix` | Notificação de PIX falsa (vai para o front via `pix-received`); re-registro do webhook e listagem de PIX recebidos sem login |
| Socket.IO | Qualquer cliente conectado recebia todos os `io.emit` (mensagens de WhatsApp de pacientes, PIX, agenda) |

## Como funciona

| Peça | Arquivo | Regra |
|---|---|---|
| Segredo compartilhado | `middleware/webhookAuth.js` | `requireWebhookSecret(ENV)`: aceita `:token` no path, `x-webhook-secret` ou `Authorization: Bearer`. Comparação em tempo constante |
| Webhook de pagamento | `routes/payment.v2.js` | `PAYMENT_WEBHOOK_SECRET`. **Fail-closed**: sem a env, 503 (não há chamador conhecido em produção) |
| Webhook PIX Sicoob | `routes/pix.js` | `SICOOB_WEBHOOK_SECRET` no path: `/api/pix/webhook/<segredo>` (e `/pix` no final, padrão BACEN). Sem a env, segue aceitando `/webhook` com aviso no log (legado) |
| Registro no Sicoob | `services/sicoobService.js` | Com a env, `registerWebhook()` registra a URL já com o segredo |
| Admin PIX | `routes/pix.js` | `register-webhook` e `debug-webhook` = admin; `received` = logado. `checkout` e `cobranca/:txid` continuam públicos (fluxo de cobrança) |
| Socket.IO | `config/socketAuth.js` + `io.use()` em `config/socket.js` | Handshake com JWT da API (`auth: { token }`) ou token de serviço (`ADMIN_API_TOKEN`, `AGENDA_EXPORT_TOKEN`). `SOCKET_AUTH_MODE`: `off`, `warn` (padrão: aceita e loga), `enforce` (recusa) |

O socket **não** usa o fallback `'secreta'` do `middleware/auth.js`: sem `JWT_SECRET`, nenhum JWT é aceito.

## Rollout em produção

1. Deploy (nada muda de comportamento para o PIX nem para o socket; o webhook de pagamento passa a responder 503 até ter segredo).
2. Se algum sistema externo chama `/api/v2/payments/webhook`, definir `PAYMENT_WEBHOOK_SECRET` e passar o header nele.
3. PIX: definir `SICOOB_WEBHOOK_SECRET` no Render e logo em seguida chamar `POST /api/pix/register-webhook` (admin). Conferir em `GET /api/pix/debug-webhook`. Entre os dois passos o Sicoob recebe 401 e reenvia.
4. Socket: deixar alguns dias em `warn`, procurar `[socket-auth] conexão SEM token` nos logs (origens que ainda não mandam token), corrigir e trocar para `SOCKET_AUTH_MODE=enforce`.

## O que não muda

- `io.emit` continua global para quem está autenticado. Separar por sala (papel/usuário) é o próximo passo.
- Nenhum evento, fila ou payload foi alterado.
