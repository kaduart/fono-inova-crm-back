---
title: "Contrato da Read View de Guias de Convenio"
tags: [insurance, guides, read-view, contract, fase-1]
status: active
created: 2026-08-11
---

# Contrato da Read View de Guias de Convenio

## Endpoint

`GET /api/v2/insurance/guides/view`

Somente leitura. Nao altera dados, nao recalcula valores financeiros, nao muda status.

## Parametros de query

| Parametro | Tipo | Padrao | Descricao |
|-----------|------|--------|-----------|
| `insurance` | string | - | Codigo do convenio |
| `patientId` | string | - | ObjectId do paciente |
| `guideStatus` | string | - | `InsuranceGuide.status` (ciclo de vida da autorizacao) |
| `phase` | string | `'all'` | Fase unica: `pendingBilling`, `documentationSent`, `billed`, `received` ou `all` |
| `phases` | string | - | Fases separadas por virgula p/ retorno consolidado. Ex: `pendingBilling,documentationSent,billed,received` |
| `from` | ISO date | - | Competencia inicial, aplicada no eixo da propria fase |
| `to` | ISO date | - | Competencia final, aplicada no eixo da propria fase |
| `page` | number | `1` | Paginacao (so ativa quando `limit > 0`) |
| `limit` | number | `0` | `0` = sem paginacao |

### Regras dos parametros

- `phase` e `phases` sao independentes e aditivos.
- Quando `phases` e informado, `phase` e ignorado para o retorno padrao; a resposta passa a conter a chave `buckets`.
- `phase=X` continua funcionando exatamente como antes da Fase 1. Nao ha janela de incompatibilidade com o front.
- Paginacao e aplicada a cada bucket separadamente quando `phases` e usado.

## Unidade de verdade

A unidade do ciclo financeiro e a **SESSAO**, nao a guia. A guia e um container operacional e pode ter sessoes em varias fases ao mesmo tempo (principalmente guias `billingMode: 'per_month'`). A verdade vive nos contadores por fase.

## Fontes canonicas

| Conceito | Fonte |
|----------|-------|
| Valor financeiro da sessao | `Payment` (SSOT); `Session.sessionValue` e `InsuranceGuide.sessionValue` sao fallback para dados antigos |
| Faturado/recebido | `Payment.insurance.status` e `Session.billingBatchId` |
| Envio de documentacao | `InsuranceCommunication` + `BillingSubmission` |
| Nota fiscal | `InsuranceBatch.invoiceNumber` |
| Ciclo de vida da autorizacao | `InsuranceGuide.status` (nunca faturamento) |

## Estrutura da resposta

### Envelope (sempre presente)

```json
{
  "success": true,
  "data": [ /* ...guias... */ ],
  "orphanSessions": [ /* ...sessoes sem guia... */ ],
  "totals": { /* ...agregado... */ },
  "competenceBreakdown": { /* ...competencia pendingBilling... */ },
  "pagination": { "page", "limit", "total", "pages" },
  "buckets": { /* ...quando phases e informado... */ }
}
```

### Objeto de guia (`data[n]`)

```json
{
  "guideId": "...",
  "number": "...",
  "insurance": "...",
  "specialty": "...",
  "patient": { "fullName": "...", "phone": "..." },
  "guideStatus": "...",
  "expiresAt": "...",
  "closedAt": "...",
  "billingMode": "per_month",
  "totalSessions": 10,
  "usedSessions": 7,
  "remaining": 3,
  "sessionValue": 150.00,
  "totalAuthorizedValue": 1500.00,
  "sessions": {
    "total": 7,
    "pendingBilling": 2,
    "documentationSent": 1,
    "billed": 3,
    "received": 1,
    "outOfCycle": 0
  },
  "financialSummary": {
    "pendingAmount": 300.00,
    "documentationSentAmount": 150.00,
    "billedAmount": 450.00,
    "receivedAmount": 150.00,
    "totalAmount": 1050.00
  },
  "competenceBreakdown": { /* ... */ },
  "billingState": "pending",
  "hasMixedStates": true,
  "documentationSentAt": "...",
  "documentationSentAtIsProxy": false,
  "invoiceNumber": "...",
  "communicationId": "...",
  "invoices": [ /* ...uma entrada por lote... */ ],
  "sessionDetails": [ /* ...sessoes do recorte... */ ]
}
```

### Sessoes fora do ciclo

Sessoes com `status !== 'completed'` ou com conflito de pagamento ativo (`paymentIntegrityConflict === true`) tem `phase: null` e `value: 0`. Elas sao contabilizadas em `sessions.outOfCycle` e aparecem repetidas nos `sessionDetails` de todos os buckets (comportamento preservado das 4 chamadas `phase=X`).

### Buckets (`phases`)

Quando `phases=pendingBilling,documentationSent,billed,received`, a resposta inclui:

```json
{
  "buckets": {
    "pendingBilling": {
      "data": [ /* ...guias com sessions.pendingBilling > 0... */ ],
      "totals": { /* ... */ },
      "competenceBreakdown": { /* ... */ },
      "pagination": { /* ... */ }
    },
    "documentationSent": { /* ... */ },
    "billed": { /* ... */ },
    "received": { /* ... */ }
  }
}
```

Cada bucket e equivalente a uma chamada separada `?phase=X` com os mesmos filtros de convenio/paciente/status e paginacao.

## Invariantes

I1. Sem filtro de fase, toda `InsuranceGuide` do banco aparece na resposta (completude).
I2. `sessions.total === pendingBilling + documentationSent + billed + received + outOfCycle`.
I3. Sessao com status diferente de `completed` nao entra em nenhuma fase (`phase: null`).
I4. Payment `canceled`, `rejected` ou `void` nao e elegivel; gera `paymentIntegrityConflict`.
I5. Valor da sessao vem de `Payment` primeiro (SSOT); sessao e guia sao fallback.
I6. `orphanSessions` continuam sendo devolvidos na raiz.
I7. `invoices` resumem por lote (`batchId`); guia `per_month` pode ter multiplas notas.
I8. Competencia `pendingBilling` usa `Session.date` no eixo local do servidor.
I9. `billingState` nunca e `'mixed'`. Mistura e expressa por `hasMixedStates + contadores`.

## Bugs e limitacoes conhecidas (fora do escopo da Fase 1)

- `paymentIntegrityConflicts`: a informacao e coletada pelo servico, mas nao e devolvida no envelope da resposta (Opcao A). Ligacao do aviso na UI depende de PR separada.
- `hasMixedStates`: logica conhecida com edge cases em guias `per_month`; sera tratada em PR propria.
- Timezone de competencia: `composePendingCompetenceBreakdown` usa `new Date().getMonth()` no timezone do servidor. Sessoes apos 21h BRT no ultimo dia do mes podem mudar de bucket. Confirmado comportamento herdado; correcao e PR separada.
- Payments de convenio sem `session`: a consulta atual busca payments por `session` OU `insuranceGuide`, mas so indexa/consumo por `session._id`. Payments com `insuranceGuide` valido e `session` ausente sao descartados. Isso pode esconder dinheiro real da tela se existirem em producao. Fase 2 bloqueada ate contagem confirmar se e codigo morto ou divida historica.

## Teste de caracterizacao

`back/scripts/validate-insurance-view-http.mjs` valida:

- 6 chamadas: 1 sem filtro, 4 com `phase=X`, 1 com `phases=...`.
- Comparacao campo a campo entre cada `phase=X` e o bucket correspondente.
- Checks de dataset minimo:
  - guia com sessoes em 2+ fases;
  - guia com `invoices.length > 1`;
  - `orphanSessions` presente e com estrutura correta (vazio ou nao);
  - guia com `sessions.outOfCycle > 0`;
  - guia com `closedAt` preenchido;
  - sessao com `sessionDetails.paymentIntegrityConflict === true`;
  - guia com `billingState === 'no_sessions'` (via chamada sem filtro);
  - completude: total de guias sem filtro === `db.insuranceguides.countDocuments()`;
  - comunicacao legado (`guideId`) versus submission (`billingSubmissionId`) via consulta direta ao banco no script.

## Fase 1b (front)

A Fase 1a entrega o contrato aditivo no back. A melhoria de performance so e percebida pela secretaria quando o front passar a usar `phases=...` em vez de 4 chamadas `phase=X`. A medicao de tempo (`loadAllCounts`) so e valida na PR do front.

## Decisoes arquiteturais

- Contrato **aditivo**, nao substitutivo: `phase=X` permanece valido.
- Back e front vivem em repositorios separados; a mudanca exige duas PRs.
- A computacao do universo e feita uma unica vez; os buckets sao derivados do mesmo conjunto classificado.

## Melhorias adjacentes identificadas (nao incluidas na Fase 1)

- Endpoint/tela de auditoria para `payments` de convenio sem `session` (ou sem `insuranceGuide`), para evitar que dinheiro fique invisivel.
- Indice composto `Payment { billingType: 1, insuranceGuide: 1, session: 1 }` para facilitar a contagem de orphans sem full collection scan.
- Indice `Session { insuranceGuide: 1, status: 1 }` para acelerar a consulta principal se o volume crescer.
- Cache Redis com invalidacao por eventos de escrita (faturar/receber/lote) para reduzir recalculo da aba Convênios.
- Refatoracao de `/api/insurance/admin/convenios` para trocar N+1 de contadores por agregacao unica.
- Nao ha materializacao em view de banco; o volume atual suporta composicao em memoria.
