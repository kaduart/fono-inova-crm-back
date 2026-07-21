# Fluxo Canônico de Agendamentos

> **Versão:** 1.2  
> **Data:** 2026-07-15  
> **Status:** Oficial — único caminho válido para operações de agendamento.

Este documento define o **fluxo único** de criação, completação, atualização, cancelamento e leitura de agendamentos no CRM.

**Regra de ouro:** tudo que está fora deste fluxo é legado, transição ou experimental. Não implementar novas features fora destes caminhos sem revisão arquitetural explícita.

---

## 0. Pipeline de eventos obrigatório

Toda alteração de domínio que deva refletir em projeções **obrigatoriamente** segue:

```text
Command / Service / Controller
    ↓
MongoDB Transaction
    ↓
saveToOutbox()
    ↓
Commit
    ↓
OutboxDispatcher (polling)
    ↓
BullMQ
    ↓
Projection Worker
    ↓
Read Model (View)
```

A API pública do domínio é:

```js
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';

await saveToOutbox({
  eventType: 'APPOINTMENT_COMPLETED',
  payload: { appointmentId, patientId, ... },
  aggregateType: 'appointment',
  aggregateId: appointmentId
}, mongoSession);
```

`publishEvent()` e `appendEvent()` são infraestrutura interna. **Não devem ser chamados por código de domínio, controllers, routes, models ou workers.**

---

## 1. CREATE — Criar agendamento

```text
Frontend
    ↓
POST /api/v2/appointments
    ↓
routes/appointment.v2.js
    ↓
services/appointmentV2Service.js
    ↓
services/appointment/commands/createAppointmentCommand.js
    ↓
services/appointmentHybridService.js        (particular / pacote)
    OU
services/billing/BillingOrchestrator.js     (convênio)
    ↓
Appointment + Session + Payment + Guide/Pacote
    ↓
saveToOutbox(APPOINTMENT_CREATED | SESSION_COMPLETED | PAYMENT_STATUS_CHANGED)
```

### Caminhos de billing no CREATE

| Tipo | Responsável |
|------|-------------|
| Particular avulso / pacote | `appointmentHybridService.js` |
| Convênio | `BillingOrchestrator.js` → `insuranceBilling.js` |
| Pagamento antecipado | `helpers/handleAdvancePayment.js` *(em transição para command)* |

---

## 2. COMPLETE — Completar agendamento

```text
Frontend
    ↓
PATCH /api/v2/appointments/:id/complete
    ↓
routes/appointment.v2.js
    ↓
CompleteCommand / completeInsuranceAppointmentCommand
    ↓
services/completeSessionService.v2.js
    ↓
Billing Handler
    ↓
    ├── particular   → services/completeSession/handlers/particularHandler.js
    ├── convenio     → services/completeSession/handlers/convenioHandler.js
    └── liminar      → services/completeSession/handlers/liminarHandler.js
    ↓
saveToOutbox(SESSION_COMPLETED | PAYMENT_STATUS_CHANGED | APPOINTMENT_COMPLETED)
```

### Regras do COMPLETE

- **Apenas um endpoint:** `PATCH /api/v2/appointments/:id/complete`.
- O **frontend não decide o billing**; o backend resolve a partir do estado do agendamento.
- Não existe mais rota paralela como `POST /complete-insurance` ou fallback V1.

---

## 3. UPDATE — Atualizar agendamento

```text
Frontend
    ↓
PATCH /api/v2/appointments/:id
    ↓
routes/appointment.v2.js
    ↓
services/appointment/commands/updateAppointmentCommand.js
    ↓
Appointment + Session + Payment
    ↓
saveToOutbox(APPOINTMENT_UPDATED | PAYMENT_STATUS_CHANGED)
```

> **Nota:** projeções de pacote/pacote são atualizadas pelos workers canônicos. Não chamar `syncAffectedViews()` diretamente para eventos que já têm worker dedicado.

---

## 4. CANCEL — Cancelar agendamento

```text
Frontend
    ↓
PATCH /api/v2/appointments/:id/cancel
    ↓
routes/appointment.v2.js
    ↓
services/appointment/commands/cancelAppointmentCommand.js (síncrono, dentro de transação)
    ↓
Appointment + Session + Payment + Package/Guide reversal
    ↓
saveToOutbox(APPOINTMENT_CANCELLED | PAYMENT_STATUS_CHANGED)
```

---

## 5. PRÉ-AGENDAMENTO (TRIAGEM) — Confirmar

> `pre_agendado` é um estado de `operationalStatus` do próprio `Appointment`, não uma entidade separada (isso foi unificado antes de 2026-07). `preAgendamentoTriage.routes.js` é uma fachada especializada de triagem comercial sobre o mesmo `Appointment` — não cria um domínio novo.

```text
Frontend (crm/front, tela da secretária)
    ↓
POST /api/v2/pre-appointments/:id/confirm
    ↓
routes/preAgendamentoTriage.routes.js
    ↓
services/appointmentV2Service.js
    ↓
services/appointment/commands/confirmPreAgendamentoCommand.js
    ↓
MESMO Appointment (in-place: pre_agendado → scheduled, mesmo _id)
    + Session (criada só se ainda não existir)
    + Payment (criado só se ainda não existir e houver valor)
    ↓
saveToOutbox(APPOINTMENT_UPDATED)
```

**Antes de 2026-07-15**, esse endpoint criava um `Appointment` novo (via `appointmentHybridService.create()`) e cancelava o pré-agendamento original, deixando dois documentos para o mesmo atendimento — padrão que já causou duplicação real de registros em produção num consumidor externo. Não replicar esse padrão em nenhum outro fluxo.

Outros endpoints de `preAgendamentoTriage.routes.js` (`GET /`, `/discard`, `/contact`, `/assign`, `/stats/dashboard`) seguem ativos para a triagem comercial — ver `CANONICAL_FILES.md` para o detalhamento completo e o que já foi removido por falta de uso.

---

## 6. READ — Leitura

```text
Frontend
    ↓
GET /api/v2/appointments/*     → routes/appointmentReads.js
GET /api/v2/patients/*         → PatientsView
GET /api/v2/packages/*         → PackagesView
GET /api/v2/payments/*         → PaymentsView
GET /api/v2/insurance-guides/* → InsuranceGuideView
```

### Read Models oficiais

| View | Arquivo | Uso |
|------|---------|-----|
| PatientsView | `models/PatientsView.js` | Lista, busca e detalhe de pacientes |
| PackagesView | `models/PackagesView.js` | Lista e detalhe de pacotes |
| PaymentsView | `models/PaymentsView.js` | Lista e detalhe de pagamentos |
| InsuranceGuideView | `models/InsuranceGuideView.js` | Guias de convênio |

---

## 7. O que NÃO faz parte do fluxo

| Elemento | Motivo |
|----------|--------|
| `POST /api/v2/appointments/:id/complete-insurance` | **Removida**. Convênio usa `PATCH /complete`. |
| Fallback V1 dentro de `PATCH /complete` | **Removido**. |
| `services/completeFallbackMetrics.js` | Métricas do fallback V1. **Removido**. |
| `services/appointmentProxyService.js` | Referenciava módulos inexistentes; não fazia parte do fluxo ativo. **Removido**. |
| `domains/clinical/services/appointmentService.js` | API paralela não plugada nas rotas V2. `cancelAppointment()` **removido**; `createAppointment()` mantido (usado em teste e2e). |
| `services/appointmentStateOrchestrator.js` | Duplica sync já feito por `updateAppointmentCommand.js` — mas ainda é chamado por ele. Não remover sem revisar essa duplicação. |
| `appendEvent()` / `EventStore` como publicador | Use `saveToOutbox()`. |
| `publishEvent()` chamado por domínio | Use `saveToOutbox()`. |
| `GET /api/v2/pre-appointments/:id`, `POST /api/v2/pre-appointments` (criar), `PATCH /api/v2/pre-appointments/:id`, `POST /api/v2/pre-appointments/:id/cancel` | **Removidos em 2026-07-15**. Sem consumidor; equivalente 100% coberto por `appointment.v2.js`. |
| Padrão antigo do `confirm` de pré-agendamento (criar Appointment novo + cancelar original) | **Removido em 2026-07-15**. Ver seção 5. |
| `routes/preAgendamento.engine.js` | **Removido em 2026-07-15**. Conteúdo ativo migrado para `routes/preAgendamentoTriage.routes.js` (mesma URL, mesmo contrato). |
| `workers/preAgendamentoWorker.js` | **Removido em 2026-07-15**. Estava dormente — evento que o alimentava nunca chegava à fila. |
| `EventTypes.PREAGENDAMENTO_CREATED` / `PREAGENDAMENTO_IMPORTED`, fila `preagendamento-processing` | **Removidos em 2026-07-15**. Ver `EVENT_PROJECTION_INVENTORY.md` seção 2.9. |

---

## 8. Decisões arquiteturais

1. **Um único endpoint por operação.** Não criar rotas alternativas para o mesmo comando.
2. **Frontend não decide billing.** O backend resolve `particular` / `convenio` / `liminar` a partir dos dados do agendamento.
3. **Writes via commands/services; reads via views.** Não espelhar lógica de escrita em endpoints de leitura.
4. **Sem fallbacks permanentes.** Fallbacks são ferramentas de rollout, não arquitetura.
5. **Sem implementações paralelas.** Não manter duas versões do mesmo handler.
6. **Todo evento de domínio passa pelo Outbox.** Não publicar diretamente em fila.

---

## 9. Links relacionados

- [`CANONICAL_FILES.md`](./CANONICAL_FILES.md) — lista exata dos arquivos canônicos.
- [`ARCHITECTURE_RULES.md`](./ARCHITECTURE_RULES.md) — regras para futuras PRs.
- [`EVENT_PROJECTION_INVENTORY.md`](./EVENT_PROJECTION_INVENTORY.md) — mapeamento evento → fila → worker → view.
- [`complete-billing-migration.md`](./complete-billing-migration.md) — histórico da migração de billing.
