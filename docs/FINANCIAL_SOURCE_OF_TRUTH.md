# Fonte Única de Verdade — Domínio Financeiro

> **Atualizado em:** 13/06/2026 (Sprint 3.10 — Consolidação Arquitetural)
>
> **Regra de ouro:** nunca recalcule financeiro no frontend. Sempre consuma os valores destes serviços.
>
> **Regra de ouro 2:** nunca altere `Payment.status` diretamente. Sempre use `paymentStatusService.transitionPaymentStatus()`.

---

## Mapa de fontes oficiais

| Conceito | Fonte única | Onde vive | Endpoint principal |
|---|---|---|---|
| **Produção** | `unifiedFinancialService.v2.js` | Backend | `/api/v2/financial/dashboard` |
| **Caixa / Recebido** | `unifiedFinancialService.v2.js` | Backend | `/api/v2/cashflow` |
| **Meta Realizada** | `unifiedFinancialService.v2.js` → `calculateMetaRealizada()` | Backend | `/api/v2/financial/dashboard` (`metas.realizado.mes`) e `/api/v2/cashflow` (`metaRealizada.total`) |
| **A Receber** | `ReconciliationService` | Backend | `/api/internal/financial/reconciliation/issues` |
| **Comissão por sessão** | `commissionRule.service.js` | Backend | Motor oficial de cálculo por sessão |
| **Comissão Mensal** | `commissionService.js` | Backend | Gera `Expense` de comissão mensal |
| **Simulação de Comissão** | `commissionRule.service.js` | Backend | `/api/v2/professionals/:id/commission-simulation` |
| **Resultado do Profissional** | `ProfessionalFinancialService` | Backend | `/api/v2/professionals/:id/summary` |
| **Ranking de Profissionais** | `ProfessionalFinancialService` | Backend | `/api/v2/professionals/ranking` |
| **Adiantamentos** | `ProfessionalAdvanceService` | Backend | `/api/v2/professionals/:id/advances` |
| **Fechamento Mensal** | `ProfessionalSettlementService` | Backend | `/api/v2/professionals/:id/settlements/*` |
| **Reconciliação** | `ReconciliationService` | Backend | `/api/internal/financial/reconciliation/*` |
| **Mudança de status de Payment** | `paymentStatusService.js` | Backend | `transitionPaymentStatus()` |
| **Saúde Financeira** | `ReconciliationService` + `ProfessionalFinancialService` | Backend | `/api/v2/professionals/:id/summary` + `/api/internal/financial/reconciliation/issues` |
| **Métricas de Operação** | `MetricLog` | Backend | `/admin/financial-metrics` |

---

## Hierarquia de cálculo

```text
Session (completed)
        ↓
resolveSessionFinancialValue()
        ↓
paymentStatusService.transitionPaymentStatus()  →  emite PAYMENT_STATUS_CHANGED
        ↓
unifiedFinancialService.v2.js  →  Produção / Caixa / A Receber (geral)
        ↓
commissionRule.service.js      →  Comissão por sessão
        ↓
commissionService.js           →  Comissão mensal do profissional
        ↓
ProfessionalFinancialService   →  Resultado do profissional (produção, recebido, comissão, saldo)
        ↓
ProfessionalSettlementService  →  Fechamento histórico congelado
        ↓
ReconciliationService          →  Auditoria e divergências
```

---

## O que NÃO usar mais

| Não usar | Motivo |
|---|---|
| `Session.commissionValue` | Não é confiável em produção. Comissão deve vir de `commissionRule.service.js`. |
| `Appointment` como base financeira | Sessão é a unidade financeira oficial. |
| `Package` como base de produção | Usado apenas como contexto; valor vem de `resolveSessionFinancialValue()`. |
| Cálculos manuais no frontend | Todo número financeiro vem de um service backend. |
| `Payment.findByIdAndUpdate({ status })` | Sempre usar `paymentStatusService.transitionPaymentStatus()`. |
| `Session.paymentId` como checagem única de "session tem payment" | Ponteiro legado — só escrito pelo fluxo antigo de convênio via Package (`convenioPackageController.js`). O fluxo novo (`ConvenioHandler`) nunca escreve esse campo, usa `Payment.session` como ponteiro canônico. Os dois modelos coexistem em produção (2026-07-07); qualquer auditoria de "session sem payment" precisa checar `paymentId` OU resolver via `Payment.session` antes de considerar drift. |
| `FinancialProjection` | Atualiza mas não tem consumidor oficial. |
| `TotalsSnapshot` | Atualiza mas quase não é consumido. |
| `FinancialDailySnapshot` | Histórico legado/quebrado. |

---

## Deprecações — Sprint 3.10

| Componente | Status | Ação |
|---|---|---|
| `FinancialProjection` | **DEPRECATED** | Não criar novos consumidores. Avaliar remoção na Sprint 3.11. |
| `TotalsSnapshot` | **DEPRECATED** | Não criar novos consumidores. Avaliar remoção na Sprint 3.11. |
| `FinancialDailySnapshot` | **DEPRECATED** | Não criar novos consumidores. Dados históricos podem ser migrados. |
| `back/services/financialMetrics.service.js` | **DEPRECATED** | Substituir por `unifiedFinancialService.v2.js`. |
| `back/routes/financial/cashflow.js` | **DEPRECATED** | Substituir por `/api/v2/cashflow`. |
| `back/routes/financial/dashboard.routes.js` | **LEGACY** | Migrar front para `/api/v2/financial/dashboard`, depois remover. |

---

## Payment Status — Fonte única

### API

```js
import { transitionPaymentStatus } from '../services/paymentStatusService.js';

const { payment, event, changed } = await transitionPaymentStatus(paymentId, 'paid', {
  financialDate,
  paidAt,
  paymentMethod,
  userId,
  reason: 'manual'
});
```

### Garantias

1. Atualiza `Payment.status`, `paidAt`, `financialDate` e `paymentMethod`.
2. Emite `PAYMENT_STATUS_CHANGED` via `eventPublisher`.
3. Fornece audit trail completo (`reason`, `userId`, `correlationId`).
4. Suporta transaction (`transitionPaymentStatusWithTransaction`).
5. Idempotente: se `status` não mudar, retorna `changed: false`.

### Onde já está em uso

- `services/paymentService.js`
- `services/insuranceBatchService.js`
- `routes/appointment.v2.js`
- `routes/payment.v2.js`
- `routes/Payment.js`
- `workers/paymentWorker.js`
- `domain/payment/cancelPayment.js`
- `controllers/packageController.v2.js`

### Anti-padrão a eliminar

```js
// ❌ NUNCA faça isso
await Payment.findByIdAndUpdate(paymentId, { status: 'paid' });

// ✅ SEMPRE faça isso
await transitionPaymentStatus(paymentId, 'paid', { reason: 'manual' });
```

---

## Meta Realizada — decisão de negócio (2026-09-03)

> Contrato executável: `back/contracts/FinancialSemantic.js` → `SEMANTIC.META`,
> `SEMANTIC.CASH`, `SEMANTIC.PRODUCTION`, `SEMANTIC.CONVENIO_RETROATIVO`
> (`META.base: 'CASH_MINUS_RETROATIVO'`, era `'PRODUCTION'` antes desta data —
> mudança deliberada de negócio, não desvio acidental).
> Implementação: `unifiedFinancialService.v2.js` → `calculateMetaRealizada(start, end)`.
> Esta seção é a fonte canônica desta regra — qualquer dúvida sobre o que cada
> métrica significa deve ser resolvida aqui, não em histórico de conversa ou commit.

### Definições

- **Caixa Real** — soma dos `Payment` efetivamente pagos (`status='paid'`) no
  período, pela data financeira canônica (`financialDate`, fallback `paidAt`).
  Inclui recebimentos retroativos porque o dinheiro entrou naquele mês.
- **Meta Realizada** — Caixa Real menos recebimentos de convênio referentes a
  competências anteriores (Convênio Retroativo) menos Liminar.
- **Produção** — valor dos atendimentos efetivamente realizados, baseado em
  `Session.completed` e no valor clínico canônico (`resolveSessionFinancialValue`).
  Não representa necessariamente dinheiro recebido. Independente de Meta
  Realizada — as duas convivem no dashboard, mas uma não deriva da outra.
- **Convênio Retroativo** — pagamento recebido no mês atual referente a sessão
  realizada em mês anterior. Entra no Caixa Real (o dinheiro entrou naquele
  mês); não entra na Meta Realizada.

### Regras

- Venda de pacote entra integralmente na Meta Realizada quando o pagamento ocorre.
- Sessões anteriores quitadas na criação do pacote entram normalmente, desde
  que o pagamento tenha ocorrido no mês.
- Consumo posterior do saldo de pacote representa Produção, mas não gera novo
  Caixa nem nova Meta Realizada.
- Convênio realizado e recebido no mesmo mês entra na Meta Realizada.
- Convênio realizado no mês, mas ainda não recebido, não entra na Meta Realizada.
- Recebimento de convênio de competência anterior (Convênio Retroativo) não
  entra na Meta Realizada.
- Liminar não entra na Meta Realizada, mesmo quando houver sessão realizada no período.
- Convênio sem competência determinável (sem `serviceDate`, sem
  `Appointment`/`Session` resolvíveis) não pode ser classificado silenciosamente
  como competência atual — fica isolado em `excluded.semCompetencia`.
- `porTipo` (particular/pacote/convênio/liminar) usa a mesma base canônica da
  Meta Realizada; a soma de `porTipo` é sempre igual ao total, por construção.

### Fontes da verdade

- **Caixa**: `Payment.status='paid'`, usando `financialDate`/`paidAt` conforme
  a política canônica (`financialDate` primário, `paidAt` fallback).
- **Produção**: `Session.completed`, usando o valor clínico efetivo
  (`resolveSessionFinancialValue`).
- **Competência do convênio**: `Payment.serviceDate`, com fallback canônico
  `Appointment.date` → `Session.date` quando `serviceDate` está ausente.
- **Cálculo da Meta Realizada**: exclusivamente no backend, na função canônica
  `unifiedFinancialService.v2.js#calculateMetaRealizada()`. Consumida por
  `routes/financialDashboard.v2.js` (`metas.realizado.mes`, `metas.porTipo.*`)
  e `routes/cashflow.v2.js` (`metaRealizada.total`, `.porTipo`, `.excluido`).
  Sem cache próprio — calcula fresco a cada chamada (query mede ~25-40ms em
  regime quente; ver testes, describe "custo real").
- **Frontend**: apenas apresenta o valor retornado pelo backend, sem
  recalcular ou reinterpretar a regra (cards "Meta Realizada" em
  `UnifiedCashflowTab.tsx` e `FinancialDashboardTab.tsx`).

### Alterações proibidas

- ❌ Voltar a usar Produção como valor realizado da meta.
- ❌ Somar convênio pendente à Meta Realizada.
- ❌ Calcular a meta por resíduos, como `caixa − produção`.
- ❌ Inferir antecipação de pacote por diferença entre agregados.
- ❌ Contar novamente o consumo de um pacote já pago.
- ❌ Implementar versões concorrentes da fórmula em rotas ou componentes.
- ❌ Recalcular a meta no frontend.
- ❌ Tratar convênio sem competência conhecida como competência atual.
- ❌ Alterar a regra sem atualizar contrato, documentação e testes.
- ❌ Excluir convênio retroativo por lote/NF inteira — sempre por Payment individual.
- ❌ Manter cache próprio para `calculateMetaRealizada` sem invalidá-lo em todo
  caminho de escrita de Payment — a query já é barata o suficiente pra não
  precisar de cache; se isso mudar, a invalidação tem que passar pelo mecanismo
  canônico existente (`invalidateDashboardCache()`, que cascata para
  `invalidateUFSCache()`/`invalidateUFSCacheForDates()`; `clearCashflowCache()`/
  `clearCashflowCacheForDates()`, que também limpa Redis).
- ❌ `models/Payment.js` (model de domínio) importar `unifiedFinancialService.v2.js`
  (serviço de dashboard) ou qualquer serviço de camada superior — causa um
  ciclo `Payment → UnifiedFinancialService → Payment` (incidente já corrigido:
  uma versão anterior desta função invalidava cache via hooks Mongoose em
  `models/Payment.js`, que precisavam desse import; a correção definitiva foi
  remover cache e hooks — a função recalcula fresca a cada chamada).

### Matriz de eventos

| Evento | Caixa Real | Meta Realizada | Produção |
|---|---:|---:|---:|
| Pagamento particular do mês | Sim | Sim | Quando a sessão ocorrer |
| Venda de pacote paga | Sim | Sim | Não na venda |
| Consumo posterior do pacote | Não novamente | Não novamente | Sim |
| Convênio realizado e recebido no mês | Sim | Sim | Sim |
| Convênio do mês ainda pendente | Não | Não | Sim |
| Convênio antigo recebido agora | Sim | Não | Já pertence ao mês da sessão |
| Sessão de Liminar | Não novamente | Não | Sim |

### Testes que protegem esta decisão

`back/services/__tests__/calculateMetaRealizada.test.js` (fixtures fictícias,
sem dados reais de paciente):

- venda de pacote + sessões anteriores quitadas na criação do pacote (mesmo cenário)
- consumo de pacote não gera Meta Realizada duplicada
- convênio retroativo (competência anterior) excluído
- NF com competências mistas (sessão antiga + atual na mesma guia) — exclui só a antiga
- convênio realizado e recebido no mesmo mês — incluído
- convênio do mês ainda pendente — não aparece nem incluído nem excluído
- convênio sem competência determinável (sem `serviceDate`/`Appointment`/`Session`) — excluído explicitamente, nunca tratado como atual
- Liminar excluído mesmo com sessão paga no período
- `porTipo` soma exatamente o total
- limites do mês no fuso `America/Sao_Paulo` (início e fim)
- ausência de N+1 no fallback de competência
- todo write path (save/findOneAndUpdate/updateMany/deleteOne/deleteMany/bulkWrite/insertMany) refletindo sem cache

`back/tests/integration/insuranceBatchReceive.cacheInvalidation.integration.test.js`
— fluxo real de recebimento em lote de convênio (`receiveInsuranceBatch` →
`Payment.bulkWrite`) refletindo na Meta Realizada e invalidando o cache Redis
do endpoint de cashflow (`clearCashflowCache`).

---

## Sinal + saldo (Payment.paymentRole) — decisão de negócio (2026-09-04)

> Contexto: pré-agendamento particular (ex: neuropediatria) que cobra um sinal
> na hora de marcar (ex: R$50 de uma consulta de R$500) e o restante (R$450)
> no dia. Implementação: `domain/payment/depositBalance.js`.

### Por que 2 Payments, não 1 com `paidAmount`/`remainingAmount`

Caixa Real e Meta Realizada (`calculateCashForDashboard` e afins, acima) somam
`Payment.amount` diretamente via `Payment.aggregate({status:'paid'})` —
**nunca leem o FinancialLedger**. Um único Payment com um campo `paidAmount`
interno ficaria invisível pro Caixa enquanto seu `status` não fosse `'paid'`
— o sinal recebido de verdade não apareceria no caixa do dia em que entrou.
Por isso o desenho é dois documentos `Payment` distintos, cada um virando
`'paid'` na sua própria data real; a soma automática do Caixa já funciona sem
tocar na fórmula canônica (mudar essa fórmula é proibido — ver seção acima).

### `Payment.paymentRole`

Eixo ortogonal a `Payment.kind` — `kind` descreve a **natureza** do Payment
(sessão avulsa / pacote / quitação), `paymentRole` descreve o **papel** dele
dentro de uma mesma obrigação financeira parcelada. Os dois nunca se
confundem: um Payment de saldo particular continua `kind='session_payment'`
igual a qualquer outro, só que com `paymentRole='balance'`.

| `paymentRole` | Significado | Quando existe |
|---|---|---|
| `standard` | Comportamento legado — 1 Payment cobre a consulta inteira | Toda consulta particular sem sinal (default) |
| `deposit` | Sinal recebido no pré-agendamento | Só quando a consulta foi parcelada em sinal+saldo |
| `balance` | Saldo restante (total − sinal) | Idem — sempre em par com um `deposit` |

`Appointment.payment` **sempre** aponta pro Payment que representa a
obrigação principal — `balance` quando há sinal, `standard` quando não há.
**Nunca** aponta pro `deposit`. Todo código que precisa "achar o payment do
appointment pra liquidar/editar/cancelar" pode continuar usando essa
referência; quem precisa achar especificamente o sinal usa
`findDepositPayment()` (por `paymentRole='deposit'`), nunca a referência
singular.

### Matriz de eventos (consulta R$500, sinal R$50)

| Momento | Caixa Real / Meta Realizada | Produção | A Receber |
|---|---:|---:|---:|
| Sinal pago no pré-agendamento | +R$50 | R$0 | R$450 |
| Sessão concluída (saldo ainda não pago) | continua R$50 | +R$500 (ao concluir) | R$450 |
| Saldo pago | +R$450 (total R$500) | continua R$500 (sem nova produção) | R$0 |

Regras:
- O sinal entra no Caixa/Meta na **data real em que foi recebido** — nunca é
  reclassificado retroativamente quando o saldo é pago depois.
- A consulta produz R$500 **uma única vez**, no `completed` da sessão —
  nunca no recebimento do sinal nem do saldo.
- `particularHandler.js` (settlement no `complete`) sempre cobra só o
  **saldo restante** (`sessionValue − sinal já pago`), nunca o valor cheio de
  novo — senão o sinal seria contado duas vezes no Caixa.
- Editar o valor total da consulta (`updateAppointmentCommand.js`) só pode
  alterar o saldo; o sinal já pago é imutável por esse caminho. Novo total
  menor que o sinal já pago é rejeitado (`DepositExceedsTotalError`,
  domain/payment/depositBalance.js).
- `completeSessionV2` (`completeSessionService.v2.js`) com `addToBalance:true`
  (fiado): quando existe um sinal ativo, `sessionValue` usado pra Produção e
  `Session.sessionValue` continua sendo o TOTAL real da consulta — nunca
  `balanceAmount` (que é só o que falta cobrar). Achado real (2026-09-04): a
  semântica legada do fiado avulso usa `balanceAmount` como se fosse o valor
  clínico inteiro da sessão; com sinal, isso perderia o sinal da Produção e
  faria o particularHandler descontar o sinal duas vezes (450-50=400 em vez
  de 450). `Appointment.balanceAmount` (campo de "saldo devedor" exibido)
  também desconta o sinal já pago, pelo mesmo motivo.
- Payment financeiramente realizado (`status='paid'`) NUNCA é hard-deleted —
  nem ao excluir o Appointment inteiro (`deleteAppointmentCommand.js`) nem via
  admin (`DELETE /api/v2/payments/:id`). Vira `'canceled'` via
  `transitionPaymentStatus()` (dispara a reversão do ledger automaticamente),
  preservando o documento e o histórico. Só Payment sem dinheiro real por trás
  (nunca chegou a `'paid'`) é removido fisicamente.

### Índice único

`unique_active_payment_per_appt_billingtype_role`
(`{appointment, billingType, paymentRole}`, parcial pra status ativos) —
substituiu `unique_active_payment_per_appt_billingtype` (`{appointment,
billingType}`). Continua garantindo "nunca duplica" — só que agora por papel:
no máximo 1 `deposit` e 1 `balance`/`standard` ativos por consulta, nunca 2 do
mesmo papel. Ver `scripts/migrations/2026-09-04-payment-role-deposit-balance.js`
para o backfill (`paymentRole='standard'` em todo Payment legado) e troca de
índice em produção.

> ⚠️ Achado durante essa migração: o índice antigo combinava `sparse:true` com
> `partialFilterExpression` e usava `$ne`/`$nin` dentro do filtro parcial —
> ambos rejeitados pelo MongoDB (erro 67, CannotCreateIndex). Ou seja, é bem
> provável que esse índice nunca tenha sido de fato criado em produção, só
> declarado no schema — mesma classe de risco já documentada em
> `scripts/migrations/2026-08-26-financial-ledger-reversal-index.js`. O índice
> novo usa `$type`/`$in` (mesmo padrão do índice irmão
> `unique_active_convenio_payment_per_session`), sem `sparse`.

---

## Como adicionar uma nova métrica financeira

1. Pergunte: **esta métrica já existe em algum dos serviços oficiais?**
2. Se sim, **consume** o valor pronto.
3. Se não, **adicione a lógica no service oficial correto**, nunca num controller ou no frontend.
4. Sempre adicione `executionTimeMs` e contadores via `logMetric()`.
5. Documente aqui.
