# Proposta — Arquitetura de leitura da aba Convênios

**Data:** 2026-08-07 · **Tipo:** desenho, nenhuma linha de código escrita
**Pré-requisito:** [AUDITORIA_STATUS_CONVENIO_LEGADO.md](./AUDITORIA_STATUS_CONVENIO_LEGADO.md)
**Escopo:** somente leitura/UI. Nenhuma regra financeira, schema ou migração de dado.

---

## 0. O achado que muda o desenho proposto

Antes de responder às 3 perguntas, um dado de produção que invalida parcialmente o desenho sugerido:

> **9 guias estão em estado misto** — têm sessões já faturadas *e* sessões pendentes ao mesmo tempo.

Isso não é anomalia: é o fluxo normal de `billingMode: 'per_month'`, onde uma guia de 20 sessões é faturada mês a mês. A guia fica meses em "parte faturada, parte a faturar".

**Consequência:** um `billingState` escalar por guia — o que existe hoje e o que a proposta original mantém — **não consegue representar o ciclo**. Qualquer regra de precedência (`if pending → pending`) apaga a informação de que metade da guia já foi faturada. É a mesma classe de erro que causou o bug atual, só que deslocada.

A unidade real do ciclo de vida é a **sessão**, não a guia:

```
Sessão realizada → A faturar → Documentação enviada → Faturado → Recebido
```

A guia é um **contêiner** que agrega sessões em fases diferentes. Portanto a nova fonte deve devolver **contadores por fase** e usar o estado escalar apenas como rótulo dominante do card.

Distribuição real com a regra corrigida (112 guias): `pending` 46 · `sem sessão concluída` 47 · `billed` 10 · `documentation_sent` 4 · `received` 3 · `closed` 2.

---

## 1. Respostas às perguntas de validação

### 1.1 Posso remover a dependência de `listGuidesPendingBilling` para alimentar as abas?

**Sim, com segurança — mas só a função de leitura, não o arquivo.**

| Consumidor de `listGuidesPendingBilling` | Tipo |
|---|---|
| `insuranceV2Controller.js:630` (`listPendingGuides`) | **único consumidor de produção** |
| `scripts/_diag-*.js` (2 arquivos) | diagnóstico |
| comentários em `completeSessionService.v2.js:748` | documentação |

O caminho de **escrita** (`buildBatchFromGuides`, que cria o lote) mora no mesmo arquivo mas é **independente**: não usa `LEGACY_PENDING_CUTOFF`, não usa `findAlreadyHandledSessionIds`, não filtra por data — deriva `startDate`/`endDate` das sessões selecionadas. Verificado no código.

➡️ **Refatorar a leitura não pode quebrar o faturamento.** É a condição que torna esta proposta viável.

⚠️ Manter `buildBatchFromGuides` intacto. Ele tem um gap conhecido e separado (`project_batch_faturamento_sem_filtro_data_fix`) que **não** entra neste escopo.

### 1.2 Substituir as 4 abas ou criar uma aba "Conferência"?

**Substituir a fonte das 4 abas. Não criar uma quinta aba.**

Motivos:

1. Uma aba "Conferência" seria a **quinta** representação do mesmo ciclo. Já existem quatro vocabulários concorrentes hoje: `billingState` (guia), `Payment.insurance.status`, `batchStatus` (`received|billed|pending_batch`, em `getInsuranceHistory:1207`) e `InsuranceBatch.status`. Adicionar mais um agrava exatamente o problema diagnosticado.
2. As abas quebradas continuariam quebradas ao lado da certa — a secretária teria dois números diferentes para a mesma pergunta.
3. **A UI já está pronta.** `GuidePendingBillingSection.tsx:172-194` já renderiza os 5 estados com rótulo e cor: 🟠 "Aguardando primeiro faturamento", 📤 "Documentação enviada · NF X", 🟡 "Faturada · lote enviado em DD/MM", 💰 "Recebida do convênio", 🔒 "Guia finalizada". **Só os dados nunca chegam.** Não é problema de UI — é de composição de leitura.

➡️ As 4 abas viram **filtros sobre uma única fonte**, não 4 queries diferentes.

### 1.3 Como tratar histórico — Opção A ou B?

**Opção B: acumulado por padrão, competência como refinamento opcional.**

| Critério | Peso |
|---|---|
| Volume total: 112 guias, 710 sessões com guia, 720 payments, 22 lotes, 14 comunicações | Trivial. Retornar tudo custa ~5 queries sobre <1.600 documentos. Não há argumento de performance para o escopo mensal |
| "A Faturar" já é acumulado hoje, por decisão registrada (backlog não tem mês) | A Opção A criaria inconsistência: 2 abas acumuladas, 2 mensais |
| A queixa relatada é exatamente "faturado/recebido antigo sumiu" | A Opção A resolve com um clique escondido; a B resolve por default |
| `receivedAt` só existe em fev/mar 2026 | Com escopo mensal default, a aba Recebidos aparece vazia 10 meses por ano |

**Ressalva obrigatória:** a competência mensal continua correta e necessária no **dashboard financeiro** — `FinancialDashboardTab.tsx:178-192` consome `getInsuranceReceivables` com mês. Esse endpoint **não muda**. A Opção B se aplica só à aba Convênios, que é conferência operacional, não caixa.

Quando o filtro de competência for aplicado, ele deve incidir sobre **o eixo de data da própria fase** — nunca um único campo para todas:

| Fase | Eixo de competência |
|---|---|
| A faturar / Documentação enviada | `Session.date` |
| Faturado | `Payment.insurance.billedAt` |
| Recebido | `Payment.insurance.receivedAt` |

---

## 2. Desenho da nova fonte de leitura

### 2.1 Nome e localização

```
back/services/insuranceGuide/insuranceGuidesReadView.js
  └── getInsuranceGuidesView(filters) → { guides, orphanSessions, totals }
```

Serviço novo, arquivo novo. **Não** reaproveitar o model `InsuranceGuideView.js`: ele existe (240 linhas) mas tem **zero imports em todo o código** e a collection `insurance_guides_view` tem **0 documentos**. É infra de projeção morta — ressuscitá-la introduz um problema de invalidação de cache que os 1.600 documentos atuais não justificam. O mesmo vale para `insurance_batches_view` (0 documentos).

➡️ **Composição em tempo de leitura, sem materialização.** Se o volume crescer 100×, aí sim reavaliar projeção.

### 2.2 Regra de entrada (a correção estrutural)

```js
// HOJE (errado): parte da sessão pendente, guia é consequência
Session{pendente} → group by insuranceGuide → InsuranceGuide.find({_id: {$in: ...}})
// ⇒ guia sem sessão pendente nunca entra ⇒ 59/112 invisíveis

// PROPOSTO: parte da guia, sessões são atributo
InsuranceGuide.find(guideMatch)        // ← universo = todas as guias
  ├── Session.find({insuranceGuide: {$in: ids}})
  ├── Payment.find({insuranceGuide: {$in: ids}} ∪ {session: {$in: sessionIds}})
  ├── InsuranceCommunication.find({guideId: {$in: ids}, purpose:'billing'})
  └── InsuranceBatch.find({_id: {$in: billingBatchIds}})
```

Inversão do ponto de partida. É a mudança que resolve a causa raiz C1 da auditoria.

### 2.3 Forma da resposta

```ts
{
  guideId, number, insurance, specialty, patient,
  guideStatus,          // InsuranceGuide.status — ciclo de vida, inalterado
  billingMode, totalSessions, usedSessions, sessionValue,

  // ── contadores por fase (a novidade) ──────────────────────
  phases: {
    pending:            { count, value, firstDate, lastDate },
    documentationSent:  { count, value, sentAt, invoiceNumber },
    billed:             { count, value, billedAt, batchIds[] },
    received:           { count, value, receivedAt, receivedAmount },
  },

  billingState,   // rótulo DOMINANTE do card (compat com a UI atual)
  isMixed,        // true quando >1 fase tem count>0  ← os 9 casos reais
  sessions: [ { sessionId, date, time, value, phase, batchId, paymentId } ]
}
```

`sessions[].phase` é derivado **por sessão**, nesta ordem:

```
received  ← Payment.insurance.status === 'received'
billed    ← Session.billingBatchId != null  OU  Payment.insurance.status === 'billed'
doc_sent  ← guia tem InsuranceCommunication{purpose:'billing', status:'sent'}
pending   ← Session.status === 'completed' e nada acima
(fora do ciclo) ← Session.status != 'completed'
```

`billingState` = fase mais **avançada** com `count > 0`, com `closed` (guia com `closedAt`) tendo precedência. Isso mantém a assinatura que `GuidePendingBillingSection` já consome — a UI não precisa mudar para o card funcionar.

### 2.4 O que **não** muda (regras do enunciado, respeitadas)

| Invariante | Como é preservada |
|---|---|
| `Payment` é SSOT financeiro | A view **lê** `Payment.insurance.status/billedAt/receivedAt`. Nenhuma escrita, nenhum valor recalculado no front |
| `InsuranceGuide.status` é ciclo de vida | Devolvido como `guideStatus`, campo separado de `billingState`. Nunca sobrescrito nem misturado |
| `InsuranceCommunication` controla documentação | Continua sendo a única origem de `documentation_sent` |
| KPI financeiro só no backend | `phases[].value` vem somado do backend; o front só renderiza |
| Não alterar constante compartilhada | `RECEIVABLE_STATUSES` fica intacta; a view usa vocabulário próprio |

---

## 3. Impacto nos endpoints atuais

| Endpoint | Impacto | Ação |
|---|---|---|
| `GET /v2/insurance/guides/pending-billing` | Passa a ser **caso particular** da nova view (`phase=pending`) | Manter como alias durante a migração; depreciar na Fase 4 |
| `GET /v2/insurance/guides/view` *(novo)* | — | Criar |
| `GET /v2/payments/insurance/receivables` | **Nenhum.** Consumido por `FinancialDashboardTab` (3 pontos) com competência mensal | **Não tocar** |
| `GET /v2/insurance/history` | **Nenhum.** É relatório de receita mês→convênio→paciente→especialidade, deduplicado por sessão. Perde a identidade da guia por desenho — não serve como conferência de ciclo, e não concorre com a nova view | **Não tocar** |
| `POST /v2/financial/convenio/faturar-lote` e demais escritas | **Nenhum.** Caminho independente (§1.1) | **Não tocar** |

**Resposta ao caveat aberto na auditoria:** `getInsuranceHistory` foi auditado. Ele **não** cobre o histórico de guia — agrega por paciente+especialidade e descarta a guia. Não substitui a nova view.

---

## 4. Filtros que deixam de existir

| Filtro | Onde | Destino |
|---|---|---|
| `LEGACY_PENDING_CUTOFF = 2026-03-01` aplicado por default | `insuranceBatchGuideAdapter.js:230,302` | **Deixa de ser piso implícito.** Vira `?since=` explícito, default sem piso. Esconde 84 sessões hoje |
| "guia precisa ter sessão pendente" | `:341-361` | **Eliminado.** Era a causa C1 |
| `insurance.billedAt`/`receivedAt` obrigatoriamente dentro do mês | `billingHelpers.js:170-193` | **Só na nova view.** No endpoint de receivables permanece (dashboard depende) |
| `RECEIVABLE_STATUSES` como universo dos cards | `InsuranceTab.tsx:359-368` | Cards passam a ler `totals` da view. `'received'` deixa de ser inalcançável (causa C4) |
| Precedência `hasPendingSessions` sobre billed/received | `:869-875` | Substituída por contadores por fase + estado dominante |

**Filtro novo, deliberado:** `phase` (`pending|documentation_sent|billed|received|closed|all`), default `all`.

---

## 5. Como garantir que nenhuma guia faturada desapareça

Esta é a parte que precisa de trava automatizada, não de revisão manual.

**Invariante a codificar:**

> Toda `InsuranceGuide` que existe no banco aparece na resposta de `getInsuranceGuidesView({})` sem filtros. Sempre. Sem exceção de status, de data ou de existência de sessão.

**Testes que travam a regressão** (a escrever junto com o serviço):

1. **Teste de completude** — `count(InsuranceGuide)` === `guides.length` da view sem filtros. Hoje esse teste falha: 112 vs 53. É o teste que caracteriza o bug.
2. **Teste de conservação de sessão** — toda sessão `completed` com `insuranceGuide` aparece em exatamente **uma** fase. `Σ phases[].count === count(sessões completed da guia)`. Impede sessão sumir e impede dupla contagem.
3. **Teste de estado misto** — fixture com guia tendo 1 sessão faturada + 1 pendente ⇒ `phases.billed.count === 1 && phases.pending.count === 1 && isMixed === true`. É o caso dos 9 reais que o modelo escalar apaga.
4. **Teste de não-regressão do legado** — sessão com `Session.date` anterior a 2026-03-01 aparece na view sem filtro. Trava o retorno do cutoff implícito.
5. **Teste de paridade** — `getInsuranceGuidesView({phase:'pending', since:'2026-03-01'})` devolve o mesmo conjunto de guias que `listGuidesPendingBilling()` hoje. É o que autoriza a troca da fonte na Fase 2 sem mudança visível de comportamento.

**Reconciliação operacional** (uma vez, na Fase 2): comparar a soma de `phases.billed.value` da view com `Σ InsuranceBatch.totalGross` dos lotes `sent`. Divergência é dado inconsistente conhecido (os 30 payments sem status da auditoria), não bug da view — mas precisa ser medida e registrada antes de trocar a tela.

---

## 6. Plano de migração sem quebrar a tela atual

Cinco fases. Cada uma é reversível sozinha e nenhuma exige migração de dado.

| Fase | O que | Risco | Reversão |
|---|---|---|---|
| **1. Serviço + testes** | Criar `insuranceGuidesReadView.js` e os 5 testes do §5. Nenhuma rota exposta, nenhuma tela tocada | Nenhum — código morto até a Fase 2 | Deletar arquivo |
| **2. Endpoint em paralelo** | Expor `GET /v2/insurance/guides/view`. Rodar a reconciliação do §5. Tela **continua** na rota antiga | Nenhum na UI | Remover rota |
| **3. Troca da fonte** | `InsuranceTab` passa a consumir a nova rota. As 4 abas viram filtro `phase`. Cards leem `totals` (corrige C4). `GuidePendingBillingSection` **não muda** — já aceita os 5 estados | Médio — é aqui que a tela muda | Reverter 1 import + 1 chamada |
| **4. Abas de conferência** | Abas Faturados/Recebidos passam a ser guide-based e acumuladas (Opção B), com competência opcional | Baixo | Manter `phase` mensal |
| **5. Depreciação** | Marcar `listGuidesPendingBilling` como deprecated. **Não deletar** — os scripts de diagnóstico usam. `buildBatchFromGuides` permanece intocado | Baixo | — |

**Ponto de não-retorno:** Fase 3. Recomendo travar as Fases 1-2 e rodar a reconciliação antes de aprovar a 3 — é onde a secretária vê números diferentes dos de hoje, e ela precisa saber por quê antes, não depois.

---

## 7. O que esta proposta deliberadamente NÃO faz

- **Não normaliza os 30 payments com `insurance.status` ausente/`canceled`.** Eles vão aparecer na view (fase `pending`, por não casar com nada acima). Isso é correto: torná-los visíveis é pré-requisito para decidir a regra. Correção pela UI, não por script.
- **Não unifica os 4 vocabulários de status.** A view adiciona um vocabulário de leitura por cima; consolidar `batchStatus`/`InsuranceBatch.status` é trabalho separado.
- **Não toca em `buildBatchFromGuides`** nem no gap de filtro de data dele.
- **Não mexe em `getInsuranceReceivables` nem em `getInsuranceHistory`.**
- **Não materializa projeção.** Composição em tempo de leitura, justificada pelo volume medido.

---

## 8. Execução — Fases 1 e 2 (2026-08-07)

Aprovado e executado. **Fase 3 não foi iniciada** — nenhum arquivo de frontend foi tocado, nenhuma rota foi exposta.

### Entregues

| Arquivo | Papel |
|---|---|
| `back/services/insuranceGuide/insuranceGuidesReadView.js` | Fonte de leitura composta. Somente leitura |
| `back/tests/insurance/insuranceGuidesReadView.test.js` | 24 testes de composição (`node --test`) |
| `back/scripts/reconcile-insurance-guides-view.mjs` | Reconciliação G1–G5 contra o banco |

Nenhum arquivo existente foi modificado.

### Resultado da reconciliação (`fono_inova_prod`)

```
✅ G1 Toda guia existente aparece         112 banco = 112 view
✅ G2 Nenhuma sessão desaparece           362 completed = 362 classificadas · 0 guias com total ≠ soma
✅ G3 Nenhum payment mudou de valor       R$ 42.790,00 antes = depois
✅ G4 "Recebido" bate com Payment (SSOT)  R$ 3.260,00 = R$ 3.260,00 (31 payments)
ℹ️  G4b "Faturado" vs Payment             R$ 14.090,00 = R$ 14.090,00 · delta R$ 0,00
✅ G5 Paridade com a leitura atual        37 legado = 37 view · 0 divergências nos dois sentidos
```

**A divergência de "faturado" que a proposta previa como risco não existe:** delta R$ 0,00.

### O que a nova fonte destrava

| Antes | Depois |
|---|---|
| 37 guias visíveis | **112** (as 112 do banco) |
| 75 guias invisíveis | 0 |
| `billed`/`received` inalcançáveis | 14 `billed` · 4 `received` |
| Estado misto colapsado para `pending` | **9 guias `mixed`**, com contadores por fase |

Distribuição de `billingState`: `no_sessions` 47 · `pending` 33 · `billed` 14 · `mixed` 9 · `received` 4 · `documentation_sent` 3 · `closed` 2.

Totais: 362 sessões no ciclo — `pendingBilling` 159 (R$ 18.360) · `documentationSent` 30 (R$ 2.600) · `billed` 142 (R$ 14.090) · `received` 31 (R$ 3.260).

**Exemplo concreto do ganho** — guia 16007195: o legado mostrava só `documentation_sent, 4 sessões pendentes`. A view mostra `mixed`: 7 sessões já faturadas **+** 4 com documentação enviada. As 7 faturadas eram invisíveis.

### Achados durante a execução

1. **`InsuranceCommunication` não tem campo `sentAt`.** A diretriz pedia esse eixo para a fase "documentação". O model só tem `timestamps` (`createdAt`/`updatedAt`) e `invoiceDate`. Implementado com `invoiceDate` quando existe e `updatedAt` como fallback — que é o proxy que o `insuranceBatchGuideAdapter` já usa. **`updatedAt` se move a qualquer edição do registro**, então é aproximação, não data de envio. Afeta 2 guias hoje. A resposta marca esses casos com `documentationSentAtIsProxy: true`. Corrigir de verdade exige adicionar `sentAt` ao schema — fora deste escopo.

2. **2 sessões apontam para uma guia que não existe mais** (`69d3f78e…`, ambas `scheduled`, abr/2026). Débito de dado pré-existente, não causado pela view: nenhuma é `completed`, então não entra em nenhuma fase nem em nenhum valor financeiro. Não corrigido — correção pela UI, não por script.

3. **`billingState: 'mixed'` não tem tratamento no front.** `getGuideBillingState` ([GuidePendingBillingSection.tsx:179](../../front/src/pages/Financial/tabs/GuidePendingBillingSection.tsx#L179)) faz `switch` nos 5 valores antigos; `'mixed'` cai no `default` e renderiza "Aguardando primeiro faturamento" — rótulo errado. **Requisito obrigatório da Fase 3**, junto com `no_sessions`.

### Aprovação da Fase 3 — 2026-08-07

Fase 3 **aprovada com 4 condições**. Estado de cada uma:

| # | Condição | Status |
|---|----------|--------|
| 1 | `mixed` não pode ser estado de negócio — usar contadores + `hasMixedStates` | ✅ Feito. `GuideBillingLabel` não tem `'mixed'`; rótulo = fase MENOS avançada (próxima ação); teste de contrato trava a ausência do valor |
| 2 | `updatedAt` como data de envio é proxy temporário — abrir tarefa técnica para `sentAt` | ✅ Tarefa aberta: [TAREFA_TECNICA_SENTAT_INSURANCE_COMMUNICATION.md](TAREFA_TECNICA_SENTAT_INSURANCE_COMMUNICATION.md). `documentationSentAtIsProxy` permanece no payload até o campo existir |
| 3 | Troca da fonte atrás de feature flag, com rollback imediato | ✅ `USE_INSURANCE_READ_VIEW` (default **OFF**) + override `?source=v2\|legacy` por request. Ver `insuranceReadSource.js` |
| 4 | Manter a implementação antiga durante observação | ✅ `pending-billing` intacta e ainda é o default. Não remover antes do fim da janela |

**Rollback:** derrubar `USE_INSURANCE_READ_VIEW`. Sem deploy de front.

**Comparação Legacy × ReadView em produção:** a mesma tela pode ser lida nas duas fontes
via `?source=`, e toda resposta da V2 traz `meta.source`/`meta.reason` — a origem do dado
é auditável no próprio payload.

**Consumo do frontend — feito.** `getGuideBillingState`
([GuidePendingBillingSection.tsx](../../front/src/pages/Financial/tabs/GuidePendingBillingSection.tsx))
trata `no_sessions` e o card renderiza os contadores por fase quando `hasMixedStates`
é true. A flag do front é `VITE_USE_INSURANCE_READ_VIEW`.

⚠️ **Os dois gates precisam compor.** O backend responde **409
`INSURANCE_READ_VIEW_DISABLED`** sem `?source=v2` e sem a env `USE_INSURANCE_READ_VIEW`.
Por isso `getInsuranceGuidesView` no front envia `source: 'v2'` em toda request — sem
isso, ligar só a flag do front quebraria a aba inteira.

---

## 8b. Fase 4 — as 4 abas viram buckets de fase (2026-08-07)

As quatro abas derivam da ReadView. **Nenhum status escalar decide em qual aba a guia
aparece** — a regra é o contador da fase:

| Aba | Regra | Exibe |
|---|---|---|
| A Faturar | `sessions.pendingBilling > 0` | só `pendingAmount` |
| Aguardando Faturamento | `sessions.documentationSent > 0` | só `documentationSentAmount` |
| Faturados | `sessions.billed > 0` | só `billedAmount` |
| Recebidos | `sessions.received > 0` | só `receivedAmount` |

A mesma guia aparece em **todas** as abas em que tem conteúdo. Uma guia com 4 a faturar
+ 8 faturadas + 4 recebidas entra nas três, cada uma com a sua parcela — nunca o total
(R$ 2.240), que seria dupla contagem visual.

Com `phase` explícito a view vira **bucket**: guias sem conteúdo naquela fase saem da
lista e os `totals` são escopados ao mesmo recorte. Sem `phase`, a invariante de
completude vale — toda guia aparece.

**Competência:** acumulado é o default. Com filtro, cada fase usa seu eixo — `Session.date`,
data de envio da comunicação, `insurance.billedAt`, `insurance.receivedAt`.

**Compatibilidade:** `getInsuranceReceivables` intacto (`FinancialDashboardTab` depende dele).

Faturados/Recebidos usam `readOnly`: são conferência, não operação.

### Verificação (2026-08-07)

| Checagem | Resultado |
|---|---|
| `tsc -p tsconfig.app.json` | **0 erros** nos arquivos tocados (22 pré-existentes em `useErrorHandler.ts`, intocado) |
| Backend `node --test` | 34 + 7 + 6 = **47 passam** |
| Backend vitest (insurance) | **17 passam** |
| Frontend (novos) | **6 passam** — `insuranceTabPhaseAdapter.test.ts` |
| Reconciliação em produção | **7/7** |

```
✅ G6 Somar as 4 abas reproduz o total uma única vez
   abas somadas: R$ 38.630,00 / 366 sessões · acumulado: R$ 38.630,00 / 366 sessões
✅ G7 Nenhum bucket devolve guia sem conteúdo na fase
   pendingBilling: 41 · documentationSent: 4 · billed: 23 · received: 6
```

Comparação ReadView × Payment SSOT (acumulado):

| Aba | ReadView V2 | Payment SSOT | Delta |
|---|---|---|---|
| A Faturar | 163 sess · R$ 18.680,00 | — (aba nova) | — |
| Aguardando | 30 sess · R$ 2.600,00 | — (aba nova) | — |
| Faturados | 142 sess · R$ 14.090,00 | 142 pmts · R$ 14.090,00 | **R$ 0,00** |
| Recebidos | 31 sess · R$ 3.260,00 | 31 pmts · R$ 3.260,00 | **R$ 0,00** |

### Ressalvas

- **3 testes falham** em `src/hooks/__tests__/useConvenioMetrics.test.ts`. Verificado por
  `git stash` das alterações: falham igual sem elas. Pré-existentes.
- **Nenhuma validação visual em runtime.** A comparação é numérica; a reconciliação chama
  o serviço direto, não a rota HTTP — o gate de 409 não foi exercido de ponta a ponta.
- O trabalho da Fase 3 foi feito **em paralelo por duas frentes**. Ficaram convergidos:
  um único `getGuidesView` com o gate de fonte, e um único doc de tarefa técnica
  (`TAREFA_TECNICA_SENTAT_INSURANCE_COMMUNICATION.md` — um `TECH_DEBT_documentationSentAt.md`
  duplicado foi removido).

**PENDING: ligar `VITE_USE_INSURANCE_READ_VIEW=true` + `USE_INSURANCE_READ_VIEW` em produção — awaiting your authorization.**

---

## 9. Limites desta proposta

- Desenho a partir de leitura de código e consultas ao banco. **Nenhuma tela foi aberta em runtime** — a associação aba→componente vem do código.
- Os números do §0 (9 mistas, 47 sem sessão concluída) vêm de simulação da regra corrigida em consulta direta, não de execução do serviço proposto (que não existe).
- A performance foi estimada por volume de documentos, não medida.
- Nenhum arquivo de código foi criado ou alterado.
