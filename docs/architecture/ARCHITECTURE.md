# Architecture Guide

> **Before changing anything, read this.**

```text
Architecture Version: 2.1
Last Updated: 2026-07-09
Status: Canonical
```

This project has **one supported flow** per responsibility. If you are adding a feature, fixing a bug, or reviewing code, use the paths below.

> **Last updated:** 2026-07-09  
> **Architecture version:** 2.1  
> **Status:** Canonical — V1 fallback removed, Outbox pipeline is the single source of truth.

---

## The three layers

```text
┌─────────────────────────────────────────────────────────────────┐
│                         WRITE LAYER                              │
│  Frontend → API Route → Command/Service → Mongo Transaction      │
│                                          ↓                       │
│                                   saveToOutbox()                 │
│                                          ↓                       │
│                                       Commit                     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      ASYNC PROJECTION LAYER                      │
│  OutboxDispatcher → BullMQ → Projection Workers → Read Models    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                         READ LAYER                               │
│  Frontend → API Route → Read Model (View)                        │
└─────────────────────────────────────────────────────────────────┘
```

The only allowed event pipeline is:

```text
Domain Service / Command / Controller
    ↓
saveToOutbox()  (inside the MongoDB transaction)
    ↓
OutboxDispatcher
    ↓
BullMQ
    ↓
Projection Worker
    ↓
Read Model
```

`publishEvent()` and `appendEvent()` are internal infrastructure. **They must not be called by domain code, controllers, routes, models, or workers.**

---

## Responsibility map

| Responsibility | Canonical file |
|----------------|----------------|
| Create appointment | `back/services/appointment/commands/createAppointmentCommand.js` |
| Update appointment | `back/services/appointment/commands/updateAppointmentCommand.js` |
| Complete appointment | `back/services/completeSessionService.v2.js` |
| Cancel appointment | `back/workers/cancelOrchestratorWorker.v2.js` |
| Publish domain events | `back/infrastructure/outbox/outboxPattern.js` → `saveToOutbox()` |
| Dispatch events | `back/infrastructure/outbox/OutboxDispatcher.js` |
| Register workers | `back/workers/registry.js` |
| Consume events | Workers registered in `back/workers/registry.js` |
| Update projections | `back/domains/clinical/workers/patientProjectionWorker.js`, `back/domains/billing/workers/packageProjectionWorker.js`, etc. |
| Read patients | `back/models/PatientsView.js` |
| Read packages | `back/models/PackagesView.js` |
| Read payments | `back/models/PaymentsView.js` |
| Read insurance guides | `back/models/InsuranceGuideView.js` |

---

## Appointment: CREATE

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
services/appointmentHybridService.js        (particular / package)
    OR
services/billing/BillingOrchestrator.js     (insurance only)
```

---

## Appointment: COMPLETE

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
ParticularHandler | ConvenioHandler | LiminarHandler
```

**Rule:** the backend decides billing. The frontend only calls `PATCH /complete`.

---

## Appointment: UPDATE / CANCEL

```text
Frontend
    ↓
PATCH /api/v2/appointments/:id          (update)
PATCH /api/v2/appointments/:id/cancel    (cancel)
    ↓
routes/appointment.v2.js
    ↓
services/appointment/commands/updateAppointmentCommand.js
    OR
workers/cancelOrchestratorWorker.v2.js
```

---

## Read Models

| Entity | Read Model | Builder |
|--------|------------|---------|
| Patients | `PatientsView` | `patientProjectionWorker.js` |
| Packages | `PackagesView` | `packageProjectionWorker.js` |
| Payments | `PaymentsView` | `paymentsProjection.js` / `paymentWorker.js` |
| Insurance Guides | `InsuranceGuideView` | `insuranceOrchestratorWorker.js` |

---

## Rules

- **One flow per responsibility.**
- **One endpoint per operation.**
- **The backend decides billing.**
- **One response contract.**
- **No permanent fallbacks.**
- **No parallel implementations.**
- **All domain events go through the Outbox.**

## Fundamental architecture rule

Every domain change that must reflect in projections, dashboards, integrations, or notifications **must end as an event persisted in the Outbox** inside the same MongoDB transaction as the state change.

```text
Domain Service / Command / Controller
    ↓
MongoDB transaction
    ↓
saveToOutbox()
    ↓
Commit
    ↓
OutboxDispatcher → BullMQ → Worker → Read Model / Integration / Notification
```

Never update the following structures manually inside the synchronous flow:

- `PackagesView`
- `PatientsView`
- `PaymentsView`
- Dashboard caches
- Package credits
- Patient balances
- Insurance guide projections

These updates must be triggered by events consumed by their official projection workers.

## Domain states are architectural contracts

Values such as

```text
scheduled
completed
canceled
pending
paid
attended
advanced
```

are not plain strings. They are part of the architecture. Introducing ad-hoc states such as

```text
confirmado
```

can prevent:

- workers from executing;
- projections from updating;
- events from being produced;
- packages from consuming credits;
- dashboards from recalculating.

Adding or changing a domain state requires a coordinated update to:

1. Mongoose schema enums (`models/*.js`).
2. Command and service logic.
3. Projection workers that consume the state.
4. Read models that expose the state.
5. Tests that exercise the state.
6. This documentation.

---

## What is NOT part of the canonical flow

The following are legacy, transition, or experimental. Do not add features to them:

- `POST /api/V2/appointments/:id/complete-insurance` — **removed**.
- Fallback V1 inside `PATCH /complete` — **removed**.
- `services/appointmentProxyService.js` — deprecated.
- `services/appointmentStateOrchestrator.js` — deprecated.
- `domains/clinical/services/appointmentService.js` — parallel, not wired.
- `appendEvent()` / `EventStore` as a publication mechanism — use `saveToOutbox()`.
- `publishEvent()` called directly by domain code, controllers, or routes — use `saveToOutbox()`.
- `syncAffectedViews()` for projections that already have an official projection worker — use the worker queue.
- Workers not registered in `workers/registry.js` — if a worker file is not wired, it is not part of the architecture.

### Temporary architectural exception

`back/workers/notificationOrchestratorWorker.js` still uses `appendEvent()` and `publishEvent()` directly for historical reasons. It is the only worker that remains outside the Outbox pipeline while the migration is completed.

**Do not use this pattern in new code.** New notifications and all new workers must use `saveToOutbox()` → `OutboxDispatcher` → BullMQ.

| Metadata | Value |
|----------|-------|
| **Status** | Temporary Exception |
| **Owner** | Backend Architecture |
| **Target** | Migrate to `saveToOutbox()` |
| **Blocker** | Dependency on the legacy notification pipeline |
| **Review** | Remove before Architecture v3.0 |

This exception is tracked and planned for future migration.

---

## Official architecture documents

| Document | Purpose |
|----------|---------|
| [`CANONICAL_FLOW.md`](CANONICAL_FLOW.md) | End-to-end canonical flow for appointments. |
| [`CANONICAL_FILES.md`](CANONICAL_FILES.md) | Exact list of canonical files per operation. |
| [`ARCHITECTURE_RULES.md`](ARCHITECTURE_RULES.md) | Rules every PR must follow. |
| [`EVENT_PROJECTION_INVENTORY.md`](EVENT_PROJECTION_INVENTORY.md) | Event → queue → worker → view mapping. |
| [`ARCHITECTURE_DECISIONS.md`](ARCHITECTURE_DECISIONS.md) | Why the architecture was built this way. |
| [`complete-billing-migration.md`](complete-billing-migration.md) | Migration history (completed). |
| [`../APPOINTMENT_FINANCIAL_POLICY.md`](../APPOINTMENT_FINANCIAL_POLICY.md) | Financial protection rules for appointments. |
| [`../APPOINTMENT_WRITE_CONTRACT.md`](../APPOINTMENT_WRITE_CONTRACT.md) | Write contract for appointments. |
