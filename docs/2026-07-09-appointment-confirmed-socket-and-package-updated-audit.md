# Auditoria 2026-07-09 — Socket ausente no confirm/cancel, `operationalStatus` sem dono único, e status de `PACKAGE_UPDATED`

> Disparada pelo card da guia #16306580 (Nicolas Lucca) mostrando contagem errada de sessões,
> e por um agendamento (Benjamin Chaveiro Gomes) que regrediu de `confirmed` para `pending`
> sozinho. Consolida três investigações feitas na mesma sessão. Não confundir com
> `convenio-guide-consumption-audit/` (é sobre consumo de guia, não sobre agenda/socket).

---

## Catálogo de bugs desta auditoria

| ID | Título | Arquivo(s) | Cenário de falha | Status |
|---|---|---|---|---|
| BUG-01 | `usedSessions` divergente do real | `models/InsuranceGuide.js` | Guia mostra "6 concluídas" com 9 sessões reais realizadas — contador manual sem recálculo | ✅ Corrigido pontualmente (guia #16306580) |
| BUG-02 | Socket ausente no confirm/cancel de appointment | `services/appointment/commands/confirmAppointmentCommand.js`, `cancelAppointmentCommand.js` | Import de `emitSocket` morto — nenhuma aba/modal aberto é avisado quando alguém confirma/cancela um agendamento em tempo real | ✅ Corrigido — `emitSocket` adicionado nos dois |
| BUG-03 | **`operationalStatus` regride de `confirmed` para `pending` sozinho** | `services/appointment/commands/updateAppointmentCommand.js:88` (spread `...safeBody` sem guarda) + `front/src/components/calendar/appointmentDetailModal.tsx:794-800` (payload montado de estado local stale) | Modal aberto antes de uma confirmação externa manda de volta o `operationalStatus` antigo ao salvar qualquer edição — `updateAppointmentCommand` grava sem validar a transição. Provado com `auditlogs` (before/after) no appointment do Benjamin, 09/07 19:31:17 | ⚠️ Causa **deste incidente** corrigida (efeito colateral do fix do BUG-02, que resincroniza o modal aberto). Proteção estrutural contra qualquer regressão futura **não** aplicada — falta conectar `assertAppointmentTransition()` (já existe, não é usada aqui) |
| BUG-04 | `operationalStatus` sem dono único entre Commands | `services/appointment/commands/*.js` | `scheduled→confirmed` tem 2 donos concorrentes (`confirmAppointmentCommand`, `completeInsuranceAppointmentCommand`); `canceled→scheduled` tem 3 | ❌ Não corrigido — decisão deliberada de adiar para ADR |
| BUG-05 | Doc de `PACKAGE_UPDATED` apontava produtor errado | `back/docs/architecture/EVENT_PROJECTION_INVENTORY.md:130` | Documentação dizia `packageController.v2.js`; produtor real é `updatePackageCommand.js` — risco de decisão errada em auditoria futura | ✅ Corrigido (só documentação) |
| BUG-06 | ~~"Marcar como pago" nunca completa o atendimento~~ → reclassificado | `front/src/components/AdminDashboard.tsx:856-909` (`handleMarkAsPaid`) → `POST /v2/payments/create-sync` | Pagamento registrado sem `operationalStatus` avançar pra `completed`. **Reclassificado após validação de negócio: `paid ≠ completed` é regra válida** (pagamento antecipado, paciente que paga e falta). UI já separa os badges (`UnifiedCashflowTab.tsx:1756-1758`), com histórico de já ter corrigido essa exata ambiguidade antes | ✅ Não é bug — vira invariante de domínio a documentar |

O item que você está perguntando (**"bug do confirmed"**) é o **BUG-03**, detalhado na íntegra na seção 3 abaixo, com a linha do tempo completa provada por `auditlogs`.

---

## 1. Guia de convênio #16306580 — usedSessions corrigido

- Card mostrava "6 concluídas" quando 9 sessões reais tinham acontecido.
- Causa: `InsuranceGuide.usedSessions` é contador manual incrementado em ~6 pontos do backend,
  sem recálculo em tempo real — mesma classe de bug já documentada em
  `back/docs/convenio-guide-consumption-audit/` (guia deixada de fora do backfill em massa por
  precisar verificação individual, DEC-004 daquele documento).
- Usuário verificou manualmente via calendário (9 sessões "Realizado") — precondição da DEC-004
  satisfeita.
- **Corrigido:** `usedSessions` 7→9, aplicado em produção via script pontual
  `back/scripts/fix-guide-16306580-used-sessions.js` (mantido como evidência), com trilha de
  auditoria registrada no campo `notes` da guia.
- **Status:** fechado. Pendência do usuário: gerar a 10ª sessão (dia da consulta) pelo botão da UI.

---

## 2. Bug real — `confirmAppointmentCommand` e `cancelAppointmentCommand` não emitiam socket

### Achado

Os dois arquivos importavam `emitSocket` (`services/appointment/commands/helpers/socketHelper.js`)
mas **nunca chamavam** — import morto. Todos os outros commands de appointment
(`create`, `update`, `delete`, `clinicalStatus`) chamavam normalmente.

### Efeito

Ao confirmar/cancelar um agendamento, nenhuma outra aba/modal aberto no navegador era avisado em
tempo real. A tela ficava com dado desatualizado (`operationalStatus` antigo) até um refresh manual.

### Fix aplicado

- `back/services/appointment/commands/confirmAppointmentCommand.js` — adicionado
  `emitSocket('appointmentUpdated', { _id, patient, doctor, date, time, specialty,
  operationalStatus, source: 'crm_confirm' })`, mesmo padrão do `updateAppointmentCommand.js`.
- `back/services/appointment/commands/cancelAppointmentCommand.js` — adicionado
  `emitSocket('appointmentCanceled', { ..., source: 'crm_cancel' })`, evento que o frontend
  (`AppointmentsContext.tsx`) já escutava mas nunca recebia.
- Sintaxe validada com `node --check` nos dois arquivos.

**Status:** corrigido e aplicado.

---

## 3. Incidente "Benjamin" — causa raiz provada via `auditlogs` (before/after)

### Linha do tempo real (appointment `6a46be72f36c254eafc46de9`)

```
19:29:40  confirmAppointmentCommand   pending → confirmed
19:31:17  updateAppointmentCommand    confirmed → pending   ← regressão
19:31:50  confirmAppointmentCommand   pending → confirmed
19:32:35  Payment criado (paid, R$190, dinheiro)
20:16:51  confirmAppointmentCommand   confirmed → confirmed
```

Comprovado com snapshots `before`/`after` do `auditlogs` — não é hipótese, é fato registrado.
Comparação completa do payload da atualização das 19:31:17 mostrou que **só `operationalStatus`
mudou**; todos os outros campos (doctor, time, date, paymentMethod, notes) eram idênticos ao
estado anterior — assinatura clássica de um PUT com snapshot de frontend desatualizado.

### Cadeia causal

1. Modal (`front/src/components/calendar/appointmentDetailModal.tsx`) foi aberto com o agendamento
   ainda em `pending`, guardando isso em estado local `editedAppointment`
   (sincronizado só via `useEffect(() => {...}, [event])`, linha 416-435).
2. Enquanto o modal ficava aberto, outra ação confirmou o agendamento (banco → `confirmed`,
   19:29:40).
3. Por causa do item 2 desta auditoria (socket ausente), o modal aberto nunca recebeu a atualização
   — a prop `event` nunca mudou, então o `useEffect` nunca rodou de novo.
4. Ao clicar "Salvar" (19:31:17), o modal montou o payload a partir do estado local congelado,
   incluindo `operationalStatus: 'pending'` explicitamente
   (`appointmentDetailModal.tsx:794-800`, campo `operationalStatus: operationalStatusEN`).
5. `back/services/appointment/commands/updateAppointmentCommand.js` aplica isso via spread
   (`const updateData = { ...safeBody, ... }`, linha 88) direto num `$set` — **sem guarda** contra
   essa transição específica (os únicos dois guards existentes, linhas 132-148, só bloqueiam
   `→completed` e `→canceled` indevidos).

### Por que o fix do item 2 já fecha esse ciclo

Existe (já existia, antes desta sessão) um efeito em
`front/src/components/calendar/EnhancedCalendar.tsx:362-431` que resincroniza `selectedEvent`
(a prop `event` do modal) sempre que o array `appointments` muda **enquanto o modal está aberto**.
Esse mecanismo de defesa só nunca disparava para o caso `confirm`, por falta do socket. Com o
socket emitindo agora, esse elo se fecha: confirmar → socket → `AppointmentsContext` refaz fetch →
`appointments` atualiza → `selectedEvent` atualiza → modal resincroniza → "Salvar" já sai com o
status correto.

**Status:** causa raiz deste incidente específico está corrigida pelo fix do item 2.

---

## 4. Fragilidade arquitetural descoberta — `operationalStatus` sem dono único

**Não corrigida — decisão deliberada de adiar para ADR futuro.**

### Auditoria de escritores (pasta `services/appointment/commands/`)

| Command | Estado(s) que grava | Guarda de FROM-state? | Sobreposição |
|---|---|---|---|
| `createAppointmentCommand.js` | nenhum explícito (default do schema, `pre_agendado`) | — | nenhuma |
| `updateAppointmentCommand.js` | **qualquer valor do payload** (spread, linha 88) | ❌ só bloqueia `→completed`/`→canceled` indevidos | sobrepõe todos os outros |
| `confirmAppointmentCommand.js` | `confirmed` (incondicional) | ❌ não checa estado de origem | sobrepõe `completeInsuranceAppointmentCommand` para convênio |
| `cancelAppointmentCommand.js` | `canceled` (com guard idempotente) | ⚠️ parcial | nenhuma direta |
| `completeInsuranceAppointmentCommand.js` | `scheduled`, `confirmed` (compare-and-set real via `findOneAndUpdate` com FROM-state no filtro) | ✅ sim | sobrepõe `confirmAppointmentCommand` |
| `completeSessionService.v2.js` | `completed` (idempotente), `scheduled` (reativação), `canceled` (side-effect em outros appointments do slot) | ✅ parcial | reativação `canceled→scheduled` duplicada com `updateAppointmentCommand` |
| `expirePreAgendamentoCommand.js` | `missed`, só de `pre_agendado` | ✅ único que usa `assertAppointmentTransition` | nenhuma |

Existe uma máquina de estados formal já pronta (`OPERATIONAL_STATE_MACHINE` +
`assertAppointmentTransition()` em `services/appointment/commands/_helpers.js:82-121`), mas
**não é usada** por `updateAppointmentCommand`, `confirmAppointmentCommand` nem
`cancelAppointmentCommand` — só por `expirePreAgendamentoCommand`.

### Validação de impacto — por que não dá pra simplesmente remover `operationalStatus` do update genérico

Encontrei 3 dependências legítimas e reais em `updateAppointmentCommand`:

1. **Dropdown "Status Operacional"** editável de verdade em `appointmentDetailModal.tsx:1794-1808`
   (`<select>` ligado a `editedAppointment.operationalStatus`).
2. **Reativação de cancelado** (`updateAppointmentCommand.js:161-170`) — permite
   `canceled → scheduled/pending/confirmed` e recalcula `paymentStatus` (`package_paid`/`unpaid`)
   como efeito colateral financeiro.
3. **Roteamento no frontend** — `AdminDashboard.tsx:608` lê `operationalStatus === 'completed'`
   do payload pra decidir se chama `/admin-edit` ou `PUT /:id` normal.

### Conflito descoberto entre documentação e código de produção

A `OPERATIONAL_STATE_MACHINE` documentada diz:
```js
canceled: ['scheduled', 'pre_agendado'], // reativação
```
Mas o código de reativação **já em produção** permite mais:
```js
const isReactivating = wasCanceled && ['scheduled', 'pending', 'confirmed'].includes(updateData.operationalStatus);
```
Ou seja, **a máquina documentada e a regra de negócio financeira real já divergem**,
independente do bug do Benjamin. Decidir qual lado é o correto é decisão de negócio, não técnica.

### Decisão tomada

**Não mexer agora.** Fica para um ADR futuro (`ADR-0XX — Appointment Operational State Machine
Ownership`) respondendo: quem é dono de cada transição, quais alteram financeiro/pacote/comissão,
e só depois conectar `assertAppointmentTransition` nos commands que hoje não a usam.

### Achado extra, fora de escopo desta auditoria

Existem **15+ outros lugares** fora da pasta `commands/` escrevendo
`operationalStatus: 'scheduled'` diretamente (workers, controllers, rotas — ex:
`amandaBookingService.js`, `provisionamentoService.js`, `paymentWorker.js`,
`therapyPackageController.js` etc.). Não auditados. A fragmentação real do campo é maior do que
só os Commands.

---

## 5. `confirmed` como estado operacional — mito derrubado

Chegou a se cogitar que `confirmed` seria estado ilegítimo/legado, criado por engano. **Provado
que não é**, com evidência direta:
- Está no enum do schema, `back/models/Appointment.js:85`, com comentário
  `'confirmed', // Confirmado pelo profissional`.
- Documentado no `CLAUDE.md` e `back/docs/DOMAIN_INVARIANTS.md` (ciclo de vida oficial:
  `pre_agendado → scheduled → confirmed → completed | cancelled | force_cancelled`).
- Tem endpoint dedicado (`PATCH /api/v2/appointments/:id/confirm`), evento próprio
  (`APPOINTMENT_CONFIRMED`) com contrato formal em `AppointmentEvents.contract.js`, consumido por
  `appointmentWorker.js`, e coberto por testes e2e/integração.

**Nada foi alterado aqui** — nenhuma remoção, nenhuma "correção" do estado.

---

## 6. `PACKAGE_UPDATED` — auditoria fechada, já estava implementado

- **Não precisava criar nada.** `services/billing/commands/updatePackageCommand.js` já existe, já
  está conectado em `PUT /api/v2/packages/:id` (`routes/package.v2.js:336`), já emite evento via
  Outbox na mesma transação, já é idempotente (herdado do `saveToOutbox` genérico — `eventId`
  único, dedup no Mongo e no BullMQ), e já protege campos financeiros (`totalValue`, `payments`
  bloqueados na sanitização — `Payment` continua SSOT).
- Consumidores (`packageProjectionWorker.js`, `patientProjectionWorker.js`) fazem rebuild completo
  a partir da fonte (`Package`) — não dependem do formato específico do payload do evento.
- **Único problema real: documentação desatualizada.** `EVENT_PROJECTION_INVENTORY.md` apontava
  `packageController.v2.js` como publicador (errado — esse arquivo só publica `PACKAGE_CREATED`).
  Corrigido em `back/docs/architecture/EVENT_PROJECTION_INVENTORY.md:130`. Criado
  `back/docs/architecture/PACKAGE_UPDATED_ARCHITECTURE_NOTE.md` registrando o achado completo.
- `PACKAGE_UPDATE_REQUESTED` confirmado como case morto em `packageProjectionWorker.js` — nenhum
  publicador em todo o projeto nem em `docs/`. Deixado como está (housekeeping, não prioridade).

**Status:** fechado, sem alteração funcional necessária.

---

## 7. BUG-06 — "Marcar como pago" nunca completa o atendimento (Ercy vs Benjamin/Victor/Miguel)

Disparado pela mesma dúvida do card inicial: por que a Ercy aparece como **"Atendido"** no
Cashflow enquanto Benjamin, Victor e Miguel aparecem como **"Confirmado"**, todos com a tag
"Pago na sessão"?

### Comparação direta (dados reais do banco, 09/07/2026)

| Paciente | `operationalStatus` | Pacote? | Como o pagamento entrou | `completeSessionService.v2` rodou? |
|---|---|---|---|---|
| Ercy Jacinto da Silva | `completed` ✅ | não (per-session avulso) | dentro do próprio fluxo de conclusão | ✅ sim (`19:44:10`) |
| Benjamin chaveiro Gomes | `confirmed` | não (`individual_session`, particular) | `create-sync` + `markAsPaid` (tabela financeira) | ❌ não |
| Victor Gabriel Dos Santos Ribeiro | `confirmed` | sim (`package_session`, `full`, 3/4) | nenhum pagamento hoje ainda (`Sessão pendente`, correto) | ❌ não (esperado, ainda não foi atendido) |
| Miguel Lima Vieira | `confirmed` | sim (`package_session`, `per-session`, 0/4) | `create-sync` + `markAsPaid` (tabela financeira) | ❌ não |

### A diferença exata (provada por `auditlogs`)

**Ercy** — sequência completa e correta:
```
19:10:39  confirmAppointmentCommand      scheduled → confirmed
19:44:09  Payment criado (dentro do fluxo de conclusão)
19:44:10  completeSessionService.v2      confirmed → completed
```
Session: `status: 'completed', isPaid: true`.

**Benjamin e Miguel** — nenhum evento `appointment_completed` no histórico. O pagamento dos dois
foi criado via `POST /v2/payments/create-sync` (chamado por `handleMarkAsPaid` em
`AdminDashboard.tsx:856-909`, o botão de "marcar como pago" na tabela financeira) — esse fluxo
cria o `Payment`, vincula ao `appointment.payment` e seta `paymentStatus`, mas **nunca chama
`completeSessionService.v2`**. `operationalStatus` fica parado em `confirmed` para sempre, mesmo
com o dinheiro já recebido.

### Conclusão

`completeSessionService.v2.js` é o **único** caminho no sistema que legitimamente leva
`operationalStatus` a `completed` — é quem cria a trinca Appointment+Session+Payment junta, como
exige o `DOMAIN_INVARIANTS.md`. O atalho "marcar como pago pela tabela financeira" é um caminho
paralelo e mais raso, que registra dinheiro sem nunca avançar o estado operacional. Victor é o
único dos quatro sem problema (ainda não foi pago nem concluído hoje — estado correto).

**Não é dado corrompido** — é um atalho de UI que permite registrar pagamento sem exigir conclusão
do atendimento, criando a aparência de "pago mas nunca atendido" indefinidamente.

### Reclassificação final do BUG-06 (após validação de negócio)

Confirmado com o negócio que `paid ≠ completed` é regra válida do domínio — cenários reais:
pagamento antecipado (mesmo dia ou dia diferente da sessão), paciente que paga e falta. Ou seja:

> `Payment.status = paid` **não implica** `Appointment.operationalStatus = completed`.
> Um pagamento pode existir antes, durante ou independente da realização do atendimento.
> Somente `completeSessionService.v2` pode transformar uma sessão em `completed`.

Isso **não é bug de domínio** — `create-sync` não deve chamar conclusão automaticamente (evita
uma regressão pior: `if (payment.status === 'paid') appointment.status = 'completed'` seria
errado, já que pagamento não prova atendimento).

**Verificação de UI feita:** conferi `front/src/pages/Financial/UnifiedCashflowTab.tsx:1710-1761`
(a mesma tela do print "Agenda do Dia") e a separação já existe, com um comentário no código
(linhas 1756-1758) documentando que isso **já foi um incidente real no passado** ("secretária
achava que só confirmar presença já lançava o pagamento") e já foi corrigido deliberadamente:
badge operacional (`Confirmado`/`Atendido`) e badge financeiro (`Pago na sessão`/`Pendente`) são
**dois badges visualmente distintos**, nunca fundidos. Nenhuma ação de UI necessária — a proteção
que se cogitou adicionar já existe em produção.

```
BUG-06 — status final

Não é bug de domínio: Payment.status e Appointment.operationalStatus são máquinas
independentes, por design confirmado com o negócio.

Não é bug de UI: UnifiedCashflowTab.tsx já separa os dois badges, com histórico de
já ter corrigido exatamente essa ambiguidade antes.

Ação: nenhuma. Regra registrada para não ser "corrigida" por engano no futuro
(ex: nunca fazer create-sync chamar completeSessionService automaticamente).
```

**Status:** fechado. Sem alteração de código necessária — achado vira invariante de domínio a
documentar (ver seção "Em aberto" abaixo).

---

## Arquivos alterados nesta sessão

| Arquivo | Mudança |
|---|---|
| `back/services/appointment/commands/confirmAppointmentCommand.js` | + `emitSocket('appointmentUpdated', ...)` |
| `back/services/appointment/commands/cancelAppointmentCommand.js` | + `emitSocket('appointmentCanceled', ...)` |
| `back/docs/architecture/EVENT_PROJECTION_INVENTORY.md` | corrigido producer/consumers de `PACKAGE_UPDATED` |
| `back/docs/architecture/PACKAGE_UPDATED_ARCHITECTURE_NOTE.md` | novo — registra achado do item 6 |
| `back/scripts/fix-guide-16306580-used-sessions.js` | script pontual, já executado (item 1) |
| InsuranceGuide #16306580 (banco, produção) | `usedSessions` 7→9, `notes` com trilha de auditoria |

## Em aberto — decisão de negócio/arquitetura, não técnica

1. ADR de ownership de `operationalStatus` (item 4) — quando for feito, resolver primeiro o
   conflito `canceled→confirmed/pending` (código já em produção) vs `OPERATIONAL_STATE_MACHINE`
   documentada, porque mexe em recálculo de `paymentStatus`.
2. Auditoria dos 15+ escritores de `operationalStatus` fora da pasta `commands/` (item 4) — não
   feita, fora de escopo desta sessão.
3. Housekeeping de `PACKAGE_UPDATE_REQUESTED` (item 6) — baixa prioridade.
4. Próximo item da "Fase 1" de migração da Agenda Externa — não documentado neste repositório;
   só quem está com o plano original sabe qual é o próximo.
5. **Formalizar o invariante do item 7 (BUG-06) em `back/docs/DOMAIN_INVARIANTS.md`** — algo como:
   `Payment.status = paid` NÃO implica `Appointment.operationalStatus = completed`; um pagamento
   pode existir antes, durante ou independente da realização do atendimento; somente
   `completeSessionService.v2` pode transformar uma sessão em `completed`. Não é código para
   alterar, é regra para registrar — protege contra uma futura "correção" errada tipo
   `if (payment.status === 'paid') appointment.operationalStatus = 'completed'`.
