# Posse de execução no Event Store

Data: 18/11/2026. Branch: `feat/eventstore-posse` (a partir da `main` em `12bd210`). PR #74.

**Estado:** o código e os testes locais estão prontos. Nada foi ativado, publicado ou conectado a produção, e **nenhuma flag foi ligada**. Há duas flags novas:

- `EVENT_REAPER_OWNER`, com padrão `node`. Mantém o comportamento de hoje quanto a quem roda o reaper.
- `EVENT_LEGACY_FENCE_AT`, sem padrão. Enquanto não é definida, nenhum evento reivindicado pelo código antigo é liberado automaticamente.

O par na KAS Core é o PR kaduart/kas-core#10, com o protocolo v2 do reaper em Go.

## 1. Mapa: quem reivindica, conclui, falha e recupera eventos do `eventstore`

| Caminho | Antes | Agora |
|---|---|---|
| **Reivindicar**: `processWithGuarantees` (`infrastructure/events/eventStoreService.js`) | `updateOne({eventId}, {status:'processing'})`, sem condição, sem dono e sem prazo | `claimEvent` (`infrastructure/events/eventOwnership.js`), atômico. Reivindica a partir de `pending`/`failed`. Retoma posse vencida (conta uma recuperação). Retoma `processing` sem posse só depois da cerca (seção 4). Grava `processingToken`, `processingOwner`, `processingStartedAt` e `leaseExpiresAt`. |
| Chamadores | createAppointmentWorker, notificationOrchestratorWorker, followupOrchestratorWorker, commissionGenerationWorker, evolutionWorker, paymentWorker, invoiceWorker (3 pontos), insuranceOrchestratorWorker | Nenhuma mudança nos chamadores, exceto o de convênio (D-1, seção 6). O processador recebe um 2º argumento opcional, `{ signal, token, eventId }`. |
| **Concluir** | `markEventProcessed`, sem condição | `completeOwned`: só grava se o evento estiver em `processing` com o mesmo token. Limpa a posse. |
| **Falhar** | `$inc attempts` sem condição; vai para `dead_letter` com 5 | `failOwned` e `deadLetterOwned`, condicionais ao token. A promoção a `dead_letter` com 5 também é condicional. |
| **Concluir ou falhar sem token** (`markEvent*` chamados direto) | appointmentWorker, updateOrchestratorWorker, commissionGenerationWorker, createAppointmentWorker, whatsappInboundWorker, messagePersistenceWorker | Continuam funcionando, mas **não passam por cima de uma posse viva** de outra execução. |
| **Recuperar**: `crons/eventReaper.cron.js` | `createdAt` > 15 min; `updateOne({eventId})` sem condição; não conta recuperações | Recupera posse vencida, ou evento sem posse depois da cerca. A escrita é condicional ao estado, ao token, ao prazo e ao `recoveryCount` observados, comparando o valor bruto (driver direto, sem cast). Conta `recoveryCount` e manda para `dead_letter` com alerta quando chega ao limite. |
| **Recuperar manualmente**: `retryDeadLetter` (`infrastructure/observability/deadLetterService.js`) | Volta para `pending` sem condição | Condicional a `dead_letter`, então dois retries não republicam duas vezes. Zera `recoveryCount` e limpa restos de posse. |
| Outros escritores | `syncMedicalWorker` (upsert de `processed`), `completeOrchestratorWorker`/`preAgendamentoTriage` (create), `scripts/heal-pending-appointments.js` (manual) | Sem mudança. Não reivindicam execução. |
| Código morto | `infrastructure/workers/watchdog.js` e `watchdogBullmq.js` | Sem mudança. Recomendo remover numa limpeza separada. |

## 2. Protocolo

1. **Reivindicar.** `claimEvent` gera um `processingToken` (UUID) por execução e um prazo `leaseExpiresAt = agora + EVENT_LEASE_MS`.
2. **Renovar.** A posse é renovada a cada `EVENT_LEASE_MS/3`, de forma condicional ao token. Quando a renovação descobre que a posse foi perdida, o `AbortSignal` é abortado.
3. **Concluir, falhar ou ir para `dead_letter`.** Só gravam com o token. Uma execução que perdeu a posse não altera o evento e devolve `{ success:false, ownershipLost:true }` **sem lançar erro**, porque relançar faria o BullMQ repetir efeitos já executados.
4. **Entrega duplicada com posse viva:** `EventBusyError` (`EVENT_BUSY`, retentável).
5. **Execução abandonada** (prazo vencido) é retomada pela próxima entrega ou pelo reaper. As duas formas incrementam `recoveryCount`. Na 3ª recuperação o evento vai para `dead_letter` com alerta, em vez de rodar de novo.
6. **Evento `processed`:** não roda de novo (`skipped`). **Mudança de comportamento:** antes rodava.
7. **Evento em `dead_letter`:** não roda. A volta é pelo retry de admin.
8. **Sem `eventId`** (string vazia ou ausente): processa sem posse e **sem escrever no Event Store**. Antes, a escrita virava filtro `{eventId: null}`.
9. **Evento fora do `eventstore`:** segue o caminho legado sem posse, como antes.

## 3. Números, estado terminal e visibilidade

| Parâmetro | Valor | Justificativa |
|---|---|---|
| `EVENT_LEASE_MS` | 60.000 (renova a cada 20 s) | Os workers BullMQ usam `lockDuration`/`stalledInterval` de 30 s. O dobro tolera uma renovação perdida (event loop travado por menos de 40 s) e deixa o abandono retomável logo depois que o BullMQ redistribui o job (30 a 60 s após a queda). Valor inválido **impede a subida**. |
| `MAX_RECOVERIES` | 3 | Cada recuperação significa que uma execução morreu sem concluir nem falhar (OOM, kill, deploy). Por job, o BullMQ executa no máximo `maxStalledCount + 1` vezes antes de declarar "job stalled more than allowable limit". O maior `maxStalledCount` do CRM é 2 (o padrão é 1), então 3 abandonos esgotam o que a própria fila permitiria. Erros comuns não contam: eles seguem `MAX_FAILED_ATTEMPTS`. Corrige o L-2, o ciclo infinito processing → pending do reaper antigo. A constante é única, em `eventOwnership.js`. |
| `MAX_FAILED_ATTEMPTS` | 5 (inalterado) | Coincide com `attempts: 5` das filas. |
| Limite legado | 15 min de `createdAt` | Só para eventos sem posse e só depois da cerca. |

**Estado terminal:** `dead_letter`, com `error.code = RECOVERY_LIMIT_EXCEEDED` e `recoveryCount = 3`. Onde ele aparece:

- `GET /api/observability/dead-letters` e `/dead-letters/:eventId` (`listDeadLetters`, `getDeadLetterById`), agora com `recoveryCount`.
- `eventMonitor.getAlerts` (alerta `dead_letters` com `errorCode`), `getSystemHealth` e `getEventMetrics`, que contam `status: 'dead_letter'`.
- Alerta `critical` `event_recovery_limit` via `alertService.sendAlert`, tanto no reaper quanto na retomada direta. Leva só `eventId`, `eventType` e o número de recuperações, sem payload.
- Volta por `POST /api/observability/dead-letters/:eventId/retry` (admin) ou `scripts/reprocessDeadLetters.js`.

Testes: `dead_letter do limite aparece na listagem e volta por retry com orçamento zerado` e `retomada direta de posse vencida conta como recuperação`.

**Condição para ativar:** o `sendAlert` só envia para fora se `SLACK_WEBHOOK_URL` ou `ALERT_WEBHOOK_URL` estiverem definidas; senão o alerta fica só no log. Além disso, há um cooldown de 5 min por tipo, então vários `dead_letter` seguidos geram um alerta só (todos ficam na listagem). **Antes de ativar, confirmar um canal monitorado.**

## 4. Compatibilidade de implantação

Hoje os eventos rodam em dois serviços: `fono-inova-crm-back` (API, crons e reaper) e `crm-worker` (workers). O código antigo reivindica com `status:'processing'`, sem token e sem registro de início. **Não há como saber se uma execução antiga ainda roda.** Por isso existe a cerca `EVENT_LEGACY_FENCE_AT`, uma data ISO 8601 com fuso: o operador declara que, a partir dela, nenhum processo com o código antigo está de pé.

| Situação | Comportamento | Teste |
|---|---|---|
| `processing` sem token (código antigo), **sem cerca** ou com cerca no futuro | Nem o reaper nem uma execução nova liberam o evento. A execução nova recebe `EVENT_BUSY`, e o reaper conta e avisa (`reaper_legacy_awaiting_fence`, `legacyAwaiting`). | `sem a cerca, evento processing sem posse (código antigo) nunca é liberado` |
| `processing` sem token, cerca vencida | Critério legado: `createdAt` anterior a min(agora − 15 min, cerca). `null` conta como sem posse. | `com a cerca vencida: critério legado de 15 min` |
| Evento v2 (com token) | Só a posse decide. A cerca não interfere. | todos os testes de posse |
| Reinício do worker no meio de uma execução v2 | O prazo vence em até 60 s. A próxima entrega retoma (conta recuperação). Sem nova entrega, o reaper devolve o evento para `pending` em até 5 min. | `reinício: execução abandonada...` |
| Worker novo e reaper antigo convivendo | **Risco.** O reaper antigo devolve para `pending` qualquer `processing` com mais de 15 min de `createdAt`, inclusive uma execução v2 viva (L-1, como hoje), e não apaga o token. Nesse caso a conclusão do worker novo é recusada (`ownershipLost`) e o evento fica `pending`. **Mitigação: implantar a API (reaper) antes do worker.** | — |
| Reaper novo e worker antigo convivendo | Seguro. O reaper novo não toca eventos sem token sem a cerca. | idem |
| `EVENT_LEGACY_FENCE_AT` inválida | Os crons não sobem (`EVENT_LEGACY_FENCE_AT inválido`). | `EVENT_LEGACY_FENCE_AT: ... inválida falha claramente` |
| Reverter para o código antigo | Seguro. O código antigo ignora `processingToken`, `leaseExpiresAt` e `recoveryCount`. `dead_letter` já era conhecido. Eventos que ficarem `processing` com token voltam pelo reaper antigo (15 min). | — |

## 5. Runbook (cada passo pede OK do Kadu)

1. **Pré-requisitos.** PR #74 revisado. Backup Mongo do dia OK. Canal de alerta confirmado (seção 3).
2. **Implantar o CRM com dono `node`.** `EVENT_REAPER_OWNER` fica ausente (padrão `node`) e `EVENT_LEGACY_FENCE_AT` também. Ordem: primeiro a API (`fono-inova-crm-back`, que roda o reaper), depois o `crm-worker`. A melhor janela é com o worker suspenso (dias úteis depois das 19:10): ele volta às 07:30 já com o código novo.
3. **Declarar a cerca.** Depois de confirmar que os dois serviços rodam o commit novo e que não há instância antiga, defina `EVENT_LEGACY_FENCE_AT` com o instante da confirmação em UTC (ex.: `2026-11-20T11:00:00Z`). Isso reinicia o serviço. A partir daí, os eventos órfãos do código antigo voltam pelo critério de 15 min.
4. **Validar o protocolo v2 em produção (só leitura, 24 a 48 h).** Contagens no Mongo:
   - `status:'processing'` com e sem `processingToken`: sem token deve tender a 0 depois da cerca.
   - `dead_letter` com `error.code:'RECOVERY_LIMIT_EXCEEDED'`.
   - Logs `event_ownership_lost`, `event_busy`, `reaper_legacy_awaiting_fence` e `reaper_lost_race`.
5. **Go em sombra.** Precisa do usuário Mongo só leitura (decisão separada). Comando: `kas-event-reaper -mode shadow -protocol v2 -legacy-fence <mesmo valor> -report sombra.jsonl`. A sombra registra a decisão por `eventId` e, no ciclo seguinte, confere o que o reaper Node fez (`agree`, `still_processing`, `diverge`, `gone`). Critério para seguir: alguns dias com 0 `diverge`.
6. **Propor a troca de dono** (decisão do Kadu, com um canal de alerta da KAS monitorado). Para nunca haver dois executores:
   - `EVENT_REAPER_OWNER=kas` e reinício da API;
   - conferir nos logs que `[EventReaper]` sumiu;
   - subir o executor KAS (`-mode executor -protocol v2 -legacy-fence <mesmo valor>`, com usuário de escrita).
   A lacuna entre os dois é inofensiva, porque uma nova entrega retoma a posse vencida sem precisar do reaper.

**Reversão, passo a passo:**
- Passo 6: parar o executor KAS (ele libera o lease) e depois remover `EVENT_REAPER_OWNER` (volta a `node`) e reiniciar a API.
- Passo 5: parar a sombra. Ela não escreve nada.
- Passo 3: remover `EVENT_LEGACY_FENCE_AT` volta a proteger os eventos sem token.
- Passo 2: reimplantar o commit anterior nos dois serviços (API primeiro). Os campos novos ficam nos documentos e são ignorados.

## 6. D-1: worker de convênio

`insuranceOrchestratorWorker` passava `storedEvent.eventId` (uma string) para `processWithGuarantees`. Com isso o `eventId` ficava `undefined` e o evento nunca saía de `pending`. **Corrigido:**

- O worker passa o documento e o nome do worker.
- `processWithGuarantees` aceita string por compatibilidade.
- Sem `eventId`, não escreve no Event Store.
- O índice de `idempotencyKey` **não é único**. Por isso o worker passou a reaproveitar o evento já gravado com a mesma chave, e uma reentrega com posse viva vira erro retentável em vez de execução paralela.
- `processInsuranceJob` foi exportado para teste.

Observação: o worker está **desregistrado** em `workers/registry.js` desde 29/07/2026, porque a fila não recebe eventos. A correção vale para quando ele for religado. Testes: os 6 casos `D-1: ...` e `sem eventId...`.

## 7. Efeitos externos e idempotência

A posse protege **o registro** no `eventstore`. Ela não impede que uma execução que perdeu a posse já tenha disparado um efeito, nem que a próxima dispare de novo. O `AbortSignal` reduz a janela, mas não a elimina. **Não há garantia de processamento exatamente uma vez.** Nenhuma chamada real foi feita neste levantamento.

| Consumidor | Efeito | Proteção existente | Lacuna |
|---|---|---|---|
| `notificationOrchestratorWorker` | **WhatsApp** (`sendTextMessage`/`sendTemplateMessage`) e **e-mail** | Checa `eventExists(idempotencyKey)` e a existência do `eventId` antes de rodar | A checagem ocorre antes do envio, não de forma atômica. Uma reentrega depois do envio e antes do `processed` reenvia. Sem chave de idempotência no provedor. |
| `followupOrchestratorWorker` | **WhatsApp** de follow-up | Idem, mais uma janela de 5 min para `processing` | Igual à linha acima |
| `paymentWorker`, `appointment_payment` | `Payment`, vínculo no `Appointment`, ledger | `findOne` antes de criar e **índice único** `(appointment, billingType, paymentRole)`; ledger com **índice único** `(correlationId, type)` | Protegido no banco |
| `paymentWorker`, `multi_payment` | `Payment`, débito em `PatientBalance` (transação) e ledger | Lock por paciente (`withLock`) e ledger único | **Sem chave de idempotência no Payment nem no saldo.** Uma reentrega depois do commit e antes do `processed` duplica o pagamento e o débito. |
| `paymentWorker`, `standalone` e `balance_credit` | `Payment` avulso e crédito em `PatientBalance` (`$push`/`addCredit`) | Só o ledger (correlationId) | **Duplica o pagamento avulso e o crédito** em reentrega |
| `paymentWorker`, `PAYMENT_COMPLETED` (webhook) | Marca pago e grava no ledger | Ledger com `correlationId` | Sem `correlationId` no payload, o fallback é `webhook_${Date.now()}`, que anula a deduplicação do ledger. A integração Sicoob ainda é TODO (sem chamada externa no worker). |
| `invoiceWorker` | Faturas internas | `findOne` por appointment e `idempotencyKey` por paciente/mês | Checagem não atômica (sem índice único) |
| `createAppointmentWorker`, `evolutionWorker`, `commissionGenerationWorker` | Escritas no Mongo e `publishEvent` | `findOne` antes de criar | Sem índice único. Cada `publishEvent` gera um job novo. |
| `insuranceOrchestratorWorker` | Transação e `saveToOutbox` | Agora com posse (D-1) e reaproveitamento por chave | Desregistrado. `saveToOutbox` usa um `eventId` aleatório por execução. |

**Prioridade sugerida (fora deste PR):**
1. Pagamentos `multi_payment`, `standalone` e `balance_credit`: chave de idempotência derivada do `eventId`, com índice único dentro da mesma transação.
2. WhatsApp e e-mail: registro "enviado" por (`eventId`, canal, destino) gravado de forma atômica antes do envio.
3. Webhook de pagamento: exigir `correlationId`.

## 8. Testes locais

Arquivo: `tests/eventstore/ownership.mongo.nodetest.mjs` (`node:test`, Mongo descartável em loopback, dados fictícios).

```bash
docker run -d --name crm-posse-mongo -p 127.0.0.1:27017:27017 mongo:7 --replSet rs0 --bind_ip_all
docker exec crm-posse-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' npm run test:eventstore-posse
```

**Resultado em 18/11/2026: 28 de 28 passaram** (Node 22.23.5, Mongoose 8.24.3, MongoDB 7.0.48). Os casos cobertos:

- worker lento;
- conclusão simultânea ao reaper (200 eventos);
- perda de posse;
- renovação entre a leitura e a escrita do reaper;
- valor bruto (null e tipos inesperados);
- reinício;
- dois reapers (300 eventos);
- esgotamento pelo reaper, pela retomada direta e pelos dois somados;
- falha comum que não consome recuperações;
- falhas retentáveis até `dead_letter`;
- escrita sem token contra posse viva;
- cerca ausente, futura e vencida;
- flags inválidas;
- D-1 (6 casos);
- `dead_letter` listado e recuperado por retry.

**Regressão (`npx vitest run tests/unit`):** 1.766 passaram e 17 falharam, o **mesmo conjunto antes e depois** da mudança. São falhas antigas, sem relação com esta mudança. `tests/integration/appointment-create-event-driven.test.js` também falha igual antes e depois, por um mock incompleto que já existia.

## 9. Limites que restam e achados

- **S-1 (segurança, já existia, fora deste PR):** `GET /api/observability/dead-letters/:eventId` devolve o `payload` do evento **sem autenticação** (`observabilityRoutes.js`; só os POST de retry exigem admin). O repositório é público. Recomendo um PR separado que ponha `auth` nos GET de observabilidade, no mesmo modelo do PR #71.
- **Órfão em `pending` (já existia):** o reaper devolve o evento para `pending`, mas não republica o job. Se o BullMQ já desistiu do job, nada reprocessa o evento. `getPendingEvents` não tem chamadores. Fica visível em `eventMonitor` (contagem de `pending`).
- **Monitor quebrado (já existia):** `eventMonitor` procura `processing` antigos e falhas recentes por `updatedAt`, mas o schema desliga `updatedAt`, então essas contagens dão sempre 0.
- **`idempotencyKey` sem índice único:** duas primeiras entregas simultâneas ainda podem gravar dois eventos com a mesma chave. Criar o índice único é migração de dados de produção e fica para decisão separada.
- **Escritas sem token** só respeitam uma posse viva; duas delas concorrentes ainda se sobrescrevem, como hoje.
- **Relógio:** o prazo usa o relógio do processo Node. Uma diferença grande entre instâncias reduz a margem de 60 s. Mitigação futura: `$$NOW` do servidor, como na KAS.
