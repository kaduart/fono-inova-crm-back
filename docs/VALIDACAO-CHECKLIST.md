# Checklist de validação da migração CRM → KAS Core

Atualizado em 18/11/2026, 21h UTC. Merge e deploy dependem do Kadu. Nenhum corte da KAS está ativo em produção.

## Estado por entrega (rodada de 18/11, noite)

As colunas separam quatro coisas: **implementado** (código e testes numa branch), **mergeado** (na `main`), **implantado** (o que se sabe do deploy) e **verificado** (o que foi conferido, e onde).

| Entrega | Implementado | Mergeado | Implantado | Verificado |
|---|---|---|---|---|
| Recebimento idempotente, CORS com `Idempotency-Key`, debounce que perdia o 2º pagamento | sim | #83, 18/11 20:54Z | a API publica pela `main`; o deploy não foi conferido por mim | 9 testes; ponta a ponta front+back 8/8 em ambiente isolado |
| `Idempotency-Key` estável no front | sim | front #62, 18/11 20:54Z | a Vercel publica pela `main`; não conferido | 15 testes unitários; mesma ponta a ponta |
| Observabilidade com login (29 rotas abertas → 2 health checks mínimos) | sim | #84, 18/11 21:03Z | idem API; o health check do Render continua público e com os mesmos 200/503 | 6 testes; sonda `scripts/seguranca/sondar-observabilidade.mjs` |
| WhatsApp Web, localização da Amanda e aviso ao dono pelo guarda de reenvio | sim | #86, 18/11 21:05Z | API: sim, pela `main`; crm-worker: só no próximo deploy dele | 6 testes com provedor simulado + inventário estático com 6 testes |
| Contagem de dispatchers e dois dispatchers simultâneos | sim | #86 | não se aplica (só testes e doc) | 3 + 2 testes; `docs/DISPATCHERS.md`. **No Render: não verificado** |
| Índices `payment_operations` e `outbound_deliveries` em produção | script | não se aplica | criados pelo Kadu em 18/11 20:22Z (só índices) | saída do script colada pelo Kadu |
| Pré-checagem de pagamentos em produção (só leitura) | script | não se aplica | rodada pelo Kadu | 68 saldos; casos A, B, C e D = 0 |
| Ensaio de restauração de backup com dados fictícios | sim | branch `test/backup-restauracao` | não se aplica | 5 coleções idênticas; senha errada e arquivo truncado recusados |
| Central de alertas (KAS) | sim | branch `kas-core/central-alertas` | não | race OK; no mesmo cenário o Node avisa 1 de 5 eventos e o Go avisa 5 de 5 |


## Como reproduzir

```bash
scripts/validar-isolado.sh
```

O script sobe um Mongo (replica set) e um Redis descartáveis em Docker, só em loopback, e roda as suítes abaixo com dados fictícios.

Do lado da KAS, o equivalente é `scripts/validate-outbox-recovery.sh` e `scripts/validate-event-reaper.sh` no repo `kas-core`.

## Prioridade 1

| # | Item | Onde | Evidência | Estado |
|---|---|---|---|---|
| 1 | Rotas de dead-letter com auth admin e resposta mínima (sem payload nem stack) | PR #79 (ex-#75) | `npm run test:observability-auth`: 12/12 | feito |
| 2 | Idempotência de multi_payment, standalone e balance_credit (concorrência, reentrega, reinício, mesma chave com conteúdo diferente → 409) | PR #79 (ex-#76) | `npm run test:pagamentos-idempotencia`: 15/15 | feito |
| 3 | Atomicidade pagamento + saldo + ledger numa transação, com falha intermediária testada | PR #79 (ex-#76) | mesma suíte | feito |
| 4 | Índices e migração só em banco descartável; reconciliação documentada | PR #79, `scripts/migrations/2026-11-18-payment-operations-preflight.js` | pré-checagem só leitura; `--apply` testado no descartável | feito; falta rodar numa cópia dos dados |
| 5 | Proteção local contra reenvio de WhatsApp e e-mail, sem promessa de exatamente uma vez | PR #79 (ex-#77) | `npm run test:envios-anti-reenvio`: 9/9; vitest do worker: 6/6 | feito |

## Prioridade 2

| Item | Onde | Evidência | Estado |
|---|---|---|---|
| MAX_RECOVERIES contra maxStalledCount, sem multiplicação | #78 (mergeado) | `tests/eventstore/bullmqInteraction.mongo.nodetest.mjs` | feito |
| Versões mistas e cerca (timestamp não prova parada) | #78 | `mixedVersions.mongo.nodetest.mjs` | feito |
| Retry admin com contador, concorrência e trilha | #78 | `adminRetry.mongo.nodetest.mjs` | feito |
| Bug P2-A: EVENT_BUSY esgotava as tentativas antes do lease vencer | #78 | espera pelo lease (`EVENT_BUSY_WAIT_MS`) | feito |
| Linha de base reproduzível das falhas antigas | #78 | `.github/ci/testes-falhando-baseline-casos.txt`: 26 casos | feito |

**A linha de base não é uma suíte aprovada.** Ela registra 9 testes vitest que já falhavam na `main` e 17 falhas de carregamento. Esses casos continuam falhando: o CI verde só garante que não apareceu falha nova.

## Prioridade 3 (KAS)

| Corte | Onde | Evidência | Estado |
|---|---|---|---|
| Reaper do Event Store | kas-core #9 e #10 (mergeados) | `docs/event-reaper/EVIDENCIAS.md` | feito |
| Recuperação de `failed` do Outbox (peças 1 e 2) | kas-core #11 (mergeado) | oráculo com o dispatcher original: 1.039 esquecidos hoje, 0 com a KAS | feito, não ativado |
| Central de alertas | branch `kas-core/central-alertas` | `scripts/validate-alerts.sh`; oráculo com o `alertService` original | feito, não ativado; entrega só em log |

## Achados que dependem de decisão

- **B-1:** `balance_credit` somava à dívida. Agora abate. Precisa da sua confirmação.
- **S-2:** resolvido no #84.
- **O-1:** 2 dispatchers só no modo monolito; o crm-worker sobe 1. Dois ao mesmo tempo não duplicam job enquanto o job existe no Redis. Ver `docs/DISPATCHERS.md`. Falta conferir `ENABLE_WORKERS` da API no painel.
- **O-2:** `cleanupOutbox` nunca é chamado. A retenção ficou fora desta rodada.

## Bloqueios para ativar

1. Confirmar B-1.
2. ~~Pré-checagem e índices~~: feitos pelo Kadu em 18/11.
3. Drenar a fila de pagamentos antes do deploy.
4. ~~Enviar `Idempotency-Key` pelo front~~: #62 mergeado.
5. ~~S-2~~: #84 mergeado.
6. Event Store:
   - a cerca (`EVENT_LEGACY_FENCE_AT`) é uma declaração do operador, conferida por ele;
   - a API sobe antes do worker.
7. Canal de alerta monitorado: a central existe (dedup, cooldown, nova tentativa); falta escolher o destino real e a credencial.
8. Usuário Mongo só leitura para as sombras da KAS.
9. Backup do Mongo: voltou a rodar em 18/11 (run #31). O procedimento de restauração foi ensaiado com dados fictícios (`scripts/backup/validar-restauracao-ficticia.sh`). Falta restaurar um arquivo **real** num banco descartável, com sua autorização.
10. Portão G: onde a KAS roda, e TLS.
11. OK explícito no Render para qualquer mudança.
