# Package.sessions — Inconsistência de tipo (Session._id vs Appointment._id)

> **Data:** 2026-07-18
> **Status:** Documentado — não corrigido. Bug real, porém confirmado **não ser** a causa do incidente descrito em [`2026-07-18-packagesview-projection-consistency.md`](./2026-07-18-packagesview-projection-consistency.md).

## O bug

`models/Package.js:49` declara:

```js
sessions: [{ type: ObjectId, ref: 'Session' }]
```

Cada entrada deveria ser o `_id` de um documento `Session`. Isso é respeitado em pelo menos um caminho de escrita:

- `controllers/convenioPackageController.js:1033` → `pkg.sessions.push(newSession._id)` — ✅ correto.

Mas `services/syncService.js:349-360` (`adjustPackageSession`) usa **`appointmentId`**, não o id da Session:

```js
async function adjustPackageSession(packageId, appointmentId, operation, session) {
    const update = operation === 'add'
        ? { $inc: { remainingSessions: -1 }, $push: { sessions: appointmentId } }
        : { $inc: { remainingSessions: 1 }, $pull: { sessions: appointmentId } };

    const result = await Package.findByIdAndUpdate(packageId, update, { session });
    ...
}
```

Essa função é chamada por `handlePackageSessionUpdate()` (mesmo arquivo, linhas 251-347) em três cenários:

- Cancelamento de appointment vinculado a pacote (`case 'cancel'`, linhas 290-297).
- Troca de pacote de um appointment (`case 'change_package'`, linhas 300-316) — tanto o `'remove'` no pacote antigo quanto o `'add'` no pacote novo.

`services/appointment/commands/cancelAppointmentCommand.js:122` tem o mesmo padrão, dentro da transação principal de cancelamento:

```js
$pull: { sessions: appointment._id, appointments: appointment._id },
```

(O `$pull` em `appointments` está correto — esse array de fato guarda `Appointment._id`, ver `Package.js:50`. É só o `$pull`/`$push` em `sessions` que usa o ID errado.)

## Por que isso normalmente não quebra nada visivelmente hoje

O calendário de sessões do pacote no frontend (`TherapyPackageCard.tsx`) **não lê `Package.sessions`** — os dados vêm de `packages_view`, uma projeção reconstruída via `Session.find({ package: packageId })` (ver documento irmão). Então, na prática, ninguém no caminho crítico de leitura sente esse array errado — o que torna a inconsistência silenciosa e fácil de não notar em revisão de código.

## Por que ainda é uma bomba-relógio

- Qualquer código futuro (ou já existente, ver lista abaixo) que confie no `ref: 'Session'` do schema e chame `.populate('sessions')` vai obter resultados quebrados/parciais — refs que nunca resolvem, porque apontam para um `Appointment._id` que não existe na collection `sessions`.
- `remainingSessions` é incrementado/decrementado nos mesmos `$inc` que escrevem o array errado — então o contador numérico pode divergir de `packages_view.sessionsRemaining`, que é recalculado por uma via totalmente independente (`Session.find`). São duas fontes de verdade para "quantas sessões restam", que podem discordar sem nenhum alerta.
- O array acumula hoje uma mistura de dois tipos de ID (`Session._id` de um caminho, `Appointment._id` de outro) sem qualquer validação de schema que os distinga — Mongoose só garante que é um ObjectId válido, não que aponta para o documento certo.

Locais que hoje fazem `.populate('sessions')` em `Package` e portanto estão expostos a esse array misto:

- `services/webhookService.js:70,76`
- `controllers/sicoobController.js:149,155`
- `controllers/packageController.v2.js:1537,1825`
- `controllers/therapyPackageController.js:2523`
- `services/financialGuard/FinancialTruthLayer.js:279`

## Correção proposta (não implementada)

Alinhar `adjustPackageSession()` para receber/usar `sessionDoc._id` (já carregado dentro de `handlePackageSessionUpdate`, linha 258) em vez de `appointmentId`, nos três call sites (linhas 293, 304, 311 de `syncService.js`). Mesmo ajuste em `cancelAppointmentCommand.js:122`, usando `appointment.session?._id` no lugar de `appointment._id` para o `$pull` de `sessions` — mantendo `appointment._id` no `$pull` de `appointments`, que já está correto.

**Cuidado antes de corrigir:** mapear os cinco locais listados acima que fazem `.populate('sessions')` e confirmar que nenhum deles depende (mesmo que acidentalmente) do comportamento atual antes de mudar a semântica do array. Esse escopo não foi investigado nesta rodada — fica como pré-requisito do fix.
