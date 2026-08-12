# Auditoria — Status de Convênio (legado × atual)

**Data:** 2026-08-07 · **Escopo:** levantamento, nenhuma alteração de código feita
**Base:** `fono_inova_prod` (leitura), 720 Payments `billingType='convenio'`, 112 InsuranceGuides

---

## 1. Resumo executivo

Não existe migração incompleta nem enum quebrado. O que existe são **três recortes de leitura diferentes**, e nenhum deles é "histórico acumulado":

1. A listagem de guias **só devolve guia que ainda tem sessão pendente**. Guia inteiramente faturada desaparece por construção — 59 das 112 guias estão nessa situação hoje.
2. Existe um **piso de data fixo em 01/03/2026** (`LEGACY_PENDING_CUTOFF`) aplicado justamente na chamada que o frontend faz. 84 sessões de convênio concluídas e não faturadas (jan+fev/2026) ficam invisíveis.
3. As abas Faturados/Recebidos são **escopadas pelo mês do evento financeiro** (`billedAt`/`receivedAt`). Não há visão acumulada, e não há nenhum recebimento registrado desde 25/03/2026.

Somando: 30 payments de convênio têm `insurance.status` fora do vocabulário lido pelas queries e são invisíveis em qualquer aba.

---

## 2. Modelo antigo (legado)

| Onde | Campo | Valores encontrados em prod | Situação |
|---|---|---|---|
| `Session` | `paymentStatus` | `pending_receipt` (345), `pending` (192), `canceled` (47), `paid` (11), **`billed` (1)** | **Legado.** Nenhuma aba de convênio lê este campo. (Fora do escopo desta auditoria, `routes/patient.js:333-337` lê `Session.paymentStatus` para montar o débito do paciente.) |
| `Session` | `billingStatus` | não existe (campo ausente) | Nunca implementado |
| `Package` | fonte de convênio | — | **Removido** de `getInsuranceHistory` (ADR-001 / `FINANCIAL_SOURCE_OF_TRUTH.md:62`); auditoria confirmou 171/171 sessões já cobertas por `InsuranceGuide` |
| `InsuranceBatch.sessions[].status` | `pending\|sent\|processing\|paid\|rejected\|partial` | subdoc | Pipeline B (lote/TISS) morto — ver memória `project_convenio_pipeline_b_cleanup_2026-07-29` |
| Collections | `payments_backup`, `sessions_backup`, `paymentsviews`, `insurance_guides_view`, `insurance_batches_view`, `therapysessions` | — | Backups/projeções, não lidas pelas abas |

Não existe collection legada de "guia antiga" separada. `insuranceguides` sempre foi a mesma collection.

---

## 3. Modelo atual — quem responde o quê

### 3.1 `InsuranceGuide.status` — [InsuranceGuide.js:160](back/models/InsuranceGuide.js#L160)

```
active | exhausted | expired | cancelled | linked | superseded | closed
```

**É ciclo de vida (elegibilidade para novas sessões), NÃO é faturamento.** Prod: active 37, expired 33, cancelled 25, exhausted 8, linked 4, superseded 4, closed 1.

Não existe campo `billingStatus` na guia — decisão explícita em [insuranceBatchGuideAdapter.js:837](back/services/insuranceBatchGuideAdapter.js#L837).

### 3.2 `billingState` — derivado em tempo de leitura

[insuranceBatchGuideAdapter.js:828-834](back/services/insuranceBatchGuideAdapter.js#L828-L834) e [:869-875](back/services/insuranceBatchGuideAdapter.js#L869-L875):

```js
if (isClosed)          return CLOSED;            // guide.closedAt != null
if (hasPendingSessions) return hasSentCommunication ? DOCUMENTATION_SENT : PENDING;
if (hasReceivedPayment) return RECEIVED;
if (hasBilledSession)   return BILLED;
return PENDING;
```

Entradas: `closedAt` (guia), `InsuranceCommunication{purpose:'billing',status:'sent'}`, `Session.billingBatchId != null`, `Payment.insurance.status='received'`.

⚠️ **`BILLED` e `RECEIVED` são inalcançáveis.** A guia só entra na lista se tiver ≥1 sessão pendente ([:341-361](back/services/insuranceBatchGuideAdapter.js#L341-L361)) — logo `hasPendingSessions` é sempre `true` e o `if` acima nunca chega nos dois ramos de baixo.

### 3.3 `Payment.insurance.status` — [Payment.js:84-88](back/models/Payment.js#L84-L88)

```
enum: pending | pending_billing | billed | received | rejected | null   (default: 'pending')
```

Distribuição real em `billingType='convenio'`:

| Valor | Qtd | Valor R$ | Tem billedAt | Tem receivedAt |
|---|---|---|---|---|
| `pending_billing` | 509 | 55.340 | não | não |
| `billed` | 150 | 15.090 | **sim, 100%** | não |
| `received` | 31 | 3.260 | sim | **sim, 100%** |
| **campo ausente** | **26** | **1.880** | não | não |
| `pending` (default) | 3 | 240 | não | não |
| `canceled` (**fora do enum**) | 1 | 80 | sim | não |

O backfill de `billedAt`/`receivedAt` **está completo** — zero registros `billed` sem `billedAt`, zero `received` sem `receivedAt`. Essa hipótese está descartada.

### 3.4 Demais entidades

| Entidade | Campo | Valores em prod |
|---|---|---|
| `InsuranceBatch.status` | `building\|ready\|sent\|processing\|received\|rejected\|closed` | sent 21, ready 1 |
| `InsuranceCommunication.status` | `draft\|ready\|sent` | sent 7, ready 6, draft 1 |
| `Session.billingBatchId` | ObjectId \| null | 124 sessões faturadas (mar 35, abr 33, mai 35, jun 8, jul 13) |

### 3.5 Constantes de leitura — [billingHelpers.js:131-193](back/utils/billingHelpers.js#L131-L193)

```js
const RECEIVABLE_STATUSES = ['pending_billing', 'billed'];   // 'received' NÃO está aqui
const ALREADY_HANDLED_PAYMENT_STATUSES = ['billed','received','partial'];
```

---

## 4. Tabela final — estado de negócio × campo × aba

| Estado de negócio | Campo que representa | Valor | Aparece em qual aba |
|---|---|---|---|
| **A faturar** | `Session.status='completed'` + `Session.billingBatchId=null` + Payment não billed/received/partial | `billingState='pending'` (derivado) | **A Faturar** — só se `Session.date >= 2026-03-01` |
| **Documentação enviada** | `InsuranceCommunication{purpose:'billing', status:'sent'}` ligada à guia | `billingState='documentation_sent'` | **Aguardando Faturamento** |
| **Faturado** | `Session.billingBatchId != null` + `Payment.insurance.status='billed'` + `insurance.billedAt` | `'billed'` | **Faturados** — só no mês de `billedAt`. Na visão por guia: **nenhuma** (estado inalcançável) |
| **Recebido / Pago** | `Payment.insurance.status='received'` + `insurance.receivedAt` + `receivedAmount` | `'received'` | **Recebidos** — só no mês de `receivedAt` (existe só em fev e mar/2026). Badge e card sempre 0 |
| **Encerrado** | `InsuranceGuide.closedAt != null` | `billingState='closed'` | **nenhuma** (é contado em `closedCount`, nunca renderizado) |
| **Cancelado** | `Payment.status='canceled'` ou `amount<=0` | — | **nenhuma** (excluído por `status:{$ne:'canceled'}, amount:{$gt:0}`) |
| **Glosado** | `InsuranceBatch.totalGlosa` / `insurance.receivedAmount < grossAmount` | `'rejected'` no batch | **nenhuma aba de convênio** (só rótulo em `STATUS_CONFIG`, sem query) |
| **Sem status** (26 registros) | `insurance.status` ausente | `undefined` | **nenhuma** |

---

## 5. As abas — endpoint, query, filtro

| Aba | subTab | Endpoint | Query real |
|---|---|---|---|
| **A Faturar** | 0 | `GET /api/v2/insurance/guides/pending-billing?limit=100` <br>([insuranceV2.routes.js:30](back/routes/insuranceV2.routes.js#L30) → `listGuidesPendingBilling`) | `Session{status:'completed', billingBatchId:null, convenio, date >= LEGACY_PENDING_CUTOFF}` → agrupa por `insuranceGuide` → front filtra `billingState==='pending' \|\| !billingState` ([InsuranceTab.tsx:231](front/src/pages/Financial/tabs/InsuranceTab.tsx#L231)) |
| **Aguardando Faturamento** | 1 | mesmo endpoint, mesma resposta | front filtra `billingState==='documentation_sent'` |
| **Faturados** | 2 | `GET /api/v2/payments/insurance/receivables?month=YYYY-MM&status=billed` | `buildInsuranceBilledFilter`: `{billingType:'convenio', amount:{$gt:0}, status:{$ne:'canceled'}, 'insurance.status':'billed', 'insurance.billedAt':{$gte,$lte do mês}}` |
| **Recebidos** | 3 | `...&status=received` | `buildInsuranceReceivedFilter`: idem com `'insurance.status':'received'` e `'insurance.receivedAt'` no mês |
| **Histórico** | 4 | `GET /api/v2/insurance/history?year=YYYY` | 3 fontes: `InsuranceBatch` (todos) + `Payment{serviceDate no ano, insurance.provider ∉ [null,'','Convênio','convenio']}` + `InsuranceGuide{issuedAt ou createdAt no ano}` |
| Cards do topo / badges | — | `getInsuranceReceivables({month})` **sem status** | cai em `buildInsuranceReceivableFilter(sessionIds, null)` → `RECEIVABLE_STATUSES=['pending_billing','billed']` |

---

## 6. Por que os registros antigos não aparecem — 5 causas confirmadas

### C1 — Guia faturada some da listagem *(causa principal)*
`listGuidesPendingBilling` parte de `Session` pendente e só depois busca a guia ([:341-361](back/services/insuranceBatchGuideAdapter.js#L341-L361)). Guia sem sessão pendente nunca entra.
**Evidência:** 59 de 112 guias (53%) não têm nenhuma sessão pendente hoje.
**Classificação:** consulta desenhada só para o fluxo novo (pendência), não para conferência.

### C2 — Piso de data fixo em 01/03/2026
[insuranceBatchGuideAdapter.js:230](back/services/insuranceBatchGuideAdapter.js#L230): `LEGACY_PENDING_CUTOFF`, aplicado quando não vem `month`/`startDate`/`endDate` ([:302](back/services/insuranceBatchGuideAdapter.js#L302)) — que é exatamente como o frontend chama ([InsuranceTab.tsx:362](front/src/pages/Financial/tabs/InsuranceTab.tsx#L362)).
**Evidência:** 84 sessões convênio `completed` sem lote antes do corte — jan/2026: 31, fev/2026: 53 — **todas com guia vinculada**.
**Classificação:** filtro deliberado (decisão de produto 2026-08-07), mas sem escape na UI.

### C3 — Faturados/Recebidos escopados pelo mês do evento
`billedAt` distribui-se em mar 11 · abr 35 · mai 44 · jun 22 · jul 23 · ago 15. `receivedAt`: **fev 13 · mar 18 e nada depois**.
Quem abre a tela em ago/2026 vê 15 faturados e 0 recebidos, mesmo com 150 faturados e 31 recebidos na base.
**Classificação:** filtro correto por competência, mas não existe visão acumulada em nenhum lugar.

### C4 — Badge e card "Recebido" estruturalmente zerados
`countByStatus('received')` ([InsuranceTab.tsx:580](front/src/pages/Financial/tabs/InsuranceTab.tsx#L580)) e `receivedPayments` ([:300](front/src/pages/Financial/tabs/InsuranceTab.tsx#L300)) leem `allReceivables`, que vem da chamada **sem status** → `RECEIVABLE_STATUSES` não inclui `'received'` → nunca há match.
**Classificação:** bug de filtro. Contador e card "Recebido" são sempre 0/R$ 0,00.

### C5 — 30 payments com status fora do vocabulário
26 sem `insurance.status` (06/04 a 19/05/2026, R$ 1.880) + 3 `pending` (default nunca promovido) + 1 `canceled` (valor fora do enum do schema).
Nenhum `$in` das três queries os alcança.
**Classificação:** dado inconsistente + `pending` (o default do schema) não pertencer a `RECEIVABLE_STATUSES`.

**Descartadas com evidência:** backfill de `billedAt`/`receivedAt` incompleto (0 faltando); `billingType:'insurance'` órfão (0 registros — só `particular` 1420, `convenio` 720, `liminar` 45).

**Ruído adicional (não é a queixa, mas afeta contagem):** 68 payments `billed` e 16 `received` com `insuranceGuide=null` → aparecem como avulsos sem guia; 52 `pending_billing` sem `session`.

---

## 7. Respostas às 4 perguntas finais

**7.1 Fonte de verdade hoje**

| Pergunta | Fonte canônica |
|---|---|
| Esta sessão já foi faturada? | `Session.billingBatchId` + `InsuranceBatch` |
| Qual o estado financeiro dela? | `Payment.insurance.status` (+ `billedAt`/`receivedAt`/`receivedAmount`) |
| A guia pode receber nova sessão? | `InsuranceGuide.status` (`active`) + `expiresAt` + `usedSessions` |
| A documentação já foi ao convênio? | `InsuranceCommunication{purpose:'billing', status:'sent'}` |
| Em que etapa a guia está? | `billingState` — **derivado, não persistido** |

`Payment` é o SSOT financeiro; `InsuranceGuide.status` **nunca** representa faturamento.

**7.2 O que ficou legado**
`Session.paymentStatus` (incl. o único `'billed'`); `Package` como fonte de convênio (removido, ADR-001); pipeline B lote/TISS; collections `*_backup` / `*view*`; `Payment.insurance.status='canceled'` (fora do enum); os 26 sem status.

**7.3 Status a manter para conferência histórica**
Todos os 7 de `InsuranceGuide.status` (auditoria de ciclo de vida) · `billed` e `received` do Payment com suas datas · `closed`/`closedAt` da guia · `InsuranceBatch.status` · `InsuranceCommunication` `sent`. Nenhum pode ser colapsado — cada um responde uma pergunta diferente de conferência.

**7.4 Menor ajuste para voltar a listar, sem quebrar a arquitetura nova**

Ordem por impacto/risco. Nada disso muda schema, migração ou regra de negócio.

| # | Ajuste | Onde | Risco |
|---|---|---|---|
| 1 | Parâmetro `includeBilled=true` em `listGuidesPendingBilling`: além de `guidesWithPending`, incluir guias com sessões já em lote. Destrava `BILLED`/`RECEIVED`, que **já estão implementados** em `deriveGuideBillingState` e hoje são código morto | `insuranceBatchGuideAdapter.js:341-361` + 2 abas novas no front | Baixo — query aditiva, opt-in |
| 2 | Expor o escape do corte legado: `includeLegacy=true` faz `periodStart=null`. O mecanismo já existe (basta não aplicar `LEGACY_PENDING_CUTOFF`) | `insuranceBatchGuideAdapter.js:302` | Baixo — opt-in |
| 3 | Corrigir card/badge "Recebido": buscar `getInsuranceReceivables({month, status:'received'})` no `loadAllCounts`, em vez de derivar de `allReceivables`. **Não alterar `RECEIVABLE_STATUSES`** — é constante compartilhada | `InsuranceTab.tsx:359-368` | Baixo — corrige no consumidor |
| 4 | Toggle "acumulado" nas abas Faturados/Recebidos: omitir `month` já devolve tudo (o backend suporta — `buildInsuranceBilledFilter(null)`) | `InsuranceTab.tsx:406` | Baixo — caminho já existe |
| 5 | Normalizar os 30 payments com status ausente/`canceled` — **decidir a regra antes**, e corrigir pela UI, não por script | — | Requer decisão de negócio |

Recomendação: **#1 + #2 resolvem a queixa relatada.** #3 e #4 são o que faz os números da tela baterem com o banco.

---

## 8. Limites desta auditoria

- Levantamento estático + consultas de leitura. Nenhuma tela foi aberta em runtime; a associação aba→endpoint vem do código, não de tráfego observado.
- A aba **Histórico** (`getInsuranceHistory`) foi mapeada nos filtros, mas sua lógica de deduplicação (~250 linhas) não foi auditada linha a linha — ela pode já cobrir parte do histórico que as outras abas escondem. Vale checar antes de implementar o #1.
- Os 26 payments sem `insurance.status` não tiveram a causa raiz investigada (só quantificados e datados: 06/04–19/05/2026).
- Nenhum arquivo de código foi alterado.
