# Invariantes do Domínio Financeiro — Constituição
> Aprovada em 2026-06-30. Toda implementação financeira deve respeitar estas invariantes.
> Alterações exigem revisão arquitetural explícita + atualização desta versão.

---

## O que é uma invariante de domínio

Uma invariante não é uma regra de negócio configurável.
É uma propriedade que **nunca pode ser falsa**, em nenhum estado do sistema,
independente de quem criou o registro, quando ou por qual fluxo.

Se uma função viola uma invariante — mesmo que os testes passem — a função está errada.

---

## INVARIANTE 1 — Caixa é independente de Appointment

```
Caixa nunca depende do estado de um Appointment.
```

**Por quê:** Caixa é um evento de pagamento. Após ocorrer, é imutável.
O cancelamento de um Appointment não desfaz o caixa — gera crédito ou estorno, que são novos eventos.

**Consequência prática:**
- `calculateCash()` nunca faz JOIN com Appointment
- `Payment.status = 'paid'` é suficiente para contar caixa
- O status do Appointment não filtra, não pondera, não exclui nenhum Payment do caixa

---

## INVARIANTE 2 — Produção é independente de Payment

```
Produção nunca depende do estado de um Payment.
```

**Por quê:** Produção é a execução clínica. Uma sessão realizada conta como produção mesmo que o pagamento ainda não tenha chegado — ou jamais chegue.

**Consequência prática:**
- `calculateProduction()` nunca faz JOIN com Payment
- `Session.status = 'completed'` é suficiente para contar produção
- O status do Payment não filtra, não pondera, não exclui nenhuma Session da produção

---

## INVARIANTE 3 — Receita Reconhecida é Produção

```
Receita Reconhecida = Produção
```

**Por quê:** Em regime de competência, o fato gerador da receita é a prestação do serviço (sessão realizada), não o recebimento do dinheiro. Reconhecer receita = ter executado a sessão.

**Identidade derivada:**
```
Produção = Caixa + A Receber
```
portanto
```
Receita Reconhecida = Caixa + A Receber
```

A segunda equação é uma **consequência** da primeira, não a definição.
Nunca calcular Receita Reconhecida somando Caixa + A Receber diretamente — calcular via Produção.

---

## INVARIANTE 4 — A Receber nasce de eventos de domínio, não de agregados

```
A Receber = Payments.pending originados por Session.completed
```

**Por quê:** A Receber é uma obrigação financeira gerada por um evento clínico. A cadeia é:

```
Session.completed
      ↓
Payment.pending criado (obrigação nasce)
      ↓
Payment.paid   (obrigação liquidada → entra no Caixa)
```

Um Payment.pending sem Session.completed correspondente **não é A Receber** — é uma pendência financeira sem fato gerador clínico (pode ser dado inconsistente ou pré-pagamento).

**Consequência prática:**
- A Receber = `Payment.find({ status: 'pending', appointment.operationalStatus: 'completed' })`
- A fórmula `Produção − Caixa` é uma **aproximação de validação**, não a fonte de verdade
- A aproximação é útil para detectar bugs e para cross-checks, mas não deve ser usada como cálculo primário
- Um Payment.pending de sessão futura (agendada mas não realizada) **não entra** em A Receber

**Nota sobre a fórmula `Produção − Caixa`:**
Essa diferença é útil como validação cruzada (os valores devem ser próximos) mas não é a definição. Em regimes com pré-pagamento (pacotes), `Caixa > Produção` no período de compra e `Produção > Caixa` nos períodos de execução — a identidade só fecha no ciclo de vida completo do pacote.

---

## INVARIANTE 5 — Provisionamento nunca compõe KPIs realizados

```
Provisionamento ≠ A Receber
Provisionamento ≠ Receita Reconhecida
Provisionamento não entra no dashboard financeiro principal
```

**Por quê:** Provisionamento é estimativa futura com probabilidade < 1. KPIs realizados são fatos passados com certeza = 1. Misturar os dois corrompe ambos.

**Consequência prática:**
- `provisionamentoService.js` é um sistema separado com endpoint próprio (`/api/provisionamento`)
- Nenhuma função de provisionamento é chamada dentro de `calculateRealTime()`, `calculateCash()`, `calculateProduction()`
- Nenhum KPI do dashboard usa fator de probabilidade (0.85, 0.40, etc.)

---

## INVARIANTE 6 — Backlog não é A Receber

```
Backlog Contratado ≠ A Receber
Backlog Autorizado ≠ A Receber
```

**Por quê:** Backlog é receita futura (sessões a executar). A Receber é receita passada (sessões executadas, dinheiro não chegou). São direções opostas no tempo.

| | Sessão realizada? | Pagamento recebido? |
|--|--|--|
| **A Receber** | Sim | Não |
| **Backlog** | Não | Sim (pacote) ou Autorizado (guia) |

**Consequência prática:**
- `Package.sessionsRemaining` é Backlog, nunca A Receber
- `InsuranceGuide.remainingSessions` é Backlog Autorizado, nunca A Receber
- A Receber de convênio vem de `Session.completed` não de `InsuranceGuide.totalSessions`

---

## INVARIANTE 7 — Forecast não altera Receita Reconhecida

```
Projeção futura (forecast) não modifica nenhum KPI realizado.
```

**Por quê:** Forecast é uma estimativa do que vai acontecer. Receita Reconhecida é o que já aconteceu. Nenhum modelo preditivo, nenhum fator de ritmo diário, nenhuma extrapolação pode aparecer dentro de um KPI de realizado.

**Consequência prática:**
- `calculateMetas()` e `calculateRealTime()` têm seções separadas para "realizado" e "projeção"
- A projeção de fim de mês (`projecaoFinal`) nunca sobrescreve `receitaReconhecida`
- Campos de forecast têm nomes distintos: `projecaoFinal`, `cenarioRealista`, etc.

---

## INVARIANTE 8 — Cada KPI tem exatamente uma função responsável

```
Para cada KPI financeiro, existe exatamente uma função canônica.
Qualquer outro ponto do sistema que precise do valor chama essa função.
Nenhum código reimplementa o cálculo inline.
```

**Mapa canônico atual:**

| KPI | Função SSOT | Arquivo |
|-----|-------------|---------|
| Caixa | `calculateCash(start, end)` | `unifiedFinancialService.v2.js` |
| Produção | `calculateProduction(start, end)` | `unifiedFinancialService.v2.js` |
| A Receber | `calculatePendentesEngine()` com filtro `appointment.completed` | `financialEngine.js` (a corrigir — P1) |
| Pendentes | a definir — P1 do roadmap | — |
| Receita Reconhecida | `calculateProduction()` (= Produção) | `unifiedFinancialService.v2.js` |
| Provisionamento | `calcularProvisionamento()` | `provisionamentoService.js` |
| Backlog Contratado | a implementar — P2 do roadmap | — |
| Backlog Autorizado | a implementar — P2 do roadmap | — |
| Capacidade Comprometida | a implementar — P2 do roadmap | — |
| Receita em Risco | a implementar — P3 do roadmap | — |

---

## INVARIANTE 9 — Separação estrita dos 3 regimes

```
Regime de Caixa        = o que foi recebido  (Payment.paid)
Regime de Competência  = o que foi produzido  (Session.completed)
Regime de Forecast     = o que pode ser produzido (estimativa)
```

Esses três regimes **nunca são somados em um único número**.
KPIs de regimes diferentes nunca aparecem no mesmo card do dashboard sem label explícito de qual regime é.

---

## INVARIANTE 10 — KPI não depende da tela que o consome

```
Nenhum KPI pode ser influenciado pela tela, componente ou endpoint que o consome.
```

**Por quê:** O domínio financeiro não conhece o frontend. Um KPI calculado diferente por contexto de chamada é um KPI mal definido — o problema está na definição, não na tela.

**Consequência prática:**
- `calculateCash()`, `calculateProduction()`, etc. não recebem parâmetros de "modo de exibição"
- Se duas telas precisam de valores diferentes, precisam de KPIs com nomes diferentes — não do mesmo KPI com lógica condicional
- Nenhuma função de domínio importa ou referencia componentes de rota ou de frontend

---

## INVARIANTE 11 — Nenhum KPI é calculado duas vezes

```
Se o sistema precisa de um KPI em dois lugares, chama a função canônica.
Nunca reimplementa o cálculo inline.
```

**Por quê:** Duas implementações do mesmo cálculo divergem. É só questão de quando, não se.

**Consequência prática:**
- `totals.v2.js` deve chamar `unifiedFinancialService.calculateCash()` — não recalcular com Payment.aggregate local
- ~~`FinancialOverviewService`~~ — **removido** (código morto, nunca montado em produção)
- Qualquer código que precise de Produção importa e chama `calculateProduction` — nunca agrega Session.completed diretamente

---

## INVARIANTE 12 — Competência e Caixa operam em bases temporais distintas

```
Produção = Caixa + A Receber  SOMENTE quando Caixa
representa o recebimento da mesma receita reconhecida no período.
```

**Por quê:** Em operações com pré-pagamento (pacotes), o fluxo de caixa antecede a execução das sessões. A identidade `Produção = Caixa + A Receber` não fecha mensalmente — e isso é **esperado**, não um erro.

**Exemplo:**
```
Junho:  Compra de pacote R$1.000  →  Caixa +R$1.000, Produção +R$0
Julho:  Executa 5 sessões         →  Caixa +R$0,    Produção +R$500
Agosto: Executa 5 sessões         →  Caixa +R$0,    Produção +R$500
```
A identidade fecha **no ciclo de vida do pacote** (R$1.000 = R$1.000), não no corte mensal.

**Consequência prática:**
- A divergência mensal entre Produção e Caixa não é bug — é a separação natural entre regime de competência e regime de caixa
- Para pacotes prepaid: `Caixa > Produção` no mês de compra; `Produção > Caixa` nos meses de execução
- Para particular avulso, convênio e liminar: a identidade **fecha mensalmente** (evento de receita e evento de caixa ocorrem no mesmo ciclo)
- A fórmula `Produção − Caixa` é válida como **aproximação de cross-check**, não como cálculo primário de A Receber

**O que o dashboard deve exibir:**
- Regime de Competência: Produção (o que foi produzido)
- Regime de Caixa: Caixa (o que foi recebido)
- A Receber: obrigações pendentes por eventos de domínio (não a diferença dos agregados)
- Nunca somar os três — são visões complementares, não componentes de uma mesma equação mensal

---

## Mapa de dependências entre entidades e KPIs

```
ENTIDADES                EVENTOS              KPIs REALIZADOS
─────────────────────────────────────────────────────────────

Session.completed ──────────────────────────► Produção
      │                                              │
      │                              ┌───────────────┼───────────────┐
      │                              ▼               ▼               ▼
      │                       Receita           A Receber      Pendentes
      │                     Reconhecida    (por categoria)    (por paciente)
      │
Payment.paid ───────────────────────────────► Caixa
                                                     │
                                              Fluxo de Caixa
                                              (por dia/método)

─────────────────────────────────────────────────────────────
CONTRATOS                ESTADO               KPIs DE BACKLOG
─────────────────────────────────────────────────────────────

Package[paid] ──────────────────────────────► Backlog Contratado
   │ sessionsRemaining × sessionValue                │
   │                                         Capacidade
InsuranceGuide[active] ─────────────────────► Backlog Autorizado
   │ remainingSessions × sessionValue         Comprometida
   │                                                 │
   └──────────────────────────────────────────► Backlog Executável
                                               (Autorizado - não executável)

─────────────────────────────────────────────────────────────
ESTIMATIVAS              PROBABILIDADE        KPIs DE FORECAST
─────────────────────────────────────────────────────────────

Backlog Contratado ─────────── ×0.95 ───────► Garantido
Appointment.confirmed ─────── ×0.90 ───────► Agendado Confirmado
Recorrentes Implícitos ─────── ×0.65 ───────► Recorrência Esperada
Appointment.pending ─────────── ×0.40 ───────► Agendado Pendente
Leads + Avaliações ────────── ×0.20 ───────► Pipeline
                                                     │
                                                     ▼
                                              Provisionamento
                                              (sistema separado)

─────────────────────────────────────────────────────────────
IDENTIDADES QUE NUNCA PODEM QUEBRAR:

  Produção = Caixa + A Receber          ← deve fechar sempre
  Backlog_t = Backlog_{t-1} − Produção + Novas_Vendas  ← equilíbrio de estoque
  Capacidade Comprometida = sum(sessões restantes em contratos ativos)
```

---

## Decisão fechada — Modelo de guia de convênio

> **Pergunta:** Uma guia com 10 sessões autorizadas, 3 realizadas e 7 futuras. Como aparece no A Receber?

**Decisão: Modelo A — Competência (adotado)**

```
A Receber da guia = 3 sessões realizadas × valor
Backlog Autorizado = 7 sessões futuras × valor
```

**Justificativa:**
Preserva todas as identidades financeiras sem exceção. O fato gerador financeiro é a sessão realizada (Session.completed), não a autorização da guia. Uma guia autorizada mas não executada é compromisso operacional (Backlog Autorizado), não receita reconhecida.

**Consequência para `calculateAReceber()`:**
- Fonte de dados: `Session.completed` (não `Payment.pending`)
- Filtro: `paymentMethod = 'convenio' OR insuranceGuide exists AND Session.status = 'completed'`
- A Receber = sessions realizadas sem Payment.paid correspondente (ou seja, `producao.convenio − caixa.convenio`)
- Sessions futuras da guia → não entram em A Receber → entram em `backlogAutorizado`

---

## Protocolo de validação com dados reais

Antes de implementar qualquer fix, verificar se o modelo fecha com dados reais de junho/2026.
Ver script: `back/scripts/validate-financial-model-june2026.mjs`

### Identidades a validar

**Identidade 1 — Produção = Caixa + A Receber**
```
calculateProduction(jun_start, jun_end)
= calculateCash(jun_start, jun_end)
+ max(0, producao.X − caixa.X)  para cada categoria X
```
Esta deve ser tautologicamente verdadeira pelo modelo. Se não fechar, há erro de dados ou de `effectiveValue`.

**Identidade 2 — Equilíbrio de Backlog**
```
Backlog_final = Backlog_inicial − Produção_do_mês + Novas_vendas_do_mês
```
Verifica se a lógica de decremento de `sessionsRemaining` está correta nos pacotes.

**Identidade 3 — Capacidade Comprometida**
```
sum(Package.sessionsRemaining)    [pacotes ativos]
+ sum(InsuranceGuide.remainingSessions)  [guias ativas]
= total de sessões comprometidas hoje
```

**Diagnóstico adicional — divergência entre implementações**
```
calculateAReceber_bugado()    ← valor atual (com createdAt)
vs
producao.convenio − caixa.convenio  ← valor correto (derivado)
```
A diferença entre os dois é o tamanho do bug.

---

## INVARIANTE 13 — `Payment.splitMethods` é o SSOT da composição de pagamento

```
A composição de um pagamento (quais métodos e quais valores) reside APENAS em Payment.splitMethods.
Nenhum outro campo define como um pagamento foi realizado.
```

**Por quê:** Durante a semana de 2026-06-30 a 2026-07-01, bugs de "R$0 no caixa" e "método errado"
foram rastreados ao fato de que `cashflow.v2.js` e modais liam `Appointment.paymentForms` ou
`Payment.paymentMethod` para determinar a composição — ambos incompletos para pagamentos com split.

**Estrutura de um pagamento com split:**
```js
Payment {
  paymentMethod: 'pix',      // ← apenas atalho/compatibilidade (primeiro método)
  splitMethods: [            // ← SSOT da composição
    { method: 'pix',      amount: 250 },
    { method: 'dinheiro', amount: 200 }
  ]
}
```

**Regras:**
- `Payment.paymentMethod` = primeiro método ou método único. Nunca representa o pagamento completo quando há split.
- `Payment.splitMethods` = array completo. Presente apenas quando `length >= 2`.
- Para pagamento simples: `splitMethods` é `null` ou `[]`; usar `paymentMethod` é correto.
- Para pagamento split: usar `splitMethods`. Ignorar `paymentMethod`.

**Consequência prática:**
- Todo consumidor que precise da composição (cashflow, modal, dashboard) deve verificar `splitMethods?.length >= 2` primeiro.
- `metodo` em transações do caixa é `'Split'` quando `splitMethods.length >= 2` — não `'Pix'`, não `'Dinheiro'`.
- Os totais de caixa por método (pix/dinheiro/cartão) devem distribuir por `splitMethods` quando presentes.

**Campo legado — `Appointment.paymentForms`:**
```
STATUS: LEGADO — não usar em novas implementações.
Razão: foi substituído por Payment.splitMethods como SSOT.
Pendente: remoção após auditoria de consumidores.
```

---

## INVARIANTE 14 — Datas financeiras são imutáveis após liquidação

```
paymentDate, financialDate e paidAt de um Payment.paid nunca são alterados.
```

**Por quê:** Essas datas representam **quando o dinheiro entrou**. Alterar retroativamente
destrói a rastreabilidade do caixa e quebra relatórios de competência.

**Regra:** A data financeira é determinada no momento do `Payment.status: 'paid'`.
Nenhum evento posterior (cancelamento, reagendamento, edição de sessão) altera essas datas.

**O que fazer quando o dinheiro foi registrado na data errada:**
Criar um estorno + novo payment com a data correta. Nunca fazer `$set: { financialDate: novaData }` diretamente.

---

## INVARIANTE 15 — Dois fluxos de pagamento são válidos; `confirmed + paid` não é bug

```
Fluxo A: complete → Payment.paid criado automaticamente
Fluxo B: Payment registrado manualmente → Appointment permanece confirmed
```

**Estado `confirmed + paid` é explicitamente válido.**

**Consequência prática:**
- Nenhum código pode assumir que `Appointment.confirmed` significa "sem pagamento".
- Nenhum código pode assumir que `Payment.paid` implica `Appointment.completed`.
- Para saber se um appointment tem pagamento: verificar `Payment.find({ appointment: id, status: 'paid' })`, não `appointment.operationalStatus`.
- O dashboard financeiro deve incluir payments de appointments `confirmed` no caixa (Fluxo B).

---

## Violações conhecidas (pendentes de correção)

| Invariante | Violação | Arquivo | Status |
|------------|----------|---------|--------|
| INV-4 | `calculateAReceber()` usa `Payment.pending` com filtro `createdAt` | `financialDashboard.v2.js:1612` | P1 — pendente de decisão na pergunta acima |
| INV-4 | `calculatePendentesEngine()` não exige `appointment.completed` | `financialEngine.js:201` | P1 |
| INV-8 | `totals.v2.js` reimplementa `calculateCash()` inline | `totals.v2.js:95-137` | P2 |
| INV-8 | ~~`FinancialOverviewService` usa `receita = caixa`~~ | **REMOVIDO** — código morto eliminado | ✅ |
| INV-3 | `receitaReconhecida` nomeada `receitaProjetada` internamente | `financialDashboard.v2.js:1476` | ✅ corrigido — agora `production.total` |
| INV-13 | `cashflow.v2.js` lia `appt?.paymentForms` em vez de `Payment.splitMethods` | `cashflow.v2.js:380,516` | ✅ corrigido em 2026-07-01 |
| INV-13 | `appointmentReads.js` não populava `splitMethods` no populate de payment | `appointmentReads.js:92,510,599` | ✅ corrigido em 2026-07-01 |
| INV-13 | `Appointment.paymentForms` ainda existe no modelo como campo legado | `models/Appointment.js` | P2 — remover após auditoria |
