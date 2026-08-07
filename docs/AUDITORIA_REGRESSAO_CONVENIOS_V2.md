# Auditoria de regressão — Read View de Convênios

**Data:** 2026-08-07 · **Baseline:** estado do fluxo novo antes deste trabalho (~18:40)
**Método:** `git diff HEAD` + separação por mtime + varredura de operações de escrita
**Nenhuma alteração foi feita nesta auditoria.**

---

## Veredito

> **A) O fluxo novo permaneceu intacto; somente a leitura foi alterada.**

Com duas ressalvas que **não** são deste trabalho, mas afetam a resposta à pergunta 8 — detalhadas em §4.

---

## 1. Como o escopo foi isolado

O repositório tem 97 arquivos alterados no back e 14 no front **sem commit**, vindos de
pelo menos quatro frentes distintas do mesmo dia. `git diff HEAD` sozinho não distingue
uma da outra. A separação foi feita por horário de modificação:

| Janela | Frente | Relação com esta auditoria |
|---|---|---|
| 09:40–11:28 | guia única por paciente, cutoff, rotas de guia | **anterior** |
| 10:17–10:49 | communication delivery providers (`deliveryMethod`) | **anterior** |
| ~11:00 | remoção do Package como fonte (ADR-001) em `getInsuranceHistory` | **anterior** |
| **18:40–20:06** | **Read View de Convênios** | **este trabalho** |

Inventário completo deste trabalho (todo arquivo `.js`/`.mjs`/`.tsx` tocado após 18:40):

```
back:  services/insuranceGuide/insuranceGuidesReadView.js   (novo)
       services/insuranceGuide/insuranceReadSource.js       (novo)
       tests/insurance/insuranceGuidesReadView.test.js      (novo)
       tests/insurance/insuranceReadSource.test.js          (novo)
       scripts/reconcile-insurance-guides-view.mjs          (novo)
       controllers/insuranceV2Controller.js                 (alterado)
       routes/insuranceV2.routes.js                         (alterado)
       infrastructure/featureFlags/featureFlags.js          (alterado)
       models/InsuranceCommunication.js                     (alterado — só comentário)
       models/InsuranceGuideView.js                         (deletado — modelo morto)

front: src/pages/Financial/tabs/InsuranceTab.tsx            (alterado)
       src/pages/Financial/tabs/GuidePendingBillingSection.tsx (alterado)
       src/services/paymentService.ts                       (alterado)
       src/config/featureFlags.ts                           (alterado)
       src/pages/Financial/tabs/__tests__/insuranceTabPhaseAdapter.test.ts (novo)
```

---

## 2. READ SIDE — arquivos alterados e motivo

| Arquivo | Motivo |
|---|---|
| `insuranceGuidesReadView.js` (novo) | Fonte composta que parte da GUIA, não da sessão pendente. Resolve a causa do legado invisível (75 de 112 guias) |
| `insuranceReadSource.js` (novo) | Resolvedor da fonte: `?source=` > flag > legacy. Condição de rollback |
| `insuranceV2Controller.js` | `+2 imports`, `+getGuidesView` (53 linhas), `+1 export`. **Nenhuma remoção** |
| `insuranceV2.routes.js` | `+1 rota` `/insurance/guides/view` + comentário na legada. **0 linhas removidas** |
| `featureFlags.js` (back) | `+USE_INSURANCE_READ_VIEW`, default **OFF**. Só adição |
| `featureFlags.ts` (front) | `+USE_INSURANCE_READ_VIEW`, default **OFF**. Só adição |
| `paymentService.ts` | `+getInsuranceGuidesView` e tipos. **Só adições**, nenhuma função existente tocada |
| `InsuranceTab.tsx` | 7 gates de flag, cada um com fallback legado; adapter de fase; buckets das abas |
| `GuidePendingBillingSection.tsx` | `readOnly`/`phaseLabel` (defaults preservam o texto e os checkboxes originais), rótulo `no_sessions`, chips de composição |
| `reconcile-insurance-guides-view.mjs` (novo) | Script de conferência. Só leitura + agregações |
| `models/InsuranceGuideView.js` | **Deletado** — 0 imports, 0 documentos na collection. Não era usado pelo fluxo novo |

---

## 3. WRITE SIDE

> **Nenhuma alteração.**

Verificado item a item:

| Item perguntado | Resultado | Evidência |
|---|---|---|
| Criação de `InsuranceGuide` | intacta | nenhum arquivo de criação de guia tocado após 18:40 |
| Geração de `Session` | intacta | idem |
| Faturamento | intacto | — |
| `buildBatchFromGuides` | **intacto** | a função não aparece no diff de `insuranceBatchGuideAdapter.js` (0 ocorrências) |
| `Payment.insurance` | intacto | `models/Payment.js` não foi tocado |
| Baixa / recebimento | intacto | `receberLote`, `receiveSession`, `billSession` fora de todos os hunks deste trabalho |
| `InsuranceCommunication` | **só comentário** | o hunk adiciona um comentário sobre a ausência de `sentAt`. O campo `deliveryMethod` no mesmo hunk é da frente de communication (10:17), não desta |
| Envio de documentação | intacto | `BillingCommunicationWizard` (10:48) e `EnviosTab` (10:49) são anteriores |
| Workers | intactos | `find workers/ -newermt "18:40"` → vazio |
| State machines | intactas | idem |

**Prova de que a Read View é read-only:**

```
grep -E "\.save\(|\.create\(|\.insert|\.update|deleteOne|deleteMany|
         findOneAndUpdate|findByIdAndUpdate|bulkWrite|\$set|\$inc|\$push|\$pull"
  → nenhum resultado

operações presentes: 6 × .find()   6 × .lean()
```

O único casamento textual com `sentAt` é o nome de uma propriedade num objeto de
resposta (`sentAt: comm.invoiceDate || comm.updatedAt`), não uma escrita.

**Frontend:** nenhum handler de ação foi tocado. Busca por `faturarConvenioLote`,
`receberConvenioLote`, `billInsuranceSession`, `receiveInsuranceSession`, `encerrarGuia`,
`createInsurancePayment` no diff do `InsuranceTab.tsx` → **zero ocorrências**.

---

## 4. Respostas objetivas

**1. Houve alteração em qualquer caminho de escrita do fluxo novo?**
Não.

**2. Nos 10 itens listados?**
Não, exceto um comentário em `InsuranceCommunication.js` (sem efeito em runtime).

**3. Comportamento novo fora da camada de leitura?**
Sim, um — e é intencional: a rota **nova** `/insurance/guides/view` responde **409
`INSURANCE_READ_VIEW_DISABLED`** quando a flag está OFF e não vem `?source=v2`. Só afeta
a rota nova; nenhum consumidor existente a chama.

**4. Alguma função do fluxo novo foi modificada para acomodar legado?**
Não. A Read View é aditiva; `listGuidesPendingBilling` e `buildBatchFromGuides` não foram
tocados por este trabalho.

**5. A Read View é read-only?**
Sim, provado por varredura (§3).

**6. O `InsuranceTab` muda só a fonte de leitura?**
Sim. Todos os 7 pontos de flag trocam de onde os dados vêm; nenhuma ação de
faturamento/recebimento foi alterada. `readOnly` **esconde** seleção nas abas de
conferência — não remove nem altera nenhuma ação.

**7. A rota `pending-billing` continua igual com a flag OFF?**
Sim. Diff da rota: 0 remoções, só um comentário. O handler `listPendingGuides` não foi
tocado por este trabalho.

**8. Com `VITE_USE_INSURANCE_READ_VIEW=false`, o sistema se comporta exatamente como antes?**
**Sim em relação a este trabalho** — todos os gates caem no ramo legado, e os defaults
`readOnly = false` / `phaseLabel = 'para faturar'` reproduzem o texto e os checkboxes
originais.

⚠️ **Mas não em relação a hoje de manhã**, por uma mudança que **não é deste trabalho**:

> `LEGACY_PENDING_CUTOFF` passou de `2026-05-01` → `2026-03-01`
> (`insuranceBatchGuideAdapter.js:230`, modificado às **11:28**)

Com a flag OFF, a aba "A Faturar" agora mostra também março e abril. É read-side (o
constante só é lida em `listGuidesPendingBilling:303`, **não** alcança
`buildBatchFromGuides`), mas muda o que a secretária vê. Decisão de produto registrada no
próprio comentário do código — **confirmar se foi intencional**.

---

## 5. Alterações desnecessárias que podem ser revertidas

| Item | Risco | Recomendação |
|---|---|---|
| Comentário sobre `sentAt` em `models/InsuranceCommunication.js` | Nenhum (comentário) | Pode ser revertido; a informação já está em `TAREFA_TECNICA_SENTAT_INSURANCE_COMMUNICATION.md`. Manter é defensável — avisa quem lê o schema |
| Deleção de `models/InsuranceGuideView.js` | Nenhum — 0 imports, 0 documentos | Manter deletado. Recuperável por git se necessário |

**Nada funcional deste trabalho precisa ser revertido.**

---

## 6. Limites desta auditoria

- O repositório tem **muita alteração sem commit de várias frentes do mesmo dia**. A
  atribuição por mtime é confiável para arquivos novos e para os que só este trabalho
  tocou, mas em `InsuranceTab.tsx` e `GuidePendingBillingSection.tsx` **não é possível
  separar por git** minhas edições das que já estavam pendentes (ex.: o helper
  `getGuidePendingTotal`, que substituiu `g.pendingValue` inline, não é deste trabalho).
  Para esses dois arquivos a verificação foi comportamental (gates + defaults), não por diff.
- **Nada foi validado por HTTP.** A reconciliação chama o serviço direto; o gate 409 nunca
  foi exercido ponta a ponta.
- Foram encontrados 3 scripts destrutivos tocados na mesma janela
  (`cleanup-test-patients-2026-08-07.js`, `cleanup-test-insurance-guides.js`,
  `audit-test-insurance-guides.js`) — pertencem à frente de limpeza de dados de teste, não
  a esta. São standalone: não afetam runtime, mas **apagam dados de produção se executados**.
