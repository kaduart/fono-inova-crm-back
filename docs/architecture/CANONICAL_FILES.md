# Arquivos Canônicos do Fluxo de Agendamentos

> **Versão:** 1.1  
> **Data:** 2026-07-08  
> **Status:** Oficial

Esta lista define os arquivos que fazem parte do **fluxo canônico** de agendamentos. Qualquer arquivo relacionado a agendamento que não esteja nesta lista deve ser tratado como legado, transição ou experimental.

---

## CREATE

### Rota de entrada
- `back/routes/appointment.v2.js` — rota `POST /api/v2/appointments`

### Fachada / Service
- `back/services/appointmentV2Service.js` — delega para commands

### Command
- `back/services/appointment/commands/createAppointmentCommand.js`

### Core de criação
- `back/services/appointmentHybridService.js` — particular / pacote

### Billing
- `back/services/billing/BillingOrchestrator.js`
- `back/services/billing/insuranceBilling.js` — convênio

> **Nota:** particular/pacote são tratados por `appointmentHybridService.js`; pagamento antecipado por `helpers/handleAdvancePayment.js` (em transição). Placeholders antigos (`individualBilling.js`, `packageBilling.js`, `advanceBilling.js`) foram removidos.

### Políticas e validações
- `back/services/appointment/policies/appointmentSpecialtyPolicy.js`
- `back/services/appointment/policies/appointmentFinancialPolicy.js`
- `back/services/financialGuard/FinanceWriteGuard.js`

---

## COMPLETE

### Rota de entrada
- `back/routes/appointment.v2.js` — rota `PATCH /api/v2/appointments/:id/complete`

### Commands
- `back/services/appointment/commands/completeInsuranceAppointmentCommand.js` — convênio com orquestrador

### Service principal
- `back/services/completeSessionService.v2.js`

### Handlers de billing
- `back/services/completeSession/handlers/particularHandler.js`
- `back/services/completeSession/handlers/convenioHandler.js`
- `back/services/completeSession/handlers/liminarHandler.js`

### Utilitários compartilhados
- `back/services/completeSession/shared/resolveVisualFlag.js`

---

## UPDATE / SYNC

### Command
- `back/services/appointment/commands/updateAppointmentCommand.js`

### Sync
- `back/services/appointmentSessionSyncService.js`

---

## CANCEL

### Rota de entrada
- `back/routes/appointment.v2.js` — rota `PATCH /api/v2/appointments/:id/cancel`

### Worker
- `back/workers/cancelOrchestratorWorker.v2.js`

---

## READ

### Rotas de leitura
- `back/routes/appointmentReads.js` — montada dentro de `appointment.v2.js`
- `back/routes/appointmentAnalytics.routes.js` — analytics read-only

### Read Models / Views
- `back/models/PatientsView.js`
- `back/models/PackagesView.js`
- `back/models/PaymentsView.js`
- `back/models/InsuranceGuideView.js`

### Projeções
- `back/services/projections/syncAffectedViews.js` — **apenas** para views sem worker dedicado
- `back/domains/billing/services/PackageProjectionService.js`
- `back/domains/clinical/services/patientProjectionService.js`
- `back/projections/paymentsProjection.js`

---

## EVENTOS / INFRAESTRUTURA

### Outbox (pipeline canônico)
- `back/infrastructure/outbox/outboxPattern.js` — API pública `saveToOutbox()`
- `back/infrastructure/outbox/OutboxDispatcher.js` — polling e publicação nas filas
- `back/infrastructure/outbox/OutboxModel.js` — schema da collection `outboxes`

### Publicador / roteamento
- `back/infrastructure/events/eventPublisher.js` — `EventTypes`, `eventToQueueMap`, `publishEvent()` (interno)

### Contratos de eventos
- `back/infrastructure/events/bootstrapContracts.js`

### Audit
- `back/services/auditLogService.js`

---

## WORKERS / CONSUMIDORES

| Worker | Responsabilidade |
|--------|------------------|
| `back/workers/cancelOrchestratorWorker.v2.js` | Consome `APPOINTMENT_CANCELLED` |
| `back/workers/completeOrchestratorWorker.js` | Consome `APPOINTMENT_COMPLETED` |
| `back/domains/clinical/workers/patientProjectionWorker.js` | Consome eventos de paciente e rebuilda `PatientsView` |
| `back/domains/billing/workers/packageProjectionWorker.js` | Consome eventos de pacote e rebuilda `PackagesView` |
| `back/workers/paymentWorker.js` | Consome eventos de pagamento |
| `back/domains/billing/workers/insuranceOrchestratorWorker.js` | Consome eventos de guia de convênio |

### Registry
- `back/workers/registry.js` — registro de todos os workers ativos

---

## MODELS

- `back/models/Appointment.js`
- `back/models/Session.js`
- `back/models/Payment.js`
- `back/models/Package.js`
- `back/models/Patient.js`
- `back/models/Doctor.js`
- `back/models/InsuranceGuide.js`
- `back/models/LiminarContract.js`
- `back/models/PatientBalance.js`
- `back/models/FinancialLedger.js`

---

## ARQUIVOS FORA DO FLUXO (exemplos conhecidos)

> Estes arquivos **não** devem receber novas features. Novos desenvolvedores não devem perdê-los analisando-os.

- `back/services/appointmentProxyService.js` — referências quebradas, não canônico
- `back/services/appointmentStateOrchestrator.js` — duplica sync do update command
- `back/domains/clinical/services/appointmentService.js` — API paralela não plugada
- `back/services/billing/individualBilling.js` — placeholder **removido**
- `back/services/billing/packageBilling.js` — placeholder **removido**
- `back/services/billing/advanceBilling.js` — placeholder **removido**
- `back/services/completeFallbackMetrics.js` — métricas do fallback V1, **removido**

---

## Como usar esta lista

1. Ao implementar uma feature nova, confira se o arquivo que você está editando está nesta lista.
2. Se não estiver, pare e pergunte: "Este arquivo é realmente o caminho oficial?"
3. Se for legado, marque-o com `@deprecated` e referencie este documento.
4. Não crie rotas alternativas para operações já cobertas pelo fluxo canônico.
5. Não chame `publishEvent()` ou `appendEvent()` fora do `OutboxDispatcher`.
