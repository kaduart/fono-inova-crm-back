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

## Como adicionar uma nova métrica financeira

1. Pergunte: **esta métrica já existe em algum dos serviços oficiais?**
2. Se sim, **consume** o valor pronto.
3. Se não, **adicione a lógica no service oficial correto**, nunca num controller ou no frontend.
4. Sempre adicione `executionTimeMs` e contadores via `logMetric()`.
5. Documente aqui.
