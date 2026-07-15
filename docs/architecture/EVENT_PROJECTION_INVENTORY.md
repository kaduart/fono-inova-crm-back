# Inventário do Pipeline de Eventos e Projeções

> **Data:** 2026-07-08  
> **Status:** Pipeline único estabelecido — cleanup de eventos mortos concluído  
> **Escopo:** `/home/user/projetos/crm/back/`

---

## 0. Estado atual

### Pipeline oficial

```text
Command / Service / Controller
    ↓
MongoDB Transaction
    ↓
saveToOutbox()
    ↓
Commit
    ↓
OutboxDispatcher (polling da collection outboxes)
    ↓
BullMQ (roteamento via eventToQueueMap)
    ↓
Projection Worker
    ↓
Read Model (View)
```

### Componentes principais

| Componente | Status |
|------------|--------|
| `infrastructure/outbox/OutboxModel.js` | ✅ Modelo único da collection `outboxes` |
| `infrastructure/outbox/outboxPattern.js` | ✅ API pública `saveToOutbox()` |
| `infrastructure/outbox/OutboxDispatcher.js` | ✅ Ponto de entrada do dispatcher |
| Grupo `outbox` em `workers/registry.js` | ✅ Dispatcher registrado |
| `models/Outbox.js` | 🗑️ Removido |
| `workers/outboxWorker.js` | 🗑️ Removido |

### Mecanismos de publicação

| Mecanismo | O que faz | Status |
|-----------|-----------|--------|
| `outboxPattern.saveToOutbox()` | Salva evento na Outbox dentro da transação | ✅ **API pública canônica** |
| `eventPublisher.publishEvent()` | Salva no `EventStore` + publica em fila BullMQ | ⚠️ `@deprecated`; usado apenas internamente pelo `OutboxDispatcher` e por código legado |
| `eventStoreService.appendEvent()` | Apenas persiste no `EventStore` | ⚠️ `@deprecated`; eventos ficam presos se usados sozinhos |

---

## 1. Problemas resolvidos

| Problema | Resolução |
|----------|-----------|
| Eventos clínicos presos no EventStore | ✅ `appointmentService.js`, `sessionService.js`, `patientService.js`, `completeSessionService.v2.js`, `paymentStatusService.js` e `autoInsuranceSettlementService.js` migrados para `saveToOutbox` |
| Outbox sem worker poller ativo | ✅ `OutboxDispatcher` faz polling da collection `outboxes` e publica nas filas BullMQ via `eventToQueueMap` |
| Duas collections `Outbox` | ✅ `models/Outbox.js` removido; schema unificado em `infrastructure/outbox/OutboxModel.js` |
| Eventos mortos no catálogo | ✅ Removidos 63 eventos mortos de `eventPublisher.js`, incluindo `APPOINTMENT_COMPLETED_DOMAIN`, `RECONCILIATION_ALERT`, `PAYMENT_PARTIAL`, `INSURANCE_GUIDE_CONSUMED`, `LIMINAR_REVENUE_RECOGNIZED` |
| Inconsistência de naming `CANCELED`/`CANCELLED` | ✅ Normalizado para `APPOINTMENT_CANCELLED` (2 L) em catálogo, publicadores e consumidores |
| Bug crítico em `completeOrchestratorWorker.js` | ✅ `APPOINTMENT_COMPLETED_DOMAIN` inexistente substituído por `APPOINTMENT_COMPLETED` |
| Publicadores legados de pacote/liminar/guia | ✅ `controllers/therapyPackageController.js`, `routes/patient.v2.js`, `controllers/packageController.v2.js` migrados para `saveToOutbox` |
| Projeção síncrona duplicada em update | ✅ `updateAppointmentCommand.js` deixou de chamar `syncAffectedViews` para `appointment.updated`; projeção fica com o worker canônico |

---

## 2. Eventos principais

### 2.1 `APPOINTMENT_CREATED`

| Campo | Valor |
|-------|-------|
| **Publicadores** | `services/appointmentHybridService.js`; `services/createAppointmentService.js` |
| **Mecanismo** | `saveToOutbox` |
| **Payload** | `appointmentId, sessionId, paymentId?, patientId, doctorId, packageId?, billingType, amount, paymentStrategy, hasPayment` |
| **Consumidores ativos** | `appointmentWorker.js`, `patientProjectionWorker.js`, `clinicalOrchestrator.js` |
| **Idempotência** | Sim (`eventId` único no Outbox) |
| **Retry** | BullMQ via OutboxDispatcher |
| **Status** | 🟢 |

### 2.2 `APPOINTMENT_COMPLETED`

| Campo | Valor |
|-------|-------|
| **Publicadores** | `services/completeSessionService.v2.js`; `workers/completeOrchestratorWorker.js` |
| **Mecanismo** | `saveToOutbox` |
| **Payload** | `appointmentId, patientId, doctorId, sessionId, packageId, billingType, sessionValue, completedAt` |
| **Consumidores ativos** | `completeOrchestratorWorker.js`, `syncMedicalWorker.js`, `patientProjectionWorker.js`, `integrationOrchestratorWorker.js`, `leadOrchestratorWorker.v2.js` |
| **Idempotência** | Sim (`eventId` único no Outbox) |
| **Retry** | BullMQ via OutboxDispatcher |
| **Status** | 🟢 |

### 2.3 `APPOINTMENT_CANCELLED`

| Campo | Valor |
|-------|-------|
| **Publicadores** | `services/appointment/commands/cancelAppointmentCommand.js` (`workers/cancelOrchestratorWorker.v2.js` removido em 2026-07-15 — código morto, nunca era alcançado) |
| **Mecanismo** | `saveToOutbox` |
| **Consumidores ativos** | `syncMedicalWorker.js`, `patientProjectionWorker.js`, `clinicalOrchestrator.js`, `packageProjectionWorker.js` |
| **Idempotência** | Sim |
| **Retry** | BullMQ via OutboxDispatcher |
| **Status** | 🟢 Naming unificado para `APPOINTMENT_CANCELLED` |

### 2.4 `SESSION_COMPLETED`

| Campo | Valor |
|-------|-------|
| **Publicadores** | `domains/clinical/services/sessionService.js`; `services/completeSessionService.v2.js` |
| **Mecanismo** | `saveToOutbox` |
| **Consumidores ativos** | `packageProjectionWorker.js`, `patientProjectionWorker.js`, `clinical-session`, `integration-orchestrator`, `billingConsumerWorker.js` |
| **Idempotência** | Sim (`eventId` único no Outbox) |
| **Retry** | BullMQ via OutboxDispatcher |
| **Status** | 🟢 |

### 2.5 Eventos de pagamento

| Evento | Publicadores | Consumidores | Status |
|--------|--------------|--------------|--------|
| `PAYMENT_RECEIVED` | `workers/paymentWorker.js`; `routes/payment.v2.js` | `balance-update`, `patient-projection` | 🟡 Ainda usa `publishEvent` em alguns pontos |
| `PAYMENT_CREATED` | `billingConsumerWorker.js`; `models/Payment.js` post-save; `projections/paymentsProjection.js` | `patient-projection` | 🟡 Múltiplas fontes |
| `PAYMENT_UPDATED` | `routes/payment.v2.js` | `balance-update`, `patient-projection` | 🟡 Ainda usa `publishEvent`/`appendEvent` |
| `PAYMENT_STATUS_CHANGED` | `services/paymentStatusService.js` (`saveToOutbox`); `models/Payment.js` post-save (safety net) | `balance-update`, `patient-projection` | 🟡 Fonte canônica migrada; safety net ainda ativa |
| `PAYMENT_DELETED` | `projections/paymentsProjection.js` (handler) | `balance-update`, `patient-projection` | 🟡 Publicador real não encontrado |

### 2.6 Eventos de pacote

| Evento | Publicadores | Consumidores | Status |
|--------|--------------|--------------|--------|
| `PACKAGE_CREATED` | `packageProcessingWorker.js`; `packageController.v2.js`; `therapyPackageController.js` | `package-projection`, `package-validation`, `patient-projection` | 🟢 Canônico via Outbox |
| `PACKAGE_UPDATED` | `services/billing/commands/updatePackageCommand.js` (via `PUT /api/v2/packages/:id`) | `package-projection`, `patient-projection` | 🟢 Canônico via Outbox — verificado 2026-07-09: `package-validation` não tem handler para este evento, removido da lista |
| `PACKAGE_CREDIT_CONSUMED` | `packageValidationWorker.js` | `package-validation`, `patient-projection` | 🟢 |
| `PACKAGE_CANCELLED` | Rotas/controllers | `package-projection`, `package-validation`, `patient-projection` | 🟢 Canônico via Outbox |

### 2.7 Eventos de paciente

| Evento | Publicadores | Consumidores | Status |
|--------|--------------|--------------|--------|
| `PATIENT_CREATED` | `patientWorker.js`; `routes/importFromAgenda.js`; `routes/patient.v2.js` | `patient-projection` | 🟢 |
| `PATIENT_UPDATED` | `patientWorker.js`; `routes/patient.v2.js` | `patient-projection` | 🟢 |
| `PATIENT_REGISTERED` | `domains/clinical/services/patientService.js` (`saveToOutbox`) | `patient-projection` | 🟢 |
| `PATIENT_PHONE_CHANGED` | `domains/clinical/services/patientService.js` (`saveToOutbox`) | `patient-projection` | 🟢 |
| `PATIENT_DATA_CONFIRMED` | `domains/clinical/services/patientService.js` (`saveToOutbox`) | `patient-projection` | 🟢 |

### 2.8 Eventos de guia de convênio e liminar

| Evento | Publicadores | Consumidores | Status |
|--------|--------------|--------------|--------|
| `INSURANCE_GUIDE_CREATED` | `routes/insuranceGuides.v2.js` | `patient-projection` | 🟢 Canônico via Outbox |
| `LIMINAR_CONTRACT_CREATED` | `controllers/liminarContractController.js` | `patient-projection` | 🟢 Canônico via Outbox |

### 2.9 Eventos de pré-agendamento (dormentes — confirmado em 2026-07-15)

| Evento | Publicadores | Consumidores | Status |
|--------|--------------|--------------|--------|
| `PREAGENDAMENTO_CREATED` | Nenhum desde 2026-07-15 (publicador era `POST /api/v2/pre-appointments`, removido por falta de uso) | `workers/preAgendamentoWorker.js:handleCreated` | 🔴 Dormente — worker não recebe mais jobs |
| `PREAGENDAMENTO_IMPORTED` | Nenhum desde 2026-07-15 (publicador era o `/confirm` legado, substituído por `confirmPreAgendamentoCommand` que usa `saveToOutbox(APPOINTMENT_UPDATED)`) | `workers/preAgendamentoWorker.js:handleImported` | 🔴 **Já era dormente antes da migração** — não está mapeado em `eventToQueueMap`, toda chamada antiga já lançava `UNKNOWN_EVENT_TYPE` (engolido por `.catch()`). O worker nunca era de fato acionado por este evento. |
| `PREAGENDAMENTO_STATUS_CHANGED` | Nenhum publicador encontrado em todo o código | `workers/preAgendamentoWorker.js:handleStatusChanged` | 🔴 Dormente desde sempre (confirmado por grep exaustivo) |

`workers/preAgendamentoWorker.js` inteiro está dormente hoje. Não removido ainda — aguardando período de observação (decisão do usuário, 2026-07-15) antes de eliminar o worker, o router `routes/preAgendamento.engine.js`, e as entradas `PREAGENDAMENTO_*` de `EventTypes`/`eventToQueueMap`.

---

## 3. Views / Read Models

### 3.1 `PatientsView`

| Aspecto | Detalhe |
|---------|---------|
| **Fonte da verdade** | `Patient` + `Appointment` + `Payment` + `Package` + `LiminarContract` |
| **Atualizadores** | `patientProjectionWorker.js`, `crons/patientConsistency.cron.js` |
| **Rebuild** | `rebuildAllViews()` em `patientProjectionService.js`; scripts `rebuild-all-patient-views.js`, `rebuild-single-patient-view.js` |
| **Múltiplos writers** | Não |
| **Status** | 🟢 |

### 3.2 `PackagesView`

| Aspecto | Detalhe |
|---------|---------|
| **Fonte da verdade** | `Package` + `Session` + `Appointment` |
| **Atualizadores** | `packageProjectionWorker.js` (canônico), `syncAffectedViews()` (residual). (`cancelOrchestratorWorker.v2.js` removido em 2026-07-15 — nunca era alcançado, então nunca escreveu de fato aqui.) |
| **Rebuild** | `buildPackageView()`; scripts `rebuild-packages-view.js`, `rebuild-package-view.js` |
| **Múltiplos writers** | **Sim** — dois caminhos diferentes |
| **Status** | 🟡 **Risco de inconsistência** |

### 3.3 `PaymentsView`

| Aspecto | Detalhe |
|---------|---------|
| **Fonte da verdade** | `Payment` |
| **Atualizadores** | `projections/paymentsProjection.js` (chamado por `paymentWorker.js` e `routes/payments.v2.js`) |
| **Rebuild** | `rebuildPaymentsProjection()` |
| **Múltiplos writers** | Não |
| **Status** | 🟡 OK, mas sem worker fila dedicado exclusivamente a esta view |

### 3.4 `InsuranceGuideView` / `InsuranceBatchView`

| Aspecto | Detalhe |
|---------|---------|
| **Fonte da verdade** | `InsuranceGuide` / `InsuranceBatch` |
| **Atualizadores** | `domains/billing/workers/insuranceOrchestratorWorker.js` |
| **Rebuild** | **Não encontrado** |
| **Múltiplos writers** | Não |
| **Status** | 🟡 Sem mecanismo de recuperação documentado |

### 3.5 Projeções financeiras

| Projeção | Atualizador | Rebuild | Observação |
|----------|-------------|---------|------------|
| `TotalsSnapshot` | `totalsWorker.js` | Sim | Ativo |
| `FinancialProjection` | `financialSnapshotWorker.v2.js`, `financialProjection.js` | Não | Chamado inline |
| Admin Dashboard cache | `eventPublisher.js` (invalidação inline) | N/A | Fora do pipeline canônico |

---

## 4. Pendências

| # | Descrição | Prioridade | PR alvo |
|---|-----------|------------|---------|
| 1 | Remover chamadas residuais de `syncAffectedViews` para views com worker dedicado | Alta | 2.3 |
| 2 | Remover safety net post-save de `Payment.js` após validação completa | Alta | 2.4 |
| 3 | Migrar `PAYMENT_RECEIVED`, `PAYMENT_CREATED`, `PAYMENT_UPDATED` para `saveToOutbox` | Alta | 2.4 |
| 4 | Documentar/criar mecanismo de rebuild para `InsuranceGuideView` / `InsuranceBatchView` | Média | 2.5 |
| 5 | Criar evento genérico `REBUILD_VIEW_REQUESTED { viewName, entityId }` | Média | 2.5 |
| 6 | Mover scripts de rebuild para commands reutilizáveis | Baixa | 2.6 |
| 7 | Remover `workers/preAgendamentoWorker.js`, `routes/preAgendamento.engine.js` e `PREAGENDAMENTO_*` de `EventTypes`/`eventToQueueMap` (dormentes, ver 2.9) | Baixa — aguardando período de observação | — |

---

## 5. Decisão arquitetural

O pipeline único foi decidido e implementado:

> **Transaction MongoDB → Outbox (`saveToOutbox`) → OutboxDispatcher → BullMQ → Projection Worker → Read Model**

- `publishEvent` e `appendEvent` continuam existindo como infraestrutura interna, mas **não devem ser chamados por código de domínio**.
- `eventToQueueMap` em `eventPublisher.js` é a fonte única de verdade para o roteamento de eventos do `OutboxDispatcher`.
- Novos `EventTypes` só devem ser adicionados ao catálogo se forem publicados e consumidos imediatamente; use `events/EVENT_TYPES_ROADMAP.js` para eventos futuros.

---

## 6. Links relacionados

- [`CANONICAL_FLOW.md`](./CANONICAL_FLOW.md)
- [`CANONICAL_FILES.md`](./CANONICAL_FILES.md)
- [`ARCHITECTURE_RULES.md`](./ARCHITECTURE_RULES.md)
