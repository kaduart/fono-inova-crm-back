# Complete Billing Migration

> **Data:** 2026-07-08 (última atualização)  
> **Status:** **Concluído**

A migração foi concluída. Existe apenas um fluxo canônico para criação e completação de agendamentos.

---

## Resultado final

### Frontend

```text
appointmentService.complete()
    ↓
PATCH /api/v2/appointments/:id/complete
    ↓
Route
    ↓
CompleteCommand / completeInsuranceAppointmentCommand
    ↓
services/completeSessionService.v2.js
    ↓
Billing Handler
    ↓
Payment + Package + Guide + Ledger + Balance
    ↓
saveToOutbox()
    ↓
OutboxDispatcher
    ↓
BullMQ
    ↓
Projection Workers
```

### Criação de agendamento

```text
CreateAppointmentCommand
    ↓
BillingOrchestrator
    ↓
    +----------------+----------------+
    |                |                |
insuranceBilling   appointmentHybrid  handleAdvancePayment
(convenio)         (particular/       (em transição para
                   pacote)            command dedicado)
```

### Conclusão de agendamento

```text
PATCH /api/v2/appointments/:id/complete
    ↓
completeSessionService.v2.js
    ↓
    +-- determineBillingType()
    |
    +----------------+----------------+----------------+
    |                |                |                |
ConvenioHandler  ParticularHandler  LiminarHandler   Package logic
```

Não existe mais `POST /complete-insurance`. O backend detecta convênio e delega internamente para o orquestrador.

---

## Decisões arquiteturais aplicadas

> **O frontend não determina billing.**

- ✅ Frontend sempre chama `PATCH /api/v2/appointments/:id/complete`.
- ✅ Backend resolve `billingType` a partir do estado do agendamento.
- ✅ Contrato de resposta normalizado (`CompleteAppointmentResult`).
- ✅ Fallback V1 removido.
- ✅ Placeholders de billing (`individualBilling.js`, `packageBilling.js`, `advanceBilling.js`) removidos.
- ✅ Eventos de domínio publicados via Outbox (`saveToOutbox`).

---

## Histórico

Esta seção registra o estado anterior para referência.

### Problemas originais

1. **Duas arquiteturas para o mesmo domínio**: create usava `BillingOrchestrator` com estratégias; complete usava `determineBillingType` + handlers.
2. **Frontend decidendo regra financeira**: `appointmentService.complete` escolhia endpoint baseado em `billingType`, `paymentMethod` e `insuranceProvider`.
3. **Contrato de retorno inconsistente**: `complete` retornava `AxiosResponse` em alguns fluxos e `Appointment` puro em outros.
4. **Múltiplas implementações de decisão financeira** espalhadas.
5. **Eventos publicados por múltiplos mecanismos**: `publishEvent`, `appendEvent`, `saveToOutbox`.

### Etapas executadas

| PR | Descrição | Status |
|---|---|---|
| 3.2-A.1 | Normalizar contrato de retorno do `complete` | ✅ |
| 3.2-A.2 | Backend assumir roteamento; frontend chamar sempre `PATCH /complete` | ✅ |
| 1.1 | Limpeza de código morto (backups, rotas, services, workers) | ✅ |
| 1.2 | Consolidação arquitetural: remover `complete-insurance`, fallback V1, placeholders | ✅ |
| 2.1 | Unificação da Outbox: schema único, dispatcher ativo | ✅ |
| 2.2 | Migração de publicadores clínicos para `saveToOutbox` | ✅ |
| 2.x | Remoção de eventos mortos e normalização de naming | ✅ |

---

## Pendências pós-migração

| PR | Descrição | Status |
|---|---|---|
| 2.3 | Consolidar projeções: remover `syncAffectedViews` residual | ⏳ |
| 2.4 | Unificar publicação de pagamentos; remover safety net `Payment.js` | ⏳ |
| 4 | Consolidar `complete` no `BillingOrchestrator` (estratégias de complete) | ⏳ |

---

## Links

- [`CANONICAL_FLOW.md`](./CANONICAL_FLOW.md)
- [`CANONICAL_FILES.md`](./CANONICAL_FILES.md)
- [`ARCHITECTURE_RULES.md`](./ARCHITECTURE_RULES.md)
- [`EVENT_PROJECTION_INVENTORY.md`](./EVENT_PROJECTION_INVENTORY.md)
