# Matriz de KPIs Financeiros — Single Source of Truth
> Versão 2 — Revisada em 2026-06-30 com refinamentos arquiteturais.
> Invariantes formais em `FINANCIAL_DOMAIN_INVARIANTS.md`.

---

## Como ler este documento

Para cada KPI:
- **Definição canônica**: o que significa no domínio (regime de competência)
- **Implementações existentes**: todos os lugares no código que calculam ou expõem esse valor
- **Problemas encontrados**: divergências, bugs, nomes conflitantes
- **SSOT aprovada**: definição que deve prevalecer após consolidação

---

## 1. CAIXA

**Definição canônica:** Dinheiro efetivamente recebido no período. Evento imutável. Regime de caixa.

### Implementações existentes

| # | Arquivo | Função | Entidade | Campo data | Observação |
|---|---------|--------|----------|------------|------------|
| A | `unifiedFinancialService.v2.js` | `calculateCash(start, end)` | `Payment` | `financialDate` → fallback `paymentDate` → `createdAt` | **SSOT declarado** |
| B | `financialDashboard.v2.js` | `calculateRealTime()` | delega a A | — | Correto |
| C | `FinancialOverviewService.js` | `_calculateMetrics()` | delega a A | — | Correto |
| D | `totals.v2.js` | agregação direta | `Payment` | `financialDate` | Reimplementa A sem filtro `isFromPackage` |

### Problemas
- D duplica a lógica de A sem o filtro `isFromPackage`, podendo contar pagamentos de pacotes pré-pagos.
- Fallback `createdAt` em A é risco latente: Payment sem `financialDate` e sem `paymentDate` entra no caixa pela data de criação.

### ✅ SSOT aprovada
```
CAIXA = unifiedFinancialService.calculateCash(start, end)

Payment.status = 'paid'
AND kind ≠ 'package_consumed'
AND (isFromPackage ≠ true OR kind = 'session_payment')
Campo de data canônico: financialDate
```

---

## 2. PRODUÇÃO

**Definição canônica:** Valor dos serviços clínicos prestados no período. Fato gerador da receita. Regime de competência.
`Produção = Receita Reconhecida` (ver KPI 5).

### Implementações existentes

| # | Arquivo | Função | Entidade | Campo data | Observação |
|---|---------|--------|----------|------------|------------|
| A | `unifiedFinancialService.v2.js` | `calculateProduction(start, end)` | `Session` | `date` | **SSOT declarado** — sum(`effectiveValue`) |
| B | `unifiedFinancialService.v2.js` | `calculateProductionForDashboard(start, end)` | `Session` | `date` | A + breakdown por tipo + `particularPendente` + `pacotePendente` |
| C | `financialDashboard.v2.js` | `calculateRealTime()` | delega a B | — | Correto |
| D | `totals.v2.js` | `sessionProductionResult` | delega a A | — | Correto |
| E | `ConvenioMetricsService.js` | `_calcularReceitaRealizada()` | `Session` | `date` | Apenas convênio — correto para seu contexto |
| F | `FinancialOverviewService.js` | `_calculateMetrics()` | delega a A (via `calculateCash`) | — | **Bug conceitual**: expõe `caixa` como `receita` |

### Problemas
- F confunde Produção com Caixa, retornando `receita = caixa` — viola Invariante 2 e 3.
- `effectiveValue` depende de `resolveSessionFinancialValue.js` — calibração correta por tipo é crítica.

### ✅ SSOT aprovada
```
PRODUÇÃO = unifiedFinancialService.calculateProduction(start, end)

Session.status = 'completed'
AND date >= start AND date <= end
Valor: Session.effectiveValue
Campo de data canônico: Session.date
```

---

## 3. A RECEBER

**Definição canônica:** Produção realizada que ainda não se converteu em caixa. É uma **consequência** — não uma consulta de Payment.pending.
```
A Receber = Produção − Caixa   (por categoria, sempre ≥ 0)
```

> Este é o KPI mais fragmentado do sistema. **5 implementações com 3 semânticas incompatíveis.**

### Implementações existentes

| # | Arquivo | Função | Semântica | Correto? |
|---|---------|--------|-----------|---------|
| A | `financialDashboard.v2.js` | `calculateRealTime()` — `aReceberProducao` | `max(0, producao.X − caixa.X)` por categoria | **Sim** — segue definição canônica |
| B | `financialDashboard.v2.js` | `calculateAReceber(year, month)` | `Payment.pending` com filtro `createdAt OR serviceDate OR paymentDate` | **Não** — bug de data + semântica errada |
| C | `ConvenioMetricsService.js` | `_calcularAReceber()` | `Session.completed` até fim do mês, não pagas (histórico acumulado) | Parcial — correto para convênio histórico, mas não é "do mês" |
| D | `FinancialOverviewService.js` | `_calculateMetrics().aReceber` | `Payment.paid + insurance.pending_billing` + `Payment.pending` | Diferente — válido para analytics, mas outra semântica |
| E | `totals.v2.js` | `totalInsurancePending` | loop em Appointments sem payment pago (inclui futuros) | **Não** — inclui sessões não realizadas |

### Bug crítico em B
`calculateAReceber()` usa `createdAt` como terceiro filtro de data alternativo. Um Payment de convênio criado em junho referente a uma sessão de abril é incluído. Resultado: `aReceber.total ≈ R$22.440` vs valor correto de `convenioAReceber ≈ R$9.200`.

### Pergunta de negócio em aberto (bloqueia implementação)
Ver `FINANCIAL_DOMAIN_INVARIANTS.md — Pergunta em aberto`:
> Uma guia com 10 sessões autorizadas, 3 realizadas e 7 futuras. Como ela aparece no A Receber?
- **Opção A** (recomendada): só as 3 realizadas → A Receber. As 7 vão para Backlog Autorizado.
- **Opção B**: a guia inteira como A Receber (violaria Invariante 4).
- **Opção C**: 3 em A Receber + 7 em Pipeline.

### ✅ SSOT aprovada
```
A RECEBER = Payment.pending WHERE appointment.operationalStatus = 'completed'

Fonte de verdade: evento de domínio (Session.completed → obrigação financeira)
Não é calculado como Produção − Caixa (essa diferença é aproximação de cross-check)

Por categoria:
  convenioAReceber    → Payment.pending de sessões convênio completed
  liminarAReceber     → Payment.pending de sessões liminar completed
  particularPendente  → Payment.pending de sessões particular completed
  pacotePendente      → Payment.pending de sessões pacote completed (não package_paid)

Implementação de referência: lógica de getPatientPendingPayments() (financialEngine.js:274)
  → propagar para calculatePendentesEngine() — P1 do roadmap

Sobre Produção − Caixa:
  Útil como cross-check. Diverge para pacotes prepaid (bases temporais diferentes).
  A divergência mensal é esperada e não caracteriza erro no modelo.
  Ver FINANCIAL_DOMAIN_INVARIANTS.md INV-12.

Função B (calculateAReceber) deve ser corrigida: remover filtro createdAt,
  filtrar por Session.completed como fonte de obrigação financeira.
```

---

## 4. PENDENTES

**Definição canônica:** Igual à definição de A Receber — é o mesmo conceito, com granularidade por paciente/pagamento.
```
Pendentes = Produção realizada − Recebimento realizado
```
Não é uma consulta de `Payment.pending`. Um paciente sem Payment registrado ainda é "pendente".

### Implementações existentes

| # | Arquivo | Função | Semântica | Filtra session.completed? |
|---|---------|--------|-----------|--------------------------|
| A | `financialEngine.js` | `calculatePendentesEngine()` | `Payment.pending` por `paymentDate` no período | **Não** — inclui sessões futuras |
| B | `financialEngine.js` | `getPatientPendingPayments()` | `Payment.pending` + join `appointment.operationalStatus = 'completed'` | **Sim** — correto, mas só usado na visão por paciente |
| C | `financialDashboard.v2.js` | `calculatePendentes()` | delega a A | **Não** — herda o problema |
| D | `totals.v2.js` | `appointmentPendingTotal` | loop em Appointments `{confirmed, completed, scheduled, pre_agendado}` sem payment | **Não** — inclui futuros |

### Problema principal
A (e por consequência C) não exige que a sessão tenha sido realizada. Um Appointment `scheduled` com Payment `pending` entra nos Pendentes — inflando com receita futura que não é dívida real.

A lógica correta existe em B mas nunca foi propagada para os totais do dashboard.

### ✅ SSOT aprovada
```
PENDENTES (para listagem por paciente) =
  Payment.pending WHERE appointment.operationalStatus = 'completed'
  AND paymentDate IN período

PENDENTES (para total do dashboard) =
  derivado de A Receber (mesma fórmula, mesma fonte)
  — não recalcular: reutilizar os mesmos campos já calculados em calculateRealTime()

Implementação de referência da lógica: getPatientPendingPayments() (financialEngine.js:274-275)
A ser propagada para calculatePendentesEngine()
```

---

## 5. RECEITA RECONHECIDA

**Definição canônica:** Em regime de competência, o fato gerador é a prestação do serviço. Logo:
```
Receita Reconhecida = Produção
```
A relação `Caixa + A Receber = Produção` é uma identidade derivada, não a definição.

### Implementações existentes

| # | Arquivo | Nome no código | Fórmula | Correto? |
|---|---------|---------------|---------|---------|
| A | `financialDashboard.v2.js` | `receitaReconhecida` (alias interno: `receitaProjetada`) | `caixa + aReceberProducao` | Matematicamente correto, semântica confusa |
| B | `financialDashboard.v2.js` | `realizadoMes` (em `calculateMetas`) | `caixa + aReceberProducao` | Mesmo valor, terceiro nome |
| C | `FinancialOverviewService.js` | `receita` | `caixa` apenas | Incorreto — ignora A Receber |

### Problemas
- Três nomes para o mesmo conceito: `receitaReconhecida`, `receitaProjetada`, `realizadoMes`.
- `receitaProjetada` é nome **enganoso** — soa como forecast, é na verdade realizado.
- C usa só caixa — correto para regime de caixa, mas errado para competência.

### ✅ SSOT aprovada
```
RECEITA RECONHECIDA = Produção (calculateProduction)
                    = Caixa + A Receber Total  [identidade derivada]

Nome canônico: receitaReconhecida
Eliminar: receitaProjetada (renomear), realizadoMes (consolidar)
```

---

## 6. PROVISIONAMENTO

**Definição canônica:** Estimativa probabilística de receita futura. Sistema separado. Nunca entra em KPIs realizados.

### Implementações existentes

| # | Arquivo | Camada | O que calcula | Fator de certeza |
|---|---------|--------|---------------|-----------------|
| A | `provisionamentoService.js` | `calcularGarantido()` | `Package.paid` → `sessionsRemaining × sessionValue` | 0.95 |
| B | `provisionamentoService.js` | `calcularAgendadoConfirmado()` | `Appointment.confirmed` no período | 0.90 |
| C | `provisionamentoService.js` | `calcularAgendadoPendente()` | `Appointment.scheduled/pre_agendado` | 0.40 |
| D | `provisionamentoService.js` | `calcularConvenioAgendado()` | Sessions convênio agendadas futuras | 0.85 |
| E | `provisionamentoService.js` | `calcularPipeline()` | Leads + avaliações agendadas | 0.20 |
| F | `ConvenioMetricsService.js` | `_getProvisaoConvenio()` | `Session.completed` acumulado não pago (histórico) | — |
| G | `ConvenioMetricsService.js` | `provisaoAgendadas` | Sessions convênio agendadas futuras | — |
| H | `financialDashboard.v2.js` | `calculateAReceber()` | `Payment.pending` com bug de data | — |

### Problemas
- H é nomeada "A Receber" mas é na prática um provisionamento com semântica errada.
- F chama de "provisão" o que é na verdade A Receber histórico de convênio (sessões realizadas não pagas).
- Não existe camada de **Recorrentes Implícitos** (pacientes ativos mês anterior sem sessão criada no mês atual).

### Camada faltante: Recorrentes Implícitos
```
Recorrentes Implícitos =
  Pacientes com Session.completed no mês M-1
  que não têm Appointment agendado no mês M
  → estimativa: mediana de sessões/mês nos últimos 90 dias × sessionValue
  Fator de certeza: ~0.65
```

### ✅ SSOT aprovada
```
PROVISIONAMENTO = sistema separado, endpoint /api/provisionamento

Camadas (certeza decrescente):
  1. Backlog Contratado   (~0.95) — pacotes pagos, sessões não realizadas
  2. Agenda Confirmada    (~0.90) — appointments confirmed
  3. Recorrentes Implícitos (~0.65) — mediana 90d, sem sessão criada
  4. Agenda Pendente      (~0.40) — scheduled/pre_agendado
  5. Pipeline             (~0.20) — leads + avaliações

Regra: nenhuma dessas camadas aparece no dashboard financeiro principal.
```

---

## 7. BACKLOG CONTRATADO

**Definição canônica:** Receita certa ainda não executada originada de **pacotes pagos**.
```
Backlog Contratado = Package[paid/partially_paid, active/in-progress]
                     → sessionsRemaining × sessionValue
```

### Implementações existentes

| # | Arquivo | Nome | Base | Observação |
|---|---------|------|------|------------|
| A | `totals.v2.js` | `packageCredit.deferredRevenue` | `PackagesView` aggregate | "Receita diferida" — semanticamente correto |
| B | `FinancialOverviewService.js` | `creditoPacotes` | `Package.find()` | "Crédito em pacotes" — perspectiva do cliente |
| C | `provisionamentoService.js` | dentro de `calcularGarantido()` | `Package.find(paid)` | Contexto de forecast — correto lá |
| D | `PackageProjectionService.js` | `sessionsRemaining`, `deferredRevenue` | Billing domain | Cálculo técnico, não exposto como KPI |

### ✅ SSOT aprovada
```
BACKLOG CONTRATADO = Package.sessionsRemaining × Package.sessionValue
  WHERE Package.financialStatus IN ['paid', 'partially_paid']
  AND Package.status IN ['active', 'in-progress']
  AND Package.type = 'therapy'  [particular — ver Backlog Autorizado para convênio]

Nome canônico: backlogContratado
A ser adicionado como campo dedicado na resposta do dashboard.
```

---

## 8. BACKLOG AUTORIZADO *(KPI novo — não implementado)*

**Definição canônica:** Receita autorizada ainda não executada originada de **guias de convênio**.
```
Backlog Autorizado = InsuranceGuide[active]
                     → remainingSessions × sessionValue
```

**Distinção crítica de Backlog Contratado:**
- Backlog Contratado (pacote): dinheiro já recebido, clínica deve sessões ao paciente
- Backlog Autorizado (guia): convênio autorizou sessões, clínica ainda não as realizou

| | Dinheiro recebido? | Sessão autorizada? | Sessão realizada? |
|--|--|--|--|
| **A Receber** | Não | Sim | **Sim** |
| **Backlog Contratado** | Sim | N/A | Não |
| **Backlog Autorizado** | Não | Sim | Não |

### ✅ SSOT proposta
```
BACKLOG AUTORIZADO = InsuranceGuide[status=active]
                     → remainingSessions × sessionValue (ou insuranceGrossAmount / totalSessions)

Nome canônico: backlogAutorizado
A implementar na rota de convênio, não no dashboard principal.
```

---

## 9. BACKLOG EXECUTÁVEL *(KPI novo — não implementado)*

**Definição canônica:** Subconjunto do Backlog Autorizado que ainda pode ser executado. Nem toda sessão autorizada é executável.

```
Backlog Executável = Backlog Autorizado − Sessões Não Executáveis
```

**Motivos de não-execução:**
- Guia com prazo de validade vencido
- Paciente com contato inativo / sem resposta nos últimos N dias
- Profissional que atende esse convênio desligado da clínica
- Agenda sem slots disponíveis nos próximos 30 dias

**Por que importa:** A diferença entre Backlog Autorizado e Backlog Executável é a **receita em risco de expiração** — dinheiro autorizado que a clínica pode perder por limitação operacional, não por vontade do paciente.

### ✅ SSOT proposta
```
BACKLOG EXECUTÁVEL = InsuranceGuide[active, não expirado]
  filtrado por: guia.expiresAt > hoje
               AND paciente teve contato nos últimos 60 dias (ou config)
               AND existe profissional ativo para o convênio

A implementar com lógica de "sinalização" — não bloquear, apenas classificar.
Expor como: backlogAutorizado.total − backlogNaoExecutavel.total = backlogExecutavel.total
```

---

## 10. CAPACIDADE COMPROMETIDA *(KPI novo — não implementado)*

**Definição canônica:** Visão clínica da agenda — quantas sessões a clínica precisa executar para cumprir os contratos ativos.
```
Capacidade Comprometida = Backlog Contratado (em sessões) + Backlog Autorizado (em sessões)
```

**Exemplo:**
```
850 sessões contratadas/autorizadas
↓
312 executadas este mês
↓
538 restantes = capacidade comprometida
```

**Por que importa:** Gestão clínica — agenda tem capacidade de absorver o backlog? Precisa abrir mais slots?

### ✅ SSOT proposta
```
CAPACIDADE COMPROMETIDA = {
  totalContratadas: sum(Package.sessionsRemaining) WHERE ativo
  totalAutorizadas: sum(InsuranceGuide.remainingSessions) WHERE ativo
  totalRestantes:   totalContratadas + totalAutorizadas
  executadasMes:    count(Session.completed) WHERE date no período
}

A implementar no módulo de gestão clínica / provisionamento.
Não pertence ao dashboard financeiro — pertence à visão operacional.
```

---

## 11. RECEITA EM RISCO *(KPI novo — não implementado)*

**Definição canônica:** Valor da agenda comprometida que pode não se realizar, por qualquer motivo de não-execução.
```
Receita em Risco = Agenda Pendente × Probabilidade de Não Execução
```

**Distinção de Provisionamento:**
- Provisionamento = estimativa otimista de **entrada** futura
- Receita em Risco = estimativa pessimista de **perda** futura

**Fontes de risco (não apenas cancelamento):**

| Fonte | Indicador | Base de cálculo |
|-------|-----------|-----------------|
| Cancelamento ativo | Taxa histórica de `operationalStatus = 'canceled'` | Últimos 90 dias |
| Falta / no-show | Taxa histórica de `operationalStatus = 'missed'` | Últimos 90 dias |
| Expiração de guia | Guia com `expiresAt < hoje + 30d` e sessões restantes | InsuranceGuide |
| Abandono de paciente | Paciente sem Appointment nos últimos 60 dias com pacote ativo | Package + Appointment |
| Inadimplência particular | Paciente com `PatientBalance.currentBalance > 0` e novo agendamento | PatientBalance |

**Exemplo:**
```
Agenda pendente no mês: R$ 12.000
  → risco cancelamento/falta (18%):   R$ 2.160
  → risco guias expirando  ( 5%):     R$   600
  → risco abandono         ( 8%):     R$   960
──────────────────────────────────────────────
Total Receita em Risco:               R$ 3.720  (31%)
```

### ✅ SSOT proposta
```
RECEITA EM RISCO = {
  agendaPendente:     sum(Appointment.sessionValue) WHERE scheduled/pre_agendado
  taxaNaoExecucao:    calculada por tipo de risco (histórico 90 dias)
  valorEmRisco:       agendaPendente × taxaNaoExecucao
  breakdown: {
    cancelamento: ...,
    falta: ...,
    guiaExpirando: ...,
    abandono: ...,
    inadimplencia: ...
  }
}

Expor como: "R$ X da agenda pendente tem risco de não se realizar"
A implementar no provisionamentoService como camada de risco.
```

---

## Mapa de divergências consolidado

| KPI | # Impl. | Conflito semântico? | Bug ativo? | Prioridade |
|-----|---------|---------------------|------------|------------|
| Caixa | 4 | Não | D sem filtro `isFromPackage` | P2 |
| Produção | 5 | Leve | F usa caixa como proxy | P2 |
| A Receber | 5 | **Sim — 3 semânticas** | **B: `createdAt` inflando total** | **P1*** |
| Pendentes | 4 | **Sim** | **A inclui sessões futuras** | **P1** |
| Receita Reconhecida | 3 | Leve — 3 nomes | alias `receitaProjetada` enganoso | P2 |
| Provisionamento | 8 | **Sim — H mal nomeada** | **H = A Receber com bug** | P1 |
| Backlog Contratado | 4 | Não (dado igual) | Ausente como KPI no dashboard | P2 |
| Backlog Autorizado | 0 | — | Não implementado | P2 |
| Capacidade Comprometida | 0 | — | Não implementado | P3 |
| Receita em Risco | 0 | — | Não implementado | P3 |

*P1 de A Receber está **bloqueado pela pergunta de negócio sobre guias** (ver `FINANCIAL_DOMAIN_INVARIANTS.md`).

---

## Sequência de implementação (revisada)

### Fase 0 — Aprovar as invariantes (sem código)
Validar `FINANCIAL_DOMAIN_INVARIANTS.md` com o time. Especialmente a resposta à pergunta sobre guias.

### P0 — Eliminar cálculos duplicados (sem mudar resultados)
1. `totals.v2.js`: substituir agregação de caixa inline por chamada a `unifiedFinancialService.calculateCash()`
2. `FinancialOverviewService.js`: separar `receita` (caixa) de `receitaReconhecida` (produção)
3. Renomear `receitaProjetada` → `receitaReconhecida` onde usado como alias

### P1 — Corrigir definições (muda resultado, requer validação)
4. `calculateAReceber()`: reescrever conforme resposta à pergunta de guias
5. `calculatePendentesEngine()`: propagar filtro `appointment.operationalStatus='completed'`

### P2 — Novos KPIs
6. Adicionar `backlogContratado` na resposta do dashboard
7. Implementar `backlogAutorizado` na rota de convênio
8. Migrar `Capacidade Comprometida` para visão operacional

### P3 — Evolução do provisionamento
9. Adicionar camada `recorrentesImplicitos` (mediana 90d)
10. Implementar `receitaEmRisco`
11. Revisar fatores de certeza com dados históricos reais

---

## Definições canônicas (referência rápida)

```
Caixa                = Payment.paid (financialDate no período)
Produção             = Session.completed × effectiveValue (date no período)
Receita Reconhecida  = Produção  [= Caixa + A Receber — identidade derivada]
A Receber            = max(0, Produção.X − Caixa.X) por categoria
Pendentes            = A Receber por paciente (listagem) ou = A Receber total (KPI)
Provisionamento      = estimativa futura ponderada por certeza (sistema separado)
Backlog Contratado   = Package.sessionsRemaining × sessionValue (pacotes pagos)
Backlog Autorizado   = InsuranceGuide.remainingSessions × sessionValue (guias ativas)
Capacidade Comprometida = Backlog total em sessões (volume clínico)
Receita em Risco     = Agenda pendente × taxa histórica de cancelamento
```
