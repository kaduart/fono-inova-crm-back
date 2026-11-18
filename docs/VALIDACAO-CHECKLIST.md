# Checklist de validação da migração CRM → KAS Core

Atualizado em 18/11/2026. Nada aqui foi ativado em produção. Merge e deploy dependem do Kadu.

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
| Recuperação de `failed` do Outbox (peças 1 e 2) | kas-core #11 | oráculo com o dispatcher original: 1.039 esquecidos hoje, 0 com a KAS | PR aberto |

## Achados que dependem de decisão

- **B-1:** `balance_credit` somava à dívida. Agora abate. Precisa da sua confirmação.
- **S-2:** há outras rotas GET de observabilidade sem auth.
- **O-1:** o dispatcher do Outbox pode subir duas vezes (grupos `outbox` e `reconciliation`).
- **O-2:** `cleanupOutbox` nunca é chamado. A retenção ficou fora desta rodada.

## Bloqueios para ativar

1. Confirmar B-1.
2. Rodar a pré-checagem de pagamentos numa cópia dos dados e criar os índices com OK (`autoIndex` está desligado).
3. Drenar a fila de pagamentos antes do deploy.
4. Enviar `Idempotency-Key` pelo front.
5. Decidir sobre S-2.
6. Event Store:
   - a cerca (`EVENT_LEGACY_FENCE_AT`) é uma declaração do operador, conferida por ele;
   - a API sobe antes do worker.
7. Canal de alerta monitorado (hoje os alertas da KAS vão só para o log).
8. Usuário Mongo só leitura para as sombras da KAS.
9. Backup do Mongo: voltou a rodar em 18/11 (run #31) depois de falhar desde 02/11; falta testar uma restauração antes de qualquer escrita nova.
10. Portão G: onde a KAS roda, e TLS.
11. OK explícito no Render para qualquer mudança.
