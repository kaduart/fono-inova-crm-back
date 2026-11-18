# Quantos dispatchers do Outbox sobem

Este documento separa duas coisas:

- **(A) o que o código e a configuração de teste dizem**, verificado por teste;
- **(B) o que está ativo no Render**, que só se confirma com evidência operacional (logs e variáveis do painel). Esta parte **não** foi verificada nesta rodada.

## A. Pelo código (verificado)

Há dois pontos que iniciam `startOutboxDispatcher` em `workers/registry.js`, os dois **ligados por padrão** (variável ausente = ligado):

| Grupo | Flag | Padrão |
|---|---|---|
| `outbox` | `ENABLE_OUTBOX_DISPATCHER` | ligado |
| `reconciliation` | `ENABLE_RECONCILIATION_OUTBOX` | ligado |

| Forma de subir | Grupos | Dispatchers (flags no padrão) |
|---|---|---|
| `server.js` com `ENABLE_WORKERS=true` e sem `WORKER_GROUP` válido (monolito) | todos | **2** |
| `server.js` com `ENABLE_WORKERS=false` (CI, `dev:api:full`) | nenhum | 0 |
| `whatsapp-only.js` (Start Command do crm-worker) | scheduling, billing, clinical, reconciliation | 1 |
| `core-worker.js` | scheduling, billing, clinical, reconciliation | 1 |
| `reconciliation-worker.js` | reconciliation | 1 |
| `startWorkers.js` com `WORKER_GROUP=all` (`npm run dev:worker`) | scheduling, whatsapp, billing, clinical, reconciliation | 1 |
| `billing`/`clinical`/`scheduling`/`whatsapp-worker.js` | um grupo cada | 0 |

O `render.yaml` do repositório (que não reflete o que roda, ver B) descreve `fono-inova-crm-api` com `ENABLE_WORKERS=false` (0), mais `crm-worker-reconciliation` (1) e `crm-worker-whatsapp` com `whatsapp-only.js` (1). Somando, são **2** dispatchers se os dois workers estiverem de pé.

Teste: `tests/outbox/dispatcherCount.nodetest.mjs` (`npm run test:dispatchers-contagem`). Quebra se alguém mudar grupos, flags ou entrypoints sem atualizar esta tabela.

## Evidência rodando os processos (verificado em 18/11)

`scripts/e2e/contar-dispatchers-por-processo.sh` sobe cada forma real de iniciar o CRM contra Mongo e Redis descartáveis em loopback, sem `.env`, com chaves fictícias e crons desligados. O script espera o boot e conta `[OutboxDispatcher] Iniciado` no log de cada processo:

```
server.js ENABLE_WORKERS=false (API como no render.yaml)   dispatchers=0
server.js ENABLE_WORKERS=true sem WORKER_GROUP (monolito)  dispatchers=2
whatsapp-only.js (Start Command do crm-worker)             dispatchers=1  grupos: billing clinical reconciliation scheduling
reconciliation-worker.js                                   dispatchers=1  grupos: reconciliation
whatsapp-only.js com ENABLE_RECONCILIATION_OUTBOX=false    dispatchers=0
```

O resultado bate com a contagem pelo código. Isto é evidência do **código**; o que roda no Render continua sendo a parte B.

## O que acontece com mais de um dispatcher (verificado em teste)

O dispatcher legado **não reserva** o evento. Ele lê `pending` e publica. Dois dispatchers leem o mesmo lote e os dois tentam publicar.

- **Job duplicado não acontece** enquanto o job anterior ainda existe no Redis. O `jobId` é determinístico (`<eventId>__<fila>`) e o BullMQ ignora o segundo `add`. Teste: `tests/outbox/dispatchersConcorrentes.mongo.nodetest.mjs`, com 2 dispatchers sobre 40 eventos, gera 40 jobs.
- **Risco residual:** as filas com `removeOnComplete` (por exemplo `payment-processing`, que guarda os últimos 100) apagam jobs concluídos. Se um dispatcher atrasado publicar um evento cujo job já foi concluído *e removido*, o job roda de novo. Os consumidores de pagamento já são idempotentes por operação (`payment_operations`), mas isso não vale para todos os consumidores.
- O trabalho é repetido: os dois dispatchers fazem as mesmas leituras e escritas.
- **Evento `failed` não volta sozinho.** O poller só lê `pending`. Um evento que o dispatcher marcou como `failed` fica parado até haver uma recuperação externa (corte KAS de recuperação de `failed`, kas-core #11).

## B. No Render (não verificado nesta rodada)

Inventário lido em 18/11 (memória do projeto):
- `crm-worker` roda `whatsapp-only.js`, ou seja, **1 dispatcher enquanto está de pé**. Ele é suspenso das 19:10 às 07:30 nos dias úteis e no fim de semana, e **nesse período o Outbox não é despachado**.
- `fono-inova-crm-back` (web): **depende de `ENABLE_WORKERS`**. Se estiver `true` sem `WORKER_GROUP`, sobe mais 2 dispatchers (total 3 de dia, 2 à noite).

Daqui não há acesso ao Render: a API (`api.render.com`) é recusada pelo proxy desta sessão e não existe chave configurada. O que o Kadu precisa conferir no painel (só leitura) para fechar este item:
1. Variáveis `ENABLE_WORKERS`, `WORKER_GROUP`, `ENABLE_OUTBOX_DISPATCHER` e `ENABLE_RECONCILIATION_OUTBOX` em `fono-inova-crm-back` e em `crm-worker`.
2. Nos logs de cada serviço, quantas vezes aparece `[OutboxDispatcher] Iniciado` desde o último deploy.
