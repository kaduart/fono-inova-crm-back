# Idempotência de pagamentos: multi_payment, standalone e balance_credit

Escopo: os três tipos de `PAYMENT_PROCESS_REQUESTED` que movem dinheiro sem agendamento, no `workers/paymentWorker.js`. `appointment_payment` e o webhook de confirmação não mudaram.

## 1. Caminhos rastreados

| Origem | Chave antiga | Caminho no worker |
|---|---|---|
| `POST /api/v2/payments/request` com `type=standalone` | `payment_<paciente>_<valor>_<Date.now()>` (única por requisição) | `processStandalonePayment` |
| `POST /api/v2/payments/request` com `type=balance_credit` | igual à anterior | `processBalanceCredit` |
| `POST /api/v2/payments/request` com `type=multi_payment` | igual à anterior | `withLock` e depois `processMultiPayment` |
| `POST /api/v2/payments/balance/:patientId/multi` | `payment_multi_<paciente>_<débitos ordenados>` (natural) | `withLock` e depois `processMultiPayment` |

Antes desta mudança, o job fazia três coisas:
- consultava o EventStore por `eventId` e `idempotencyKey` (consulta antes da gravação);
- gravava um evento `PAYMENT_CREATE_REQUESTED`;
- rodava o processador dentro de `processWithGuarantees`.

Nenhuma escrita de dinheiro carregava identidade da operação.

Uma reentrega aplicava a operação de novo nesses casos:
- retry do BullMQ;
- job travado (stalled);
- reaper liberando o evento;
- dois workers.

## 2. Identidade estável

`operationKey = payop:<tipo>:<idempotencyKey do evento ou eventId>` (`services/paymentOperations.js`).

- **multi_payment**: chave natural `payment_multi_<paciente>_<débitos ordenados>`, agora também na rota `/request`. Pagar os mesmos débitos é a mesma operação.
- **standalone e balance_credit**:
  - Com o cabeçalho `Idempotency-Key` (8 a 128 caracteres `[A-Za-z0-9._:-]`), a chave é `payment_<tipo>_<paciente>_<cabeçalho>`. Fica estável entre reenvios HTTP.
  - Sem o cabeçalho, a chave é única por requisição. Protege reentrega, retry e reinício, mas não um segundo clique que gera outra requisição. Para cobrir o segundo clique, o front precisa enviar `Idempotency-Key`. Essa pendência é do front.
- **Impressão digital** (SHA-256): só os campos financeiros.
  - multi_payment: paciente, débitos ordenados, total e métodos com valores.
  - Os outros dois tipos: paciente, valor e método.
  - Notas, `requestedAt` e `correlationId` ficam fora, porque mudam a cada reenvio.

## 3. Garantia

`runPaymentOperation` abre uma transação e, dentro dela:

1. insere `payment_operations { _id: operationKey, requestHash, ... }`;
2. grava Payment, PatientBalance, Appointment (multi) e o lançamento do ledger, todos com a mesma session;
3. completa o registro com `paymentId` e `result`.

| Situação | Resultado |
|---|---|
| Mesma chave, mesmo conteúdo, depois do commit | Devolve o resultado gravado (`replayed: true`); `replays` sobe |
| Mesma chave concorrente | Uma transação aplica. As outras recebem WriteConflict, o driver repete e depois cai em `E11000` no `_id`, e elas devolvem o resultado gravado |
| Mesma chave, conteúdo diferente | `IDEMPOTENCY_KEY_CONFLICT` (`NonRetryableError`, vai para dead_letter). A API devolve 409 quando acha o evento antes |
| Falha no meio (exceção, queda, timeout) | A transação aborta: sem Payment, sem saldo, sem ledger, sem registro. O retry aplica uma vez |
| Reinício entre o commit e os efeitos posteriores | `sideEffectsAt` fica nulo. A reentrega devolve `sideEffectsPending: true` e o worker refaz os efeitos |

A consulta antes da transação é só atalho. A proteção é o índice único de `_id`, que existe em qualquer coleção do MongoDB, inclusive em produção, sem migração.

### Efeitos depois do commit: pelo menos uma vez

São eles:
- `PaymentsView`;
- invalidação de cache;
- os eventos `PAYMENT_COMPLETED`, `TOTALS_RECALCULATE_REQUESTED`, `DAILY_CLOSING_REQUESTED` e `NOTIFICATION_REQUESTED` (este último só no multi).

Eles saem com `idempotencyKey = <operationKey>:<efeito>`. O publisher descarta a repetição quando o evento anterior já está `processing` ou `processed`. Fora dessa janela, podem repetir.

A notificação (WhatsApp ou e-mail) pode ser reenviada se o processo cair entre o envio e `sideEffectsAt`. Isso **não** é exatamente uma vez.

## 4. Correções de comportamento

O teste reproduziu três defeitos no código anterior, com o mesmo formato de escrita.

| Id | Defeito antigo | Evidência | Correção |
|---|---|---|---|
| B-1 | `balance_credit` fazia `$inc currentBalance: +valor`, aumentando a dívida. No resto do sistema (`addCredit`, quitação de pacote, multi), crédito reduz `currentBalance` | Comparação com `PatientBalance.addCredit`, `addPayment` e as 7 quitações que fazem `$inc currentBalance: -valor` | `-valor` e `totalCredited += valor` |
| B-2 | multi criava Payment `status: 'paid'` sem `paidAt`; o guarda do Payment (`MISSING_PAID_AT`) recusava | Teste falhou com `MISSING_PAID_AT` antes da correção | `paidAt` preenchido |
| B-3 | multi fazia `$set transactions.$[debit]` e `$push transactions` no mesmo update; o MongoDB recusa (código 40) | Teste falhou com "would create a conflict at 'transactions'" | Duas escritas na mesma transação |
| B-4 | multi "pagava" débito já pago e abatia o saldo de novo | Filtro sem `isPaid` | Filtro exige todos os débitos existentes e em aberto; senão `MULTI_PAYMENT_DEBITS_NOT_PAYABLE` (não retentável) |
| B-5 | standalone gravava o Payment e depois o saldo e o ledger fora de transação; um erro no saldo era engolido | Código | Tudo numa transação |

B-2 e B-3 indicam que o pagamento múltiplo pelo worker **não concluía** em produção com este código. O preflight (seção 5) conta quantos Payments de pagamento múltiplo existem, para confirmar.

B-1 muda o sinal de um lançamento de dinheiro. **Precisa da sua confirmação** antes do merge. Se o comportamento antigo era intencional, reverter é trocar `BALANCE_CREDIT_SIGN` para `+1`.

## 5. Dados existentes (implantação futura)

Script: `scripts/migrations/2026-11-18-payment-operations-preflight.js`.

- **Sem `--apply`**: só leitura. Relata:
  - A) avulsos repetidos (mesmo paciente e valor em 10 min, sem `operationKey`);
  - B) créditos repetidos no saldo;
  - C) créditos em conta legados com o sinal de B-1;
  - D) quantidade de Payments de pagamento múltiplo.
- **Com `--apply`**: cria a coleção `payment_operations` e os índices secundários `patient_1_appliedAt_-1` e `side_effects_pending`. O `autoIndex` é desligado em produção.

Roteiro sugerido, cada passo com seu OK:

1. Rodar o relatório numa cópia do banco, nunca na produção direto.
2. Decidir caso a caso A e B (estornar ou manter) e C (lançar ajuste de 2× o valor, ou não). Nada é corrigido automaticamente.
3. Rodar `--apply` antes do deploy do worker novo. Sem ele o código funciona, mas as consultas por paciente ficam sem índice.
4. Depois do deploy, acompanhar `payment_operations` com `sideEffectsAt: null` e `appliedAt` com mais de 10 min (efeitos pendentes).

Testado só no banco descartável (teste 15).

## 6. Compatibilidade e reversão

- Jobs antigos na fila continuam válidos. A chave vem do `idempotencyKey` que já está no job, ou do `eventId`.
- Uma operação aplicada pelo código antigo **não tem** registro em `payment_operations`. Se for reentregue depois do deploy, aplica de novo, porque o código antigo não deixou marca. Por isso, esvazie ou aguarde a fila `payment-processing` antes da troca.
- Reverter o código deixa `payment_operations` e os campos `operationKey` órfãos, que são inofensivos. As operações feitas no meio-tempo ficam corretas.

## 7. Testes

Comando:

```
MONGO_TXN_TEST_URI='mongodb://127.0.0.1:27017/?directConnection=true' npm run test:pagamentos-idempotencia
```

- Precisa de replica set descartável em loopback.
- São 15 casos: identidade; aplicação atômica; repetição; 12 concorrentes; conflito sequencial e concorrente; falha intermediária; reinício; chaves distintas; corrida de criação do saldo; balance_credit; multi (concorrência, débito já pago, chaves concorrentes, débito inexistente); preflight.
- O CI sobe um Mongo replica set separado na porta 27018 e roda esse comando.
- Suíte vitest local, main contra esta branch no mesmo ambiente: o mesmo conjunto de falhas, sem regressão nova. É **ambiente sem Redis**, então não equivale ao CI.

## 8. Rotas paralelas (create-sync, bulk-settle, PATCH, crédito direto) e B-1

Rodada de 18/11 (noite). Estas rotas movem dinheiro **fora** do `/request` e do `/receive`. As regras financeiras continuam no CRM; só a identidade da operação e a resposta à repetição mudaram.

| Rota | Antes | Agora |
|---|---|---|
| `POST /v2/payments/create-sync` (marcar sessão avulsa como paga) | Repetição: 500 (o índice `unique_active_payment_per_appt_billingtype_role` barrava o 2º Payment, mas a tela via erro). Concorrência: 500 por conflito de escrita. Sem `Idempotency-Key` | Com `Idempotency-Key`: recibo `payop:create_sync:...` em `payment_operations` na mesma transação; repetição devolve o mesmo Payment (200, `idempotent: true`); mesma chave com outro valor ou agendamento: 409 `IDEMPOTENCY_KEY_CONFLICT`. Sem chave, com agendamento: devolve o Payment ativo do agendamento. Conflito simultâneo: 409 `PAYMENT_IN_PROGRESS` (nada gravado por aquela requisição) |
| `POST /v2/payments/bulk-settle` | Já deduplicava pelo conjunto (`bulkSettlementKey`) e pelo filtro `status: 'pending'`. Repetição respondia **409** (erro na tela de algo que deu certo) | Repetição devolve o **mesmo recibo** (200, `idempotent: true`, `code: BULK_SETTLEMENT_ALREADY_EXISTS`). Conflito simultâneo: 409 `PAYMENT_IN_PROGRESS` |
| `PATCH /v2/payments/:id` | Concorrência: 500 (conflito de escrita). **Pagar → estornar → pagar no mesmo dia falhava** com 500: o evento do Outbox tinha o mesmo `eventId` do dia e o E11000 abortava a transação | Conflito simultâneo: 409 `PAYMENT_IN_PROGRESS`. A mesma transição de novo no dia ganha `eventId` com sufixo `_rN`. `saveToOutbox` com session verifica antes de inserir (o E11000 dentro de transação aborta tudo) |
| `POST /v2/balance/:patientId/credit` → `balanceWorker` | **Reentrega do evento creditava de novo** (o worker só lembrava do evento num `Map` em memória: reinício, retry ou 2 workers creditavam 2×, 3×...). **Sem chave, todo crédito do paciente tinha a mesma chave** (`<paciente>_balance_credit`): depois do primeiro processado, os seguintes eram descartados como duplicados e a rota respondia 202 "enfileirado". Debounce também respondia 202 sem enfileirar | Crédito + recibo `payop:balance_credit_direct:<idempotencyKey>` na mesma transação. Com `Idempotency-Key`: chave estável, repetição devolve o mesmo `eventId`, outro valor é 409. Sem chave: chave única por requisição; clique duplo em 5 s é 409 `PAYMENT_DEBOUNCED` (não mais 202 falso) |

Front (`fono-inova-crm-front`): `createSyncPayment` e `bulkSettlePayments` em `src/services/paymentService.ts` mandam `Idempotency-Key` pelo mesmo remetente do `/request`. O crédito direto não é chamado pelo front hoje.

### B-1 esclarecido

Convenção do sistema, conferida no código: `currentBalance > 0` = paciente **deve**.
- `completeSessionService.v2.js` e `particularHandler.js`: `financialStatus = currentBalance > 0.001 ? 'unpaid' : 'paid'`.
- `financialMetrics.service.js`: "saldo devedor total = soma de `currentBalance > 0`".
- `PatientBalance.addCredit`: `currentBalance -= valor`.

Logo crédito **reduz** `currentBalance`. Testes que fixam isso nos três caminhos de crédito:
- `paymentWorker` `balance_credit` (teste "balance_credit: crédito reduz o saldo devedor", em `paymentIdempotency.mongo.nodetest.mjs`): 500 − 180 = 320;
- `balanceWorker` crédito direto (`rotasParalelas`): dívida 220 + crédito 220 = 0;
- `PatientBalance.addCredit` (`rotasParalelas`): 300 − 100 = 200.

O que **não** dá para afirmar daqui: se algum crédito antigo em produção foi gravado com o sinal invertido. O preflight de 18/11 (rodado pelo Kadu, só leitura) contou C = 0, então não há dado legado a corrigir.

### O que continua sem garantia

- Sem `Idempotency-Key` e sem agendamento, `create-sync` cria um lançamento por requisição (é como o front antigo funciona).
- Sem chave, dois créditos diretos iguais com mais de 5 s entre eles são duas operações.
- Os efeitos depois do commit (projeções, cache) continuam pelo menos uma vez.
- O índice `unique_active_payment_per_appt_billingtype_role` é definido no modelo; em produção o `autoIndex` é desligado. Sem ele, a corrida de `create-sync` sem chave ainda é serializada pela escrita no mesmo `Appointment` dentro da transação.

### Testes

```
MONGO_TXN_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' REDIS_URL=redis://127.0.0.1:6479 \
  npm run test:pagamentos-rotas-paralelas
```

21 casos: create-sync (6), bulk-settle (4), PATCH (3), crédito direto (6), B-1 (2). Contra o código anterior, 12 dos 19 casos iniciais falhavam (o crédito reentregue chegou a creditar 4×; os 2 casos de crédito sem chave foram escritos depois, a partir do achado).
