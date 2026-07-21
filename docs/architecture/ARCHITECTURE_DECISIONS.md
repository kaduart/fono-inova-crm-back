# Architecture Decision Records

> **Status:** Canonical  
> **Created:** 2026-07-09  
> **Last updated:** 2026-07-09

This document preserves the context behind the most important architectural decisions of the CRM. It exists so that future developers understand not only **how** the system works, but also **why** it was built this way.

---

## ADR 1 — Transactional Outbox as the only event pipeline

### Context

The system previously used two mechanisms to publish domain events:

- `publishEvent()` — publishes directly to BullMQ.
- `appendEvent()` — saves to `EventStore` and optionally publishes.

Both approaches created a classic consistency risk: the database transaction could commit, the application could crash before the event was published, and the event would be lost. Projections, package credits, and financial calculations would then diverge from the write model.

### Decision

Every domain change that must produce an event now uses `saveToOutbox()` inside the same MongoDB transaction. The `OutboxDispatcher` polls pending events and publishes them to BullMQ. Projection workers consume the events and update read models.

```text
Transaction
    ↓
saveToOutbox()
    ↓
Commit
    ↓
OutboxDispatcher
    ↓
BullMQ
    ↓
Projection Worker
    ↓
Read Model
```

### Consequences

- Events are never lost due to a crash after commit.
- Domain code is decoupled from queue infrastructure.
- The dispatcher guarantees at-least-once delivery to workers.
- Workers must be idempotent because the same event can be redelivered.

### Exceptions

`back/workers/notificationOrchestratorWorker.js` still uses the legacy `publishEvent()` / `appendEvent()` path. It is the only exception and is tracked for migration.

---

## ADR 2 — Single endpoint for completing appointments

### Context

There were multiple ways to complete an appointment: `PATCH /complete`, `PATCH /complete-insurance`, and several internal services deciding billing differently. The frontend had to choose the endpoint based on the appointment type, which duplicated business logic on the client and caused inconsistent states.

### Decision

There is only one public endpoint: `PATCH /api/v2/appointments/:id/complete`. The backend receives the request, loads the appointment, and decides internally whether to use the particular, insurance, package, or liminar handler.

### Consequences

- The frontend no longer needs to know billing rules.
- All completion flows share the same validation and event emission logic.
- New billing types can be added without changing the API contract.

---

## ADR 3 — `SESSION_COMPLETED` as the canonical trigger for projections

### Context

Before the consolidation, different completion paths emitted different events (`APPOINTMENT_COMPLETED`, `SESSION_COMPLETED`, `PAYMENT_STATUS_CHANGED`, etc.) at different moments. Projection workers had to subscribe to multiple events and sometimes received inconsistent ordering.

### Decision

`SESSION_COMPLETED` is the single canonical event that represents "a clinical session was finished and billing was decided". It is produced by `services/completeSessionService.v2.js` and consumed by billing, package, and financial projection workers.

### Consequences

- Projection workers have a single source of truth for completion.
- Event ordering is deterministic: one completion emits one `SESSION_COMPLETED`.
- Financial calculations can rely on a stable event contract.

---

## ADR 4 — Domain states are architectural contracts

### Context

Several bugs were caused by ad-hoc state values being inserted into documents, such as `status: 'confirmado'` in a `Session` whose schema only accepts `scheduled`, `completed`, or `canceled`. These invalid states blocked workers and prevented projections from updating.

### Decision

Domain state values are treated as architectural contracts. They are defined in schema enums, validated by commands, consumed by workers, and exposed by read models. A new state requires a coordinated change across all these layers.

### Consequences

- Invalid states are rejected at the model/command level.
- Workers can rely on a closed set of values.
- Projections and dashboards remain consistent.

---

## ADR 5 — Removal of V1 fallback and legacy flows

### Context

The codebase contained parallel implementations for the same feature: V1 and V2 flows for appointments, billing, packages, and cancellation. Feature flags such as `FF_COMPLETE_V2` toggled between implementations, making the system harder to reason about and test.

### Decision

V1 fallbacks were removed. `FF_COMPLETE_V2` is permanently enabled. Legacy files that were no longer wired were deleted or marked as deprecated. The canonical V2 flow is the single supported path.

### Consequences

- There is only one code path per responsibility.
- Tests and documentation target a single flow.
- The risk of accidentally invoking a legacy path is eliminated.

---

## ADR 6 — Read models must be updated only by projection workers

### Context

Some controllers and services were updating read models (`PatientsView`, `PackagesView`, `PaymentsView`) directly during the synchronous request. This created race conditions with projection workers and caused data to diverge.

### Decision

Read models are updated exclusively by their official projection workers. The synchronous flow writes to the transactional model and emits an event. The worker consumes the event and rebuilds the projection.

### Consequences

- Write and read paths are clearly separated.
- Projections can be rebuilt from events if needed.
- Race conditions between synchronous writes and workers are eliminated.

---

## References

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — canonical architecture guide.
- [`docs/architecture/ARCHITECTURE_RULES.md`](ARCHITECTURE_RULES.md) — rules every PR must follow.
- [`docs/architecture/CANONICAL_FLOW.md`](CANONICAL_FLOW.md) — end-to-end canonical flow.
- [`docs/architecture/EVENT_PROJECTION_INVENTORY.md`](EVENT_PROJECTION_INVENTORY.md) — event → queue → worker → view mapping.
- [`docs/architecture/2026-07-18-packagesview-projection-consistency.md`](2026-07-18-packagesview-projection-consistency.md) — real-world case of the ADR 6 exception (`syncAffectedViews()`) causing a visible bug in `PackagesView`.
