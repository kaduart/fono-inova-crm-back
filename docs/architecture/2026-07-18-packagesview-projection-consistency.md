# PackagesView — Consistência de Projeção (Read Model)

> **Data:** 2026-07-18
> **Status:** Documentado — correção pendente
> **Relacionado:** [ADR 6](./ARCHITECTURE_DECISIONS.md#adr-6--read-models-must-be-updated-only-by-projection-workers) · [`EVENT_PROJECTION_INVENTORY.md` §3.2](./EVENT_PROJECTION_INVENTORY.md#32-packagesview) · [`2026-07-18-package-sessions-id-inconsistency.md`](./2026-07-18-package-sessions-id-inconsistency.md)

## Contexto

Investigação disparada por um sintoma concreto: uma sessão de fonoaudiologia vinculada a um pacote foi cancelada (`Appointment.operationalStatus = 'canceled'`), mas continuou sem aparecer — nem como "Cancelada" — no calendário de sessões do pacote (`TherapyPackageCard.tsx`), enquanto outras sessões canceladas do mesmo pacote apareciam normalmente em outras datas.

## Fonte da verdade vs. projeção

- **Fonte da verdade:** `Appointment` + `Session` (coleções transacionais).
- **`PackagesView` (collection `packages_view`):** projeção materializada, somente leitura, reconstruída de forma assíncrona. **Nunca** deve ser lida como fonte da verdade pelo domínio.

```text
Appointment (cancelamento)
        │
        ▼
  saveToOutbox('APPOINTMENT_CANCELLED')     cancelAppointmentCommand.js:165-179
        │
        ▼
  OutboxDispatcher (poll da collection `outboxes`)
        │
        ▼
  BullMQ → packageProjectionWorker.js
        │
        ▼
  buildPackageView()                        PackageProjectionService.js:149
        │  fetchRawData(): Session.find({ package: packageId })   linha 49 — sem filtro de status
        ▼
  packages_view (documento sobrescrito por inteiro)
```

O array `sessions` dentro de `packages_view` é um **snapshot completo recalculado a cada rebuild** (`PackagesView.js:107-115`) — não é atualizado incrementalmente. Se o rebuild não roda para um evento específico, o documento inteiro permanece congelado no estado do último cálculo bem-sucedido — silenciosamente, sem erro visível para o usuário.

## Causa raiz do sintoma

`GET /v2/packages` (lista — usada por `TherapyPackagesSummary.tsx`, que alimenta `TherapyPackageCard.tsx`) lê `packages_view` diretamente, **sem nenhum fallback de staleness** (`routes/package.v2.js:67-141`). `GET /v2/packages/:id` (detalhe individual) tem uma heurística parcial de rebuild (linhas 163-172), mas ela não cobre todos os casos e não é acionada pela tela de listagem.

Isso já estava listado como risco conhecido em `EVENT_PROJECTION_INVENTORY.md §3.2`, antes mesmo desta investigação:

> **PackagesView** — Múltiplos writers: **Sim** — dois caminhos diferentes (`packageProjectionWorker.js` canônico + `syncAffectedViews()` residual). **Status: 🟡 Risco de inconsistência.**

Esse é exatamente o cenário que a **ADR 6** (`ARCHITECTURE_DECISIONS.md`) já visava eliminar: *"Read models must be updated only by projection workers"* — o caminho residual via `syncAffectedViews()` é a exceção que a própria ADR 6 previu como algo a fechar, e ainda não foi fechada para `PackagesView`.

## Sintomas possíveis (mesma causa raiz)

- Sessão cancelada some do calendário do pacote em vez de aparecer como "Cancelada".
- Sessão concluída continua exibida como pendente/agendada.
- Contadores (`sessionsRemaining`, `sessionsDone`) desatualizados na tela do paciente.
- Badges financeiros (pago/pendente) incorretos até o próximo rebuild.

## Diagnóstico — passo a passo usado nesta investigação

1. `db.sessions.findOne({ _id })` — confirma o estado real da sessão (fonte da verdade).
2. `db.packages_view.findOne({ packageId })` → conferir `snapshot.calculatedAt`, `snapshot.isStale`, e se o array `sessions` contém a entrada esperada (por `sessionId` ou `appointmentId`).
3. `db.outboxes.find({ aggregateId: appointmentId })` → conferir se o evento `APPOINTMENT_CANCELLED` foi publicado (`status: 'published'`) e quando (`publishedAt`).
4. Cruzar os três: se o outbox foi publicado mas a view não reflete a mudança, o problema está no `packageProjectionWorker.js` (job não consumido, ou `buildPackageView()` falhando silenciosamente).

Ver também `scripts/diag-packagesview-sync.mjs` — diagnóstico agregado existente, mas ele compara apenas `sessionsRemaining` (contador), não a presença de cada sessão individual no array.

## Melhorias propostas (não implementadas)

- [ ] Retry automático com backoff para jobs de projeção falhos.
- [ ] Health check / alerta quando um evento em `outboxes` com `status: 'pending'` ultrapassa um SLA (ex.: 5 min sem ser publicado, ou publicado mas sem rebuild correspondente).
- [ ] Reconciliação periódica (cron) comparando `Session` × `packages_view.sessions` por pacote, similar ao que `diag-packagesview-sync.mjs` já faz para o contador agregado.
- [ ] Fallback de staleness em `GET /v2/packages` (lista) — hoje só o endpoint singular (`GET /v2/packages/:id`) tem heurística parcial.
- [ ] Fechar de vez o caminho residual `syncAffectedViews()` para `PackagesView`, deixando `packageProjectionWorker.js` como único escritor — fecha a exceção que a ADR 6 deixou em aberto para esta view.

## O que NÃO é a causa deste incidente

O bug de tipo em `Package.sessions` (o array declara `ref: 'Session'`, mas parte do código escreve `Appointment._id` nele) é real e está documentado separadamente, mas **não é a causa deste incidente** — `packages_view.sessions` não depende desse array; é recalculado do zero via `Session.find({ package })`. Ver [`2026-07-18-package-sessions-id-inconsistency.md`](./2026-07-18-package-sessions-id-inconsistency.md).
