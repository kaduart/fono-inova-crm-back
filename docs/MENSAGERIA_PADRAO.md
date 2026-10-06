# Mensageria padrão da aplicação (erros para o usuário)

> Objetivo: quando algo é recusado, **o comercial/secretaria entende quem, qual sessão e o que fazer** —
> sem ID de banco, sem jargão. O texto técnico continua disponível para o suporte.
> Criado em 2026-10-06 a partir do caso Antonella/Unimed (erro "Payment 6a3c… está em 'paid'…" sem dizer qual paciente).

## 1. O envelope único de erro

Todo erro da API responde assim (superconjunto do formato que o front já lia — nada quebra):

```json
{
  "success": false,
  "code": "PAYMENT_STATUS_NOT_BILLABLE",
  "message": "Faturamento não realizado — pagamento já baixado\n1 sessão está com o pagamento fora de \"pendente de faturamento\"…\n• Antonella Souza Eneas — sessão de 29/06/2026 (guia 16241739) · R$ 80,00 — já consta como pago\n\nAvise o financeiro para conferir o pagamento dessa sessão.",
  "error": "(mesmo texto de message — compatibilidade com o front antigo)",
  "title": "Faturamento não realizado — pagamento já baixado",
  "action": "Avise o financeiro para conferir o pagamento dessa sessão. Nada foi faturado…",
  "items": [{ "sessionId": "…", "patientName": "…", "sessionDate": "…", "guideNumber": "…" }],
  "details": { "sessionIds": ["…"] },
  "technicalMessage": "Payment 6a3c… está em 'paid' e não pode transicionar para 'billed'",
  "correlationId": "front_1791297464104_cbc8cxpfu"
}
```

| Campo | Para quem | Regra |
|-------|-----------|-------|
| `code` | o front (decide comportamento) | estável, MAIÚSCULAS; nunca mudar um código publicado |
| `message` | **o usuário** | pt-BR, completo (título + o fato + o que fazer). É o que o toast mostra |
| `error` | consumidores antigos | sempre igual a `message` |
| `title`, `action`, `items` | UI rica (modal/lista) | opcionais |
| `details` | código/suporte | ids estruturados; nunca mostrar ao usuário |
| `technicalMessage` | suporte | texto técnico original — só aparece quando difere de `message` |
| `errors` | formulários | validação: `[{ field, message }]` |

> **Decisão:** o contrato antigo (`API_CONTRACT_V2.md`, topo) descrevia `error` como objeto
> `{ code, message }`. Isso **nunca foi implementado** — ~1.160 pontos do back e todo o front usam
> `error` como texto. O envelope acima é o canônico; o formato "objeto" ficou só no papel.

## 2. Quem faz o quê

```
back/errors/AppError.js            erro de negócio com contexto (code, status, title, action, items, details)
back/errors/errorCatalog.js        catálogo por code (status/título/ação padrão) + registro de tradutores
back/errors/buildErrorResponse.js  ÚNICO lugar que monta o envelope  (+ sendApiError)
back/errors/registerHumanizers.js  liga o tradutor de cada domínio ao catálogo
back/middleware/errorHandler.js    handler global → usa buildErrorResponse
front/src/utils/errorUtils.ts      extractApiError() lê o envelope; extractErrorMessage() segue valendo
front/src/utils/notifyApiError.ts  aviso padrão (react-toastify)
```

Precedência do texto: **tradutor do domínio → catálogo → texto do próprio erro**. O texto técnico original
nunca se perde (`technicalMessage`). Tradutor que falha nunca derruba a resposta.

## 3. Como adicionar uma mensagem nova

1. **Erro simples, sem contexto** (ex.: "guia obrigatória"): lance `AppError` ou registre o `code` em
   `registerErrorCatalog` com `status`, `title` e `action`.
2. **Erro que precisa nomear paciente/sessão/guia** (financeiro, convênio, agenda): lance o erro com
   `details: { sessionId | sessionIds | paymentId }` e escreva/estenda o tradutor do domínio — o exemplo é
   `services/billingSubmission/billingErrorMessages.js` (função pura `buildBillingMessage` + carregador).
   Registre em `errors/registerHumanizers.js`.
3. **No controller:** `catch (e) { sendApiError(res, e, req) }` — ou deixe subir com `asyncHandler`/`next(e)`.
   **Não** monte `res.status(4xx).json({ error: '…' })` à mão em código novo.
4. **No front:** `notifyApiError(error, 'Mensagem padrão')`. Para modal/lista use `extractApiError(error)`
   (`title`, `action`, `items`).

## 4. Regras de redação (para o comercial)

- Diga **quem e qual sessão**: "Antonella Souza Eneas — sessão de 29/06/2026 (guia 16241739)". Nunca ID de banco.
- Diga **o que aconteceu** em uma frase e **quem resolve / o que fazer** ("Avise o financeiro…").
- Diga o que **não** foi alterado quando relevante ("Nada foi faturado").
- Liste todos os itens problemáticos de uma vez (máx. 5 + "e mais N"), não um por tentativa.
- Violação de regra de negócio é **409** (ou 4xx), nunca 500. 500 é só para falha inesperada.

## 5. Estado da adoção (2026-10-06)

| Área | Situação |
|------|----------|
| Envelope + `errorHandler` global | ✅ implementado (back) |
| Faturamento de convênio (`/billing-submissions`) | ✅ tradutor + early-fail + front (`BillingCommunicationWizard`) |
| Financeiro/convênio/pacote (10 arquivos: `convenioPackageController`, `insuranceBatchController`, `insuranceGuides.v2`, `insuranceV2Controller`, `packageController.v2`, `payment.v2`, `insurancePlans.v2`, `convenioManageController`, `therapyPackageController`, `liminarContractController`) | ✅ 358 pontos migrados via `scripts/codemods/migrate-api-errors.mjs` (simulação por padrão, `--apply` grava; idempotente). `errors` de validação passa por `extra` |
| Demais controllers e rotas (120 arquivos, ~1.000 pontos: agenda, pagamentos, financeiro, leads, WhatsApp, GMB, auth…) | ✅ migrados com o mesmo codemod em 2026-10-06. Exceções deliberadas: `routes/health.js` e `observabilityController` (monitores externos); `middleware/auth.js`, `convenioApiController` (passa `result` pronto) e 1 ponto em `financial/expense.js` ficaram manuais |
| Rotas que usam `formatError` (`doctor.v2`, `package.v2`, `patient.v2`) | ✅ `utils/apiMessages.formatError` emite o envelope no topo **e** mantém `error` como objeto `{code,message}` (legado, deprecated): há testes e front (`TherapyPackageCard`) que leem `error.code`. Normaliza as ordens de argumentos históricas |
| Front: `extractErrorMessage` | ✅ prefere `message` quando a resposta é do envelope (tem `code`) — vale para todos os usos sem edição |
| Front: `toast.error(extractErrorMessage(...))` | ✅ 92 pontos em 31 arquivos (financeiro, convênio, pacote, agenda, pacientes, médicos, hooks, serviços) viraram `notifyApiError`. Ficaram: `Login`, `useErrorHandler`, toasts com opções próprias e padrões que leem `response.data.error` direto |
| Duas libs de toast | ✅ unificadas em `react-toastify` via `front/src/utils/toast.ts` (aceita `id`, `duration`, `icon`, render por função e `dismiss` do hot-toast; mesmo `id` atualiza o aviso). 34 arquivos migrados, 3 `<Toaster/>` removidos, 7 testes redirecionados. **Use `import { toast } from '.../utils/toast'`**; `react-hot-toast` não deve mais ser importado (a dependência ainda está no `package.json`) |
| App `agenda` (projeto separado) | ✅ `src/utils/apiError.js` (`apiErrorText`) lê `message`/`action` do envelope e os formatos antigos. Contrato revisado: `reschedule` é **PATCH** (client e allowlist do token `agenda_service` estavam em POST); handlers de `appointment.v2.js` (criar/editar/remarcar/cancelar/confirmar/deletar/complete) agora usam `sendApiError`. Pendente: ~20 respostas com status dinâmico em pacote/guias/despesas (já trazem `code`/`message`) |

**Ordem de migração sugerida (maior dor primeiro):** (1) financeiro/convênio/pacote — onde o comercial trava;
(2) agenda: criar/remarcar/cancelar (conflitos já têm `extractScheduleConflictMessage`); (3) pagamentos manuais;
(4) o resto, oportunisticamente — quem tocar um controller troca o `res.status().json` por `sendApiError`.

## 6. Anti-patterns

- ❌ Expor ID de Payment/Session/Appointment ao usuário no texto.
- ❌ Responder 500 para regra de negócio.
- ❌ `res.json({ success:false, error:'…' })` à mão em código novo.
- ❌ Mudar um `code` já publicado (o front e a agenda dependem dele).
- ❌ Esconder o texto técnico: ele vai em `technicalMessage`.
