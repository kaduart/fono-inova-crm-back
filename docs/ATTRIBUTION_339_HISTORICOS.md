# Os "339 registros históricos" do AdConversion

> **Não executado em produção; explicação a confirmar com a leitura.**
> Este documento só lê código. Nenhuma contagem abaixo foi medida: o número 339 vem do plano
> (auditoria anterior) e **não** foi reproduzido aqui. Os caminhos de código são os que, pela leitura,
> produzem registros "históricos", "ignorados" ou "pulados". Qual deles compõe os 339 só se sabe
> rodando a consulta somente leitura do fim deste documento, no servidor, por quem tem acesso.

Arquivos lidos: `models/AdConversion.js`, `crons/adsConversion.cron.js`, `crons/adsConversion.logic.js`,
`routes/analytics/funnel.logic.js`, `routes/adsFeed.js`, `scripts/adsConversionDoctor.mjs`,
`scripts/_backfill-origem-adconversions.js`, `docs/ADS_CONVERSION_CONTRACT.md`.

## 1. O que é um registro "histórico" ou "ignorado"

Cada `AdConversion` tem três subdocumentos (`meta`, `google`, `tiktok`) com `status` em
`pending | sent | skipped | failed` e um `reason`. Não existe campo "histórico": o termo vem da tela
(`summarizeDelivery`, em `routes/analytics/funnel.logic.js`), que separa:

| Classe na tela | Regra no código | Origem provável |
|---|---|---|
| Aceita (com prova) | `sent` **e** prova na resposta: Meta `eventsReceived >= 1`; TikTok `code === 0`; Google sempre | envio pelo cron depois do item #4 (resposta efetiva) |
| **Enviado (histórico)** | `sent` **sem** a prova acima | gravações anteriores ao item #4 (`eventsReceived`/`code` ainda não eram gravados), ou TikTok com só `request_id` |
| Ignorada | `skipped` + `reason` | ver seção 2 |
| Inconsistente | `pending` em documento com `done: true` | documento finalizado com um destino ainda pendente |

## 2. Caminhos de código que geram `skipped` (por motivo)

| `reason` | Onde nasce | O que significa |
|---|---|---|
| `nao_e_primeiro_agendamento` | `decidePlatforms({ first: false })` em `crons/adsConversion.logic.js`; também o `catch` de chave duplicada `uniq_acquisition_per_patient` em `enqueueNew` | retorno de paciente, remarcação ou 2º agendamento: nunca é enviado, por regra |
| `fora_janela_7d_meta` / `fora_janela_7d_tiktok` | `decidePlatforms` (evento com mais de 6,5 dias) e `recoverMissingPhone` | agendamento entrou tarde na fila (lookback de 30 dias, confirmação tardia, telefone recuperado depois) |
| `sem_telefone` (Meta) | `decidePlatforms` sem telefone e sem `ctwaClid` | pode ser reaberto por `recoverMissingPhone` / `fillMissingCtwaClid` dentro de 7 dias |
| `sem_gclid` (Google) | `decidePlatforms` sem gclid | reabre em `refreshUnknownSources` se o gclid chegar em até 90 dias |
| `sem_identificador` (TikTok) | `decidePlatforms` sem telefone e sem ttclid | reabre em `refreshUnknownSources` se o ttclid chegar em até 7 dias |
| outros (`reason` vindo do service) | `processPending` grava o `reason` devolvido por `uploadOfflineConversion` / `interpretMetaResponse` / `interpretTiktokResponse` | ex.: integração não configurada |

E origem "Não identificado" (`source: 'unknown'`), com `unknownReason` (`models/AdConversion.js`, campo
criado em 18/11): `sem_telefone | lead_sem_origem | sem_origem_capturada` (`unknownReasonFor`).
Registros anteriores a 18/11 podem ter `unknownReason: null` até o `refreshUnknownSources` (só olha 30 dias)
ou o backfill `scripts/_backfill-origem-adconversions.js` passarem por eles.

Outro ponto que o código mostra: o feed `GET /api/ads-feed/google-offline.csv` lista **toda** AdConversion
com `gclid` nos últimos 60 dias, sem olhar `isAcquisition`. Desde 18/11 o cron só grava gclid na aquisição,
mas registros não-aquisição mais antigos com gclid continuariam no feed. A nova rota
`/attribution-health` conta isso em `google_csv.naoAquisicaoComGclidNoFeed`.

## 3. Hipóteses (a confirmar) para o número 339

Pela leitura, os candidatos mais prováveis, em ordem:

1. `skipped` com `nao_e_primeiro_agendamento` (todo retorno de paciente vira um registro assim);
2. `sent` sem prova ("Enviado (histórico)"), gravados antes do item #4;
3. `skipped` por janela de 7 dias (`fora_janela_7d_*`) em agendamentos que entraram tarde.

Nenhuma delas foi verificada. O número pode também ser soma de destinos (o doctor conta por destino,
então o mesmo documento aparece até 3 vezes).

## 4. Consulta somente leitura para classificar em produção

**Não executado.** Para quem tem acesso ao servidor:

```bash
# 1) Diagnóstico já existente (só lê AdConversion e a presença das envs; não envia, não grava)
node scripts/adsConversionDoctor.mjs 90
```

O doctor mostra, por destino, `status=contagem` e os 6 motivos mais comuns. Ele **não** separa "sent com
prova" de "sent sem prova", nem o `pending` em registro finalizado. Para isso, uma das duas opções, ambas
só leitura:

```bash
# 2a) A rota nova (GET, só find().lean()):
curl -H "Authorization: Bearer <token>" \
  "https://<api>/api/v2/analytics/attribution-health?from=2026-01-01&to=2026-11-30"
```

```js
// 2b) mongosh, usuário só leitura (agregação, sem $out/$merge):
db.adconversions.aggregate([
  { $project: { _id: 0, done: 1, d: [
      { p: 'meta',   s: '$meta.status',   r: '$meta.reason',   prova: { $gte: ['$meta.eventsReceived', 1] } },
      { p: 'google', s: '$google.status', r: '$google.reason', prova: true },
      { p: 'tiktok', s: '$tiktok.status', r: '$tiktok.reason', prova: { $eq: ['$tiktok.code', 0] } } ] } },
  { $unwind: '$d' },
  { $group: { _id: { destino: '$d.p', status: '$d.s', motivo: '$d.r',
      prova: { $cond: [{ $eq: ['$d.s', 'sent'] }, '$d.prova', null] },
      pendenteFinalizado: { $and: [{ $eq: ['$d.s', 'pending'] }, '$done'] } }, n: { $sum: 1 } } },
  { $sort: { '_id.destino': 1, n: -1 } }
])
```

Depois de rodar, anotar aqui qual linha (ou soma) dá 339 e trocar a seção 3 pela resposta medida.
