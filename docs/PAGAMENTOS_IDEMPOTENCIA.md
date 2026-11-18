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
