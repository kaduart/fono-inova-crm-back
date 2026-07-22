# Appointment Lifecycle — Cancel ⇄ Restore

## Leia também
`back/docs/DOMAIN_INVARIANTS.md` é a entrada obrigatória para qualquer mudança
neste fluxo. Este documento complementa — não substitui — os invariantes lá
descritos.

---

## Diagrama de estados

```
                    ┌─────────────┐
                    │ pre_agendado│
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
              ┌────▶│  scheduled  │◀────┐
              │     └──────┬──────┘     │
              │            │            │
              │            ▼            │
              │     ┌─────────────┐     │
              │     │  confirmed  │     │
              │     └──────┬──────┘     │
              │            │            │
        restore            │ complete   │ restore
   (nunca reabre       (completeSessionService,       (nunca reabre
    direto p/           NUNCA manual)                  direto p/
    completed)               │                         completed)
              │            ▼            │
              │     ┌─────────────┐     │
              │     │  completed  │     │
              │     └──────┬──────┘     │
              │            │            │
              │        cancel           │
              │  (cancelAppointmentCommand,         │
              │   qualquer status pré-completed      │
              │   ou completed)                      │
              │            │            │
              └────────────┴────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  canceled   │
                    └──────┬──────┘
                           │
                       restore
              (restoreCanceledAppointmentCommand,
               via updateAppointmentCommand.js)
                           │
                           ▼
              volta pra scheduled/confirmed/pending
              (NUNCA direto pra completed)
```

**Regra de ouro:** `cancel` e `restore` são operações **simétricas e
inversas**, cada uma implementada num comando dedicado — não espalhar lógica
de reversão em múltiplos lugares (rotas, controllers, telas). Toda a lógica
de negócio do par vive em:

- `back/services/appointment/commands/cancelAppointmentCommand.js`
- `back/services/appointment/commands/restoreCanceledAppointmentCommand.js`
  (chamado de dentro de `updateAppointmentCommand.js`, no bloco de
  reativação — não é uma rota própria)

---

## Assimetrias intencionais (não são bugs)

| Campo | Por quê |
|---|---|
| `Session.status` nunca volta pra `completed` no restore | Reabrir uma sessão concluída automaticamente esconderia a decisão de "isso realmente aconteceu de novo?" atrás de um clique de reativação. Reativação sempre pousa em `scheduled`; virar `completed` de novo exige o fluxo oficial (`completeSessionService`). |
| `Payment.status` nunca volta pra `paid` no restore — volta pra `pending` | Reativar um agendamento não deveria recriar um evento financeiro confirmado sozinho. Exige confirmação real de pagamento de novo, evitando inflar receita silenciosamente. |
| `Session.completedAt` nunca é limpo, nem pelo cancel nem pelo restore | É um marcador **histórico** ("esta sessão já foi completada em algum momento"), não o estado atual. É o sinal usado para decidir se `Package.sessionsDone` deve ser restaurado no cancel e reincrementado no restore. |

---

## Matriz de impacto por transição

### `cancel` (scheduled/confirmed/completed → canceled)
Implementado em `cancelAppointmentCommand.js`.

| Entidade | O que acontece |
|---|---|
| `Appointment` | `operationalStatus='canceled'`, `cancelReason`, `canceledAt`, `canceledBy`, entrada em `history[]` |
| `Session` | `status='canceled'`, `confirmedAbsence`, `canceledAt`. Se estava paga, snapshot em `original*` (`originalPartialAmount`/`originalPaymentStatus`/`originalIsPaid`/`originalPaymentMethod`) antes de zerar. `completedAt` **preservado**. |
| `Package` (só `serviceType='package_session'`) | Via `restorePackageOnCancel()`: `sessionsDone--` **só se** `appointmentStatus` (status pré-cancelamento) era `'completed'` — nunca decrementa sessão nunca-completada, nunca vai a negativo (`sessionsDone: {$gt:0}` na query). `totalPaid`/`paidSessions--` **só se** `paymentOrigin==='auto_per_session'`. Arrays `sessions`/`appointments` limpos via `$pull` (IDs corretos: `Session._id` em `sessions`, `Appointment._id` em `appointments`). |
| `Payment` | `status='canceled'`, exceto `kind==='package_receipt'` (recibo de compra do pacote nunca é tocado por cancelamento de uma sessão individual). |
| Outbox | Evento `APPOINTMENT_CANCELLED` salvo na mesma transação. |
| `PackagesView` | Reconstruída **sincronamente** via `syncAffectedViews({event:'appointment.cancelled'})` — não depende só do worker consumir o evento da Outbox (workers podem estar desligados; ver `ENABLE_WORKERS`). |

### `restore` (canceled → scheduled/confirmed/pending)
Implementado em `restoreCanceledAppointmentCommand.js`, chamado de dentro do
bloco de reativação em `updateAppointmentCommand.js`.

| Entidade | O que acontece |
|---|---|
| `Appointment` | `operationalStatus` volta pra `scheduled`/`confirmed`/`pending` (nunca `completed`) via `updateAppointmentCommand.js`. `paymentStatus` recalculado considerando `session.original*` (não assume `'unpaid'` cegamente pro caso per-session). |
| `Session` | Volta pra `status='scheduled'` (nunca `'completed'`), `confirmedAbsence=false`, `canceledAt=null`. Se `wasPaid` (via `original*`), restaura `isPaid`/`partialAmount`/`paymentMethod` e **zera** os campos `original*` (evita reaproveitar o mesmo snapshot num cancelamento futuro). `completedAt` preservado sem alteração. |
| `Package` (só `serviceType='package_session'`) | `sessionsDone++` via `consumePackageSession()` **só se** `Session.completedAt` prova que a sessão tinha sido completada antes (guard simétrico, nunca ultrapassa `totalSessions`). `totalPaid`/`paidSessions++` via `updatePackageFinancials()` **só se** `wasPaid && paymentOrigin==='auto_per_session'`. Arrays `sessions`/`appointments` re-adicionados via `$addToSet` (inverso do `$pull` do cancelamento). |
| `Payment` | Volta pra `status='pending'` (nunca `'paid'` direto), exceto `kind==='package_receipt'` (nunca foi tocado no cancelamento, continua intacto). |
| Outbox / `PackagesView` | Reaproveita a sincronização já disparada por `updateAppointmentCommand.js` (evento `appointment.updated`) — não tem handler próprio dedicado hoje. |

---

## Achado relevante durante a construção deste par (2026-07-22)

Existe um plugin `models/plugins/financialSanitizer.js` aplicado em `Session`
que **remove `isPaid`/`paymentStatus` de qualquer documento novo** (`create`/
`new + save` com `isNew=true`), alinhado com o ADR-001 (`Payment` é a fonte
da verdade financeira; campos V1 em `Session`/`Appointment` são shadow state).
Ele **não** age em `.save()` de documento já existente, por isso
`cancelAppointmentCommand.js` consegue escrever `Session.paymentStatus`
normalmente ao cancelar.

Isso levanta uma pergunta em aberto, não resolvida aqui: os campos
`Session.original*` usados por este par de comandos para decidir se um
estorno financeiro é necessário são, eles mesmos, campos "V1" que o sistema
está tentando eliminar. Uma evolução futura pode precisar migrar esse sinal
para consultar `Payment` diretamente (histórico de status) em vez de
`Session.original*` — mas isso é maior que o escopo deste par de comandos e
não foi feito agora. Ver ADR-001 em `DOMAIN_INVARIANTS.md`.

---

## Referências de código

- `back/services/appointment/commands/cancelAppointmentCommand.js`
- `back/services/appointment/commands/restoreCanceledAppointmentCommand.js`
- `back/services/appointment/commands/updateAppointmentCommand.js` (bloco de reativação)
- `back/domain/package/restorePackageOnCancel.js`
- `back/domain/package/consumePackageSession.js` (`consumePackageSession`, `updatePackageFinancials`)
- `back/models/plugins/financialSanitizer.js`
- Testes: `back/tests/restorePackageOnCancel.test.js`,
  `back/tests/cancelAppointmentCommand.test.js`,
  `back/tests/restoreCanceledAppointmentCommand.test.js`,
  `back/tests/integration/appointment-cancel-reason.test.js`,
  `back/tests/integration/appointment-cancel-restore-roundtrip.test.js`

---

## Changelog

| Data | Mudança |
|---|---|
| 2026-07-22 | Criação — par simétrico cancel/restore, fix `sessionsDone` negativo e `$pull` de ID errado, `restorePackageOnCancel`/`consumePackageSession` reintegrados (eram código órfão desde abril/2026), `restoreCanceledAppointmentCommand` criado do zero. |
