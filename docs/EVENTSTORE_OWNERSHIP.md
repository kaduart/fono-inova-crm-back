# Posse de execução no Event Store

Data: 18/11/2026. Branch: `feat/eventstore-posse` (a partir da `main` em `12bd210`).

**Estado:** código e testes locais prontos. Nada foi ativado, publicado ou conectado a produção. **Nenhuma flag foi ligada.** Só há a flag nova `EVENT_REAPER_OWNER`, com padrão `node`, que preserva o comportamento de hoje quanto a quem roda o reaper.

## 1. Mapa: quem reivindica, conclui, falha e recupera eventos do `eventstore`

| Caminho | Antes | Agora |
|---|---|---|
| **Reivindicar**: `processWithGuarantees` (`infrastructure/events/eventStoreService.js`) | `updateOne({eventId}, {status:'processing'})`, sem condição, sem dono, sem prazo | `claimEvent`: atômico, só a partir de `pending`/`failed`, de posse vencida ou de `processing` legado sem posse com mais de 15 min. Grava `processingToken`, `processingOwner`, `processingStartedAt` e `leaseExpiresAt`. |
| Chamadores de `processWithGuarantees` | createAppointmentWorker, notificationOrchestratorWorker, followupOrchestratorWorker, commissionGenerationWorker, evolutionWorker, paymentWorker, invoiceWorker (3 pontos), insuranceOrchestratorWorker | Sem mudança no chamador. O processador recebe um 2º argumento opcional `{ signal, token, eventId }`. |
| **Concluir** dentro de `processWithGuarantees` | `markEventProcessed` faz `doc.save()` por `_id`, sem condição | `completeOwned`: só se `status:'processing'` e o token for o mesmo. Limpa a posse. |
| **Falhar** dentro de `processWithGuarantees` | `$inc attempts` por `eventId`, sem condição; `dead_letter` com 5 | `failOwned`/`deadLetterOwned`: condicionais ao token. A promoção a `dead_letter` com 5 também é condicional. |
| **Concluir/falhar sem token** (`markEventProcessed`/`markEventFailed`/`markEventDeadLetter` chamados direto) | `appointmentWorker` (6), `updateOrchestratorWorker` (4), `commissionGenerationWorker`, `createAppointmentWorker`, `whatsappInboundWorker`, `messagePersistenceWorker` | Continuam funcionando, mas **não passam por cima de uma posse viva** de outra execução: o filtro exige que não haja token ou que o prazo esteja vencido. |
| **Recuperar**: `crons/eventReaper.cron.js` | `createdAt` > 15 min; `updateOne({eventId})` sem condição; não conta recuperações | Prazo de posse vencido, ou critério legado para eventos sem posse. Escrita condicional ao estado, token, prazo e `recoveryCount` observados, comparando o valor bruto (driver direto, sem cast do Mongoose; `null` casa só `null`, ausente casa só ausente). Conta `recoveryCount` e manda para `dead_letter` com alerta no limite. |
| Recuperar: `deadLetterService.reprocess` (`infrastructure/observability/deadLetterService.js:167`) | Reset manual de `dead_letter` para `pending` | Sem mudança (ação manual de admin) |
| Outros escritores | `syncMedicalWorker` (upsert de `processed`), `completeOrchestratorWorker`/`preAgendamentoTriage` (create), `scripts/heal-pending-appointments.js` (script manual) | Sem mudança. Não reivindicam execução. |
| Código morto | `infrastructure/workers/watchdog.js` e `watchdogBullmq.js` (não são importados; filtram por `updatedAt`, que não existe) | Sem mudança. Recomendo remover numa limpeza separada. |

## 2. Protocolo

1. **Reivindicar.** `claimEvent` gera um `processingToken` aleatório (UUID) por execução e um prazo `leaseExpiresAt = agora + EVENT_LEASE_MS`.
2. **Renovar.** Enquanto o processador roda, a posse é renovada a cada `EVENT_LEASE_MS/3`, de forma condicional ao token. Se a renovação descobre que a posse foi perdida, o `AbortSignal` entregue ao processador é abortado.
3. **Concluir, falhar ou ir para `dead_letter`.** Só gravam com o token. Uma execução que perdeu a posse **não altera o evento**: ela registra `event_ownership_lost` e devolve `{ success:false, ownershipLost:true }`, **sem lançar erro**. Lançar faria o BullMQ repetir efeitos que já aconteceram.
4. **Entrega duplicada com posse viva.** `processWithGuarantees` lança `EventBusyError` (`code: EVENT_BUSY`, retentável). O BullMQ tenta de novo com backoff, e a posse abandonada vence em `EVENT_LEASE_MS`.
5. **Evento já `processed`.** Não roda de novo e devolve `{ success:true, skipped:true, reason:'already_processed' }`. **Mudança de comportamento:** antes, o processador rodava de novo.
6. **Evento em `dead_letter`.** Não roda e devolve `{ success:false, skipped:true, reason:'dead_letter' }`. Para reprocessar, use o fluxo de admin do `deadLetterService`.
7. **Evento fora do `eventstore`** (vários chamadores passam chaves de idempotência que não são eventos gravados). Segue o caminho legado sem posse, como antes.

### Números e por quê

| Parâmetro | Valor | Justificativa |
|---|---|---|
| `EVENT_LEASE_MS` | 60.000 (renovação a cada 20 s) | Os workers BullMQ do CRM usam `lockDuration`/`stalledInterval` de 30 s. O dobro tolera uma renovação perdida (event loop travado por menos de 40 s) e deixa a execução abandonada retomável logo depois da redistribuição de job travado do BullMQ (30 a 60 s após a queda). Valor inválido (fora de 1.000 a 1.800.000) **impede a subida**. |
| `MAX_RECOVERIES` (reaper) | 3 | O maior `maxStalledCount` dos workers é 2 (o padrão do BullMQ é 1). Depois de 2 abandonos o BullMQ já não reentrega o job, então um 3º abandono indica um evento que derruba o worker (como o OOM de 13/11) e vai para o estado terminal. Corrige o L-2 (loop infinito). |
| `MAX_FAILED_ATTEMPTS` | 5 (inalterado) | Já existia e coincide com `attempts: 5` das filas (`queueConfig.js`, `eventPublisher.js`). |
| Limite legado | 15 min de `createdAt` | Só para eventos `processing` **sem** posse, gravados por código anterior durante a transição. |

**Estado terminal:** `dead_letter`, que os consumidores já conhecem (`listDeadLetters`, reprocessamento de admin e `eventMonitor`), com `error.code = RECOVERY_LIMIT_EXCEEDED` e alerta `critical` do tipo `event_recovery_limit` via `alertService.sendAlert`. O alerta leva só `eventId`, `eventType` e o número de recuperações, sem `payload`.

## 3. `EVENT_REAPER_OWNER`

Lido em `config/cronManager.js` antes de iniciar qualquer cron:

- ausente ou vazio: `node`, que mantém o comportamento de hoje (o reaper Node roda);
- `kas`: o reaper Node **não** inicia; o da KAS Core assume;
- qualquer outro valor: erro `EVENT_REAPER_OWNER inválido: "..."` e o processo encerra (`process.exit(1)`, tanto em `server.js` quanto em `cron-worker.js`).

`ENABLE_CRONS` não é usado para isso, porque desliga todos os crons.

## 4. Testes locais

O arquivo é `tests/eventstore/ownership.mongo.nodetest.mjs`. Ele usa `node:test`, Mongo descartável em loopback e dados fictícios.

```bash
docker run -d --name crm-posse-mongo -p 127.0.0.1:27017:27017 mongo:7 --replSet rs0 --bind_ip_all
docker exec crm-posse-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
MONGO_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' npm run test:eventstore-posse
```

| Cenário pedido | Teste |
|---|---|
| Worker lento | `worker lento: a posse é renovada e o reaper não retoma` (posse de 300 ms, processamento de 1,3 s, reaper rodando a cada 100 ms) |
| Conclusão simultânea ao reaper | `conclusão simultânea ao reaper: nunca as duas coisas` (200 eventos; cada um termina concluído **ou** recuperado, nunca os dois) |
| Perda de posse | `perda de posse: worker travado não conclui depois que outro retomou` (event loop travado, outro worker retoma, o antigo não conclui, não falha, não renova e recebe o `AbortSignal`) |
| Reinício | `reinício: execução abandonada é retomada pelo reaper e reprocessada` |
| Dois reapers | `dois reapers ao mesmo tempo: cada evento recuperado uma vez` (300 eventos) |
| Esgotamento | `esgotamento: 3º abandono vai para dead_letter com alerta` e `falhas retentáveis: dead_letter na 5ª, como antes` |
| Entrega duplicada | `segunda entrega concorrente encontra posse viva e recebe erro retentável` |
| Compatibilidade | escrita legada sem token, `processing` antigo sem posse, evento fora do Event Store, flags inválidas |

**Resultado em 18/11/2026:** 14 de 14 passaram, em 5 execuções seguidas. Versões: Node 22.23.5, Mongoose 8.24.3, MongoDB 7.0.48.

**Regressão (`npx vitest run tests/unit`):** 1.766 passaram e 17 falharam, **o mesmo conjunto de falhas antes e depois** da mudança, comparado arquivo a arquivo. As falhas já existiam e não têm relação com esta mudança. O teste de integração `tests/integration/appointment-create-event-driven.test.js` falha igual antes e depois, por causa de um mock incompleto (`isAgendaChannel` em `amandaAuth.js`), que também já existia. Para rodar sem baixar o mongod: `MONGOMS_VERSION=7.0.48 MONGOMS_SYSTEM_BINARY=<mongod 7>`.

## 5. Efeitos externos: o que a proteção do registro não cobre

A posse protege **o registro** no `eventstore`. Ela não impede que um worker antigo já tenha disparado um efeito antes de perder a posse, nem que o mesmo efeito seja disparado de novo pela nova execução. O `AbortSignal` reduz a janela se o processador checar `signal.aborted` antes do efeito, mas não a elimina: entre a checagem e o envio, a posse pode cair. **Não há garantia de processamento exatamente uma vez.**

| Worker | Efeito | Risco se repetir | Proteção necessária |
|---|---|---|---|
| `notificationOrchestratorWorker` | **WhatsApp e e-mail** para paciente | Mensagem duplicada ao paciente | **Idempotência no envio:** registro "enviado" por (`eventId`, canal, destino) gravado de forma atômica antes do envio, ou chave de idempotência no provedor quando houver. Checar `signal.aborted` imediatamente antes de enviar. |
| `followupOrchestratorWorker` | **WhatsApp** (`sendTextMessage`) | Follow-up duplicado | Igual à linha acima |
| `paymentWorker` | Registro de pagamento (transação Mongo; referências de Pix) | Pagamento ou saldo duplicado | Unicidade no domínio (índice único por pagamento ou idempotencyKey) dentro da mesma transação; conferir o que já existe antes de mudar |
| `invoiceWorker` | Faturas internas e lembretes | Fatura ou lembrete duplicado | Índice único por (paciente, mês) ou idempotencyKey e lembrete com registro de envio |
| `createAppointmentWorker`, `commissionGenerationWorker`, `evolutionWorker` | Escritas no Mongo e `publishEvent` | Documento duplicado; novos jobs | Unicidade no domínio. `publishEvent` gera um job novo a cada chamada (não há `jobId` fixo), então o consumidor precisa ser idempotente. |
| `insuranceOrchestratorWorker` | Transação e `saveToOutbox` | — | **Não usa a posse** (ver D-1) |

## 6. Limites que restam e achados

- **D-1 (preservado, não corrigido):** `insuranceOrchestratorWorker` chama `processWithGuarantees(storedEvent.eventId, fn)` com uma string. O `eventId` fica `undefined`; antes, o evento nunca era marcado como `processing` nem `processed`, e agora ele cai no caminho sem posse com o mesmo efeito. A correção é de uma linha (passar o objeto), mas muda o comportamento de convênios, por isso fica para decisão separada.
- **Escritas sem token** (`markEventProcessed` direto) só respeitam uma posse **viva**. Elas não têm dono próprio, então duas dessas escritas concorrentes ainda podem sobrescrever uma à outra, como hoje.
- **Relógio:** o prazo de posse usa o relógio do processo Node. Uma diferença de relógio entre instâncias maior que alguns segundos reduz a margem de 60 s. Mitigação futura: usar `$$NOW` do servidor, como a KAS faz.
- **Transição:** durante o deploy, eventos reivindicados pelo código antigo ficam sem posse e seguem o critério legado de 15 min.
- **`eventMonitor.js:501`** conta `processing` antigos por `updatedAt`, que não existe, e por isso sempre devolve 0. Achado lateral, sem mudança aqui.
