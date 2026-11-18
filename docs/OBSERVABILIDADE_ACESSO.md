# Acesso às rotas de observabilidade, diagnóstico e filas

Atualizado em 18/11/2026. Branch `fix/observabilidade-auth`. Nada implantado.

## O que a `main` expõe hoje (pelo código, sem login)

A sonda `scripts/seguranca/sondar-observabilidade.mjs` monta cada router contra
Mongo e Redis descartáveis e chama cada rota **sem token**. Na `main`
(`629c825`), 29 rotas responderam sem login (o status 404 com id fictício também conta como aberta):

| Rota | O que dá para fazer sem login |
|---|---|
| `POST /api/diagnostic/test-full-flow` | **injeta uma mensagem de WhatsApp falsa** no fluxo de entrada, com o telefone que quiser |
| `GET /api/diagnostic/last-webhooks` | lê os webhooks brutos: **telefone e texto de pacientes** |
| `POST /api/diagnostic/test-message` | emite mensagem falsa para todos os navegadores conectados |
| `POST /api/diagnostic/clear-debounce` | apaga chaves `webhook:buffer:*` do Redis |
| `GET /admin/queues` (Bull Board) | vê os payloads dos jobs e **repete ou apaga jobs** de todas as filas |
| `POST /api/metrics/packages/record` | grava métricas |
| `GET /api/health/{monitor,detailed,stuck-events,queues,full,workers,whatsapp}` | memória, filas, workers, eventos travados |
| `GET /api/observability/{health,whatsapp-health,metrics,recent,alerts,domains,domain/:d,system-health,flow/:id}` | eventos recentes, alertas, fluxo por correlationId |
| `GET /api/metrics/{dashboard,queues/:name,slo,decision}`, `GET /api/metrics/packages{,/realtime}` | métricas internas |

Isso foi verificado no código, não em produção (nenhuma chamada foi feita ao servidor real).
Se a `main` é o que está no Render, é o que está exposto lá.

## Regra nova

| Nível | Quem | Rotas |
|---|---|---|
| Público mínimo | qualquer um | `GET /health`, `GET /api/health` (healthCheckPath do Render), `GET /api/v2/health`. Corpo: só `{ status, timestamp }`, 200 ou 503 |
| Staff | admin, secretary | painéis e leitura: `/api/health/*`, `/health/full`, `/health/details`, `/api/v2/health/detalhes`, `/api/observability/*` (exceto dead letters), `/api/metrics/{dashboard,queues/:name,slo,decision}`, `/api/metrics/packages{,/realtime}` |
| Admin | admin | `/api/diagnostic/*`, Bull Board, `POST /api/metrics/packages/record`, dead letters (já era) |

- O que antes vinha em `GET /api/health` (checks) passou para `GET /api/health/basic`, com login.
- O que vinha em `GET /api/v2/health` passou para `GET /api/v2/health/detalhes`, com login.
- `POST /api/metrics/usage` continua para qualquer usuário logado (o front registra uso de todos).

### Bull Board
É aberto como link no navegador, sem cabeçalho `Authorization`. Primeira visita:
`/admin/queues?token=<JWT de admin>`. O token vira cookie `httpOnly`,
`SameSite=Strict`, restrito a `/admin/queues`, com validade de 1 h, e o navegador é redirecionado para a URL sem o token.
Secretária recebe 403.

## Consumidores conferidos

- Front (`fono-inova-crm-front`): `SystemHealthContext` e `systemHealthResolver` chamam
  `/observability/system-health`, `/health/full`, `/observability/whatsapp-health` e
  `/admin/system-monitor` pelo `API` (com Bearer), e continuam funcionando para admin e secretária.
  Para outro perfil passam a receber 403. O contexto já trata falha sem quebrar a tela.
- `whatsappService` chama `/health/whatsapp` com Bearer: staff.
- A tela `Settings/WhatsAppDiagnostic` chama `/diagnostic/sync` e `/diagnostic/sync-missing`, que não existem no router atual; nada muda nela.
- Render: `healthCheckPath: /api/health`. Continua público e responde 200/503.
- Monitores externos (se houver) em `/health` ou `/api/health`: continuam funcionando, agora sem os números internos.
- Não conferido: `agenda-clinica-web` e eventuais scripts externos que leiam `/api/observability/*` sem token.

## Evidência

```
MONGO_TEST_URI=... REDIS_URL=... npm run -s test:observability-acesso   # 6 testes
npm run -s test:observability-auth                                    # 12 (dead letters, inalterado)
AUD_MONGO_URI=... REDIS_URL=... node scripts/seguranca/sondar-observabilidade.mjs
```

Sonda depois da mudança: só `GET /api/health` e `GET /api/v2/health` respondem sem login.
