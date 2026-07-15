# Arquivos Canônicos do Fluxo de Agendamentos

> **Versão:** 1.2  
> **Data:** 2026-07-15  
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

### Command
- `back/services/appointment/commands/cancelAppointmentCommand.js` (síncrono, dentro de transação)

---

## PRÉ-AGENDAMENTO (TRIAGEM COMERCIAL)

> Histórico: até 2026-05, `PreAppointment` e `Appointment` eram entidades separadas. Hoje só existe `Appointment` — `operationalStatus: 'pre_agendado'` é apenas um estado do ciclo de vida. `preAgendamento.engine.js` é uma **fachada especializada** de triagem sobre `Appointment`, não um domínio à parte. Auditoria completa + migração feita em 2026-07-15.

### Rota de entrada
- `back/routes/preAgendamento.engine.js`, montada em `/api/v2/pre-appointments`

### Endpoints ativos (consumidor confirmado em `crm/front`)
- `GET /` — listagem com filtros de triagem (urgência, telefone, especialidade) — query especializada, direto no router, sem command
- `POST /:id/confirm` — delega a `back/services/appointment/commands/confirmPreAgendamentoCommand.js`
- `POST /:id/discard` — delega a `cancelAppointmentCommand` via `appointmentV2Service.cancelAppointment`
- `GET /stats/dashboard` — agregação exclusiva de triagem, direto no router
- `POST /:id/contact` — grava `contactAttempts`/`attemptCount`, direto no router
- `POST /:id/assign` — grava `assignedTo`, direto no router

### Command de confirmação (canônico desde 2026-07-15)
- `back/services/appointment/commands/confirmPreAgendamentoCommand.js` — transição **in-place** `pre_agendado → scheduled` (mesmo `_id`), cria `Session`/`Payment` só se ainda não existirem (reaproveita `appointmentSessionSyncService.createSessionFromAppointment`). Substituiu o padrão antigo de criar um `Appointment` novo + cancelar o original, que já causou duplicação real de registros em produção (histórico documentado em `/projetos/agenda/BACKEND_CLEANUP_REQUIRED.md` e commit `5d50ff9` desse repo).

### Removidos em 2026-07-15 (código morto confirmado, sem consumidor em `crm/front`/`agenda`/`crm-v2-migracao`)
- `GET /:id`, `POST /` (criar), `PATCH /:id`, `POST /:id/cancel` — todos tinham equivalente 100% coberto pelas rotas genéricas de `appointment.v2.js`

### Pendente de decisão — aguardando período de observação (ver memória de projeto)
- `back/workers/preAgendamentoWorker.js` — hoje dormente: reage a `PREAGENDAMENTO_CREATED`/`PREAGENDAMENTO_IMPORTED`, mas nenhum dos dois é publicado de forma que chegue à fila (`PREAGENDAMENTO_IMPORTED` nem está mapeado em `eventToQueueMap`, lança `UNKNOWN_EVENT_TYPE` engolido por `.catch()`). Não remover ainda — decisão do usuário foi observar antes.
- Eliminação completa do router `preAgendamento.engine.js` (incorporando `discard`/`contact`/`assign`/`dashboard`/`GET /` a `appointment.v2.js`) e limpeza de `PREAGENDAMENTO_*` em `EventTypes`/`eventToQueueMap`.

> ⚠️ `back/services/appointmentHybridService.js` **continua canônico** (usado por `createAppointmentCommand.js`, seção CREATE acima) — não faz parte desta limpeza. Só sua reutilização dentro do `confirm` de pré-agendamento foi removida.

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

- `back/services/appointmentProxyService.js` — referências quebradas, não canônico. **Removido**.
- `back/services/appointmentStateOrchestrator.js` — duplica sync do update command, mas ainda é chamado por ele (`updateAppointmentCommand.js`). Não remover sem resolver a duplicação primeiro.
- `back/domains/clinical/services/appointmentService.js` — API paralela não plugada. `cancelAppointment()` **removido**; `createAppointment()` mantido (usado em teste e2e).
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
