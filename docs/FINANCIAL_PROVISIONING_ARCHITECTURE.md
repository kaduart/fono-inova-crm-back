# Arquitetura de Provisionamento Financeiro — CRM Clínica v8

> **Documento consolidado** — análise conceitual + auditoria arquitetural do dashboard financeiro.
> Última atualização: 2026-06-30
> Base: API `/api/v2/financial/dashboard?month=6&year=2026`

---

## 1. Contexto do Problema

O dashboard financeiro acumulou ao longo do tempo múltiplas formas de calcular "o que a clínica vai receber". Esse fenômeno é comum em sistemas que crescem por camadas: cada nova necessidade acrescentou um cálculo levemente diferente, sem eliminar o anterior.

O resultado são quatro campos no mesmo payload JSON que respondem perguntas parecidas mas não idênticas:

| Campo | Valor (Jun/2026) | O que foi calculado |
|---|---|---|
| `convenioAReceber` | R$ 7.100 | produção convênio − caixa convênio |
| `aReceberProducao` | R$ 9.200 | toda produção realizada − caixa |
| `pendentes.total` | R$ 9.310 | Payment docs pending (paymentDate/serviceDate) |
| `aReceber.total` | R$ 22.440 | Payment docs pending (inclui createdAt) |

A diferença entre R$9.200 e R$22.440 é o ponto central deste documento.

### Definições corretas antes de qualquer análise

| Conceito | Definição operacional |
|---|---|
| **Produção** | Trabalho efetivamente entregue. Source: `Session.status = 'completed'` |
| **Caixa** | Dinheiro que entrou no banco. Source: `Payment.status = 'paid'` |
| **A Receber (direito adquirido)** | Serviço entregue, pagamento ainda não recebido |
| **Provisionamento (agendado)** | Sessões futuras já cadastradas — ainda não entregues |
| **Provisionamento (esperado)** | Receita provável de pacientes recorrentes sem sessões criadas |

Direito adquirido e provisionamento são naturezas radicalmente diferentes. Misturá-los num único campo impede qualquer análise financeira séria.

---

## 2. Diagnóstico da Arquitetura Atual

### 2.1 `calculateRealTime()` — a camada correta

Localização: `back/routes/financialDashboard.v2.js`

```
calculateRealTime()
    └── unifiedFinancialService
            ├── calculateCashForDashboard(start, end)
            │       Payment.find({ status: 'paid' })
            │       → caixa = R$ 41.851
            │
            └── calculateProductionForDashboard(start, end)
                    Session.find({ status: 'completed' })
                    → producao = R$ 45.766

    ↓ deriva (aritmética pura):

    convenioAReceber   = max(0, producao.convenio − caixa.convenio)
                       = max(0, 7180 − 80) = 7.100

    aReceberProducao   = convenioAReceber + particularPendente + liminarAReceber
                       = 7.100 + 1.640 + 460 = 9.200

    receitaReconhecida = caixa + aReceberProducao
                       = 41.851 + 9.200 = 51.051
```

**Avaliação:** Semanticamente correto. `aReceberProducao` só conta o que foi efetivamente produzido. A meta engine usa este caminho.

---

### 2.2 `calculateAReceber()` — a camada problemática

Localização: `back/routes/financialDashboard.v2.js`, linha ~1612

```js
Payment.find({
    status: 'pending',
    billingType: 'convenio',   // só convênio
    $or: [
        { paymentDate:  { $gte: startStr, $lte: endStr } },
        { serviceDate:  { $gte: startStr, $lte: endStr } },
        { createdAt:    { $gte: startDate, $lte: endDate } }  // ← problema principal
    ]
})
```

**Problemas identificados:**

1. **Filtro `createdAt`**: qualquer Payment doc *criado* em junho entra no cálculo, mesmo que a sessão seja em agosto. Isso inclui guias inteiras lançadas antecipadamente.
2. **Sem join com Session**: não verifica `session.status === 'completed'`. Um payment pending para uma sessão futura é tratado igual a um payment de sessão já entregue.
3. **Só convênio**: exclui particulares e liminares, tornando o campo incompatível com `aReceberProducao`.

**Resultado:** `aReceber.total = 22.440`, sendo ~R$7.100 direito adquirido e ~R$15.340 expectativa futura misturados.

---

### 2.3 `calculatePendentesEngine()` — melhor, mas com o mesmo problema raiz

Localização: `back/services/financialEngine.js`

```js
// É um wrapper de calculateFinancialSnapshot com:
Payment.find({
    status: ['pending', 'partial'],
    kind: { $ne: 'package_consumed' },
    $or: [paymentDate, serviceDate]   // não usa createdAt ← melhoria
})
```

**Diferenças em relação a `calculateAReceber`:**
- Inclui todos os billingTypes (convenio + particular)
- Não usa `createdAt` como filtro — mais honesto
- Inclui `partial` além de `pending`

**Problema persistente:** Ainda não faz join com Session para verificar `session.status === 'completed'`. Pagamentos de sessões futuras entram.

**Nota:** O filtro correto já existe no mesmo arquivo, na função `getPatientPendingPayments` (usada no modal por paciente):

```js
// ✅ lógica correta, mas só para view individual
const items = allItems.filter(p =>
    !p.appointment ||
    p.appointment.operationalStatus === 'completed' ||
    p.appointment.clinicalStatus === 'completed'
);
```

Essa lógica nunca foi propagada para os totais do dashboard.

---

### 2.4 `/api/provisionamento` — sistema paralelo e independente

Localização: `back/routes/provisionamento.js` + `back/services/provisionamentoService.js`

```
calcularProvisionamento(mes, ano)
    ├── calcularGarantido()          → sessions/payments já completados
    ├── calcularAgendadoConfirmado() → appointments confirmed × 0.85
    ├── calcularAgendadoPendente()   → appointments pending × 0.40
    ├── calcularConvenioAgendado()   → appointments convênio agendados
    └── calcularPipeline()           → leads em negociação
```

**Avaliação:** Conceitualmente o sistema mais robusto — tem coeficientes de certeza, break-even, analytics por especialidade. Mas está **completamente desconectado** do dashboard financeiro principal. O `FinancialDashboardTab` não consome este endpoint; o `ProvisionamentoTab` é uma aba separada.

**Gap crítico:** Este sistema só cobre o que já está *cadastrado*. Não existe hoje estimativa de receita de pacientes recorrentes que ainda não têm sessões criadas para o mês corrente.

---

## 3. Problemas Encontrados

### 3.1 Mistura de "direito adquirido" com "expectativa futura"

```
aReceber.total = 22.440
    ├── ~7.100 = sessão completed + payment pending  → DIREITO ADQUIRIDO
    └── ~15.340 = sessão futura + payment provisionado → PREVISÃO
```

São conceitos juridicamente e financeiramente distintos. Não devem estar no mesmo campo.

### 3.2 Três pares de campos quase duplicados

| Par | Campo A | Campo B | Diferença |
|---|---|---|---|
| Convênio a receber | `convenioAReceber` = 7.100 | `pendentes.convenio.total` = 7.520 | produção−caixa vs Payment docs |
| A receber total | `aReceberProducao` = 9.200 | `pendentes.total` = 9.310 | produção−caixa vs Payment docs |
| A receber geral | `aReceberProducao` = 9.200 | `aReceber.total` = 22.440 | produção−caixa vs Payment+futuros |

### 3.3 Dois sistemas de provisionamento sem integração

O dashboard financeiro tem seu próprio mini-provisionamento (`aReceber`, `aReceberProducao`). O `/api/provisionamento` tem um sistema completo com camadas. Nenhum dos dois conversa com o outro.

### 3.4 Violação da definição de "Contas a Receber"

No padrão ERPs hospitalares (Tasy, MV, sistemas TISS), **Contas a Receber só existe após o faturamento** — serviço entregue e guia/nota emitida. Usar `Payment.status = 'pending'` como proxy para AR viola isso porque o Payment pode ser criado antes da sessão acontecer.

### 3.5 Gap do início do mês

Nos primeiros dias do mês, pacientes recorrentes ainda não têm sessões criadas. O dashboard mostra `producao = 0` e `provisionamento = 0`, quando na realidade a clínica tem uma carteira ativa com receita altamente previsível.

---

## 4. Mapa de Dependências

### 4.1 Backend

```
unifiedFinancialService.v2.js
    ↓ alimenta
calculateRealTime()
    ↓ produz
    caixa, producao, convenioAReceber, aReceberProducao,
    receitaReconhecida, recebimentosAntecipados
    ↓ alimenta
calculateMetas()           ← usa aReceberProducao (CORRETO)
    ↓ produz
    percentualRealizado, projecaoFinal, statusMeta

financialEngine.js
    ↓ calculatePendentesEngine()
    ↓ produz
    pendentes.total, pendentes.byPatient, pendentes.vencidos.items

financialDashboard.v2.js
    ↓ calculateAReceber() (INDEPENDENTE — não usa unifiedFinancialService)
    ↓ produz
    aReceber.total (22.440) ← campo problemático

provisionamentoService.js  (SISTEMA SEPARADO)
    ↓ produz
    camadas: garantido, agendadoConfirmado, agendadoPendente, pipeline
    ↓ consumido por
    ProvisionamentoTab.tsx  (aba separada do dashboard)
```

### 4.2 Frontend — quem usa o quê

| Campo | Componente | Como é usado |
|---|---|---|
| `convenioAReceber` | `FinancialDashboardTab` | Chip "aguarda repasse" no card de produção; alerta se > 20% |
| `aReceberProducao` | `FinancialDashboardTab` | KPI "A Receber" + base de cálculo da meta |
| `pendentes.vencidos.items` | `FinancialDashboardTab` | Lista detalhada de devedores por paciente |
| `pendentes.total` | `FinancialDashboardTab` | Card secundário + cálculo `debitosMesAnterior` |
| `receitaReconhecida` | `FinancialDashboardTab` | Card "Receita Reconhecida" = caixa + aReceberProducao |
| `aReceber.total` | Declarado nos tipos | **Não drive nenhum KPI principal** — dado de apoio |
| `/api/provisionamento` | `ProvisionamentoTab` | Aba separada — camadas de certeza, break-even |

**Conclusão do mapa:** `aReceber.total` não está sendo usado de forma proeminente. A meta engine já usa o campo correto (`aReceberProducao`). A principal mudança necessária é semântica, não estrutural.

---

## 5. Proposta Arquitetural

### 5.1 Os quatro conceitos que devem existir

```
Receita do Mês
│
├── 1. PRODUÇÃO (regime de competência)
│       Sessions.status = 'completed'
│       → quanto foi entregue
│       → imutável após completado
│
├── 2. CAIXA (regime de caixa)
│       Payment.status = 'paid'
│       → quanto entrou no banco
│
├── 3. A RECEBER (direito adquirido)
│       Sessions.completed + Payment.pending
│       → serviço entregue, pagamento pendente
│       → é uma dívida contratual da clínica com o paciente/convênio
│
└── 4. PROVISIONAMENTO (probabilístico)
        ├── 4a. Agendado confirmado × 0.85
        ├── 4b. Agendado pendente × 0.40
        ├── 4c. Recorrentes implícitos × 0.65 (NOVO)
        └── 4d. Pipeline de leads × 0.20
```

### 5.2 O que cada campo atual vira

| Campo atual | Status | Destino |
|---|---|---|
| `caixa` | ✅ Correto | Mantém |
| `producao` | ✅ Correto | Mantém |
| `convenioAReceber` | ✅ Correto | Mantém como sub-item de "A Receber" |
| `aReceberProducao` | ✅ Correto | Renomear para `aReceber.realizado` ou manter |
| `receitaReconhecida` | ✅ Correto (= caixa + aReceberProducao) | Mantém |
| `pendentes.items` | ✅ Uso legítimo | Mantém — é o breakdown detalhado por paciente |
| `pendentes.total` | ⚠️ Ligeiramente errado | Corrigir: filtrar por session.completed |
| `aReceber.total` | ❌ Conceitualmente errado | Corrigir ou deprecar — substituir por `aReceberProducao` |
| `/api/provisionamento` | ✅ Mais rico, mas isolado | Integrar ao dashboard principal ou expor via resumo |

### 5.3 Resposta para o gap do início do mês

A camada `recorrentesImplicitos` resolve o problema descrito:

**Lógica de negócio:**
```
Para cada paciente com sessões completed nos últimos 60 dias:
    1. Calcular frequência média (sessões/semana)
    2. Estimar sessões para o mês corrente = frequência × semanas restantes
    3. Subtrair sessões já cadastradas no mês (appointments/sessions existentes)
    4. Estimar valor = sessões_faltantes × ticket_médio_histórico
    5. Aplicar coeficiente de certeza 0.65
```

**Fontes de dados disponíveis:**
- `Session.find({ date: { $gte: 60 dias atrás }, status: 'completed' })` → histórico
- `Package` com `sessionsRemaining > 0` → direito contratual (certeza ~0.90)
- `InsuranceGuide` com `remainingSessions > 0` → autorização ativa (certeza ~0.85)
- `Appointment.find({ date: mês_corrente })` → o que já foi criado

**Onde implementar:** `provisionamentoService.js`, nova função `calcularRecorrentesImplicitos(periodo)`.

---

## 6. Nova Visão de Provisionamento

O dashboard passaria a responder dois tipos de perguntas:

**Pergunta 1 — "O que já aconteceu?"** (determinístico)
```
Produção:    R$ 45.766  (sessões entregues)
Recebido:    R$ 41.851  (dinheiro no banco)
A Receber:   R$  7.100  (entregue, não pago — CONV.)
             R$  1.640  (entregue, não pago — PART.)
             R$  9.200  total
```

**Pergunta 2 — "O que provavelmente vai acontecer?"** (probabilístico)
```
Provisionamento do mês
│
├── Agendado confirmado:   R$ X.XXX  (certeza 85%)
├── Agendado pendente:     R$ X.XXX  (certeza 40%)
├── Pacotes ativos:        R$ X.XXX  (certeza 90%)
├── Guias ativas:          R$ X.XXX  (certeza 85%)
└── Recorrentes implícitos: R$ X.XXX (certeza 65%)

Total estimado:           R$ XX.XXX
Receita esperada mínima:  R$ XX.XXX  (só camadas > 70%)
```

**Visão consolidada no dia 1º do mês:**
```
Produção realizada    R$     0    (nada foi feito ainda)
A Receber             R$ 9.200    (carregado do mês anterior)
Receita projetada     R$ 48.000   (carteira ativa × histórico)
                                  ← este número existe hoje, no dia 1
```

O gestor deixa de ver `R$0` no início do mês e passa a ver uma estimativa baseada na carteira real da clínica.

---

## 7. Plano de Refatoração

### 7.1 O que remover ou corrigir

| Item | Ação | Risco |
|---|---|---|
| `calculateAReceber()` — filtro `createdAt` | Remover `createdAt` da query; adicionar join com Session | Baixo — `aReceber.total` não drive KPI principal |
| `aReceber.total` como campo standalone | Substituir por `aReceberProducao` (já correto) | Baixo — verificar se ProvisionamentoTab consome |
| Duplicidade `pendentes.total` / `aReceberProducao` | Manter `pendentes` para o breakdown por paciente; deprecar como KPI total | Médio |

### 7.2 O que manter

- `caixa`, `producao`, `convenioAReceber`, `aReceberProducao`, `receitaReconhecida` — corretos, sem tocar
- `pendentes.vencidos.items` — usado para listagem detalhada por paciente, continua necessário
- `calculateMetas()` — usa `aReceberProducao`, não precisa mudança
- `/api/provisionamento` — manter o endpoint, adicionar a nova camada

### 7.3 O que construir

**Fase 1 — Correção (baixo risco, alto impacto semântico):**
1. Corrigir `calculateAReceber`: remover filtro `createdAt`, adicionar verificação `session.completed`
2. Expor `aReceber.realizado` no payload como renomeação de `aReceberProducao`
3. Documentar no contrato de API a distinção entre "direito adquirido" e "provisionamento"

**Fase 2 — Nova camada de recorrência:**
1. Implementar `calcularRecorrentesImplicitos(periodo)` em `provisionamentoService.js`
2. Adicionar ao retorno de `/api/provisionamento` como nova camada com `certeza: 0.65`
3. Expor um resumo desta camada no `financialDashboard.v2.js` como `provisionamentoEsperado`
4. Validar `Package.sessionsRemaining` e `InsuranceGuide.remainingSessions` antes de usar

**Fase 3 — Integração (opcional, maior refatoração):**
1. Fazer o dashboard financeiro consumir `/api/provisionamento` para a visão de futuro
2. Eliminar os mini-cálculos de provisionamento dentro de `financialDashboard.v2.js`
3. Single Source of Truth: `unifiedFinancialService` para passado/presente, `provisionamentoService` para futuro

### 7.4 Invariantes que não podem quebrar durante a refatoração

1. `calculateMetas()` depende de `aReceberProducao` — não alterar esta derivação
2. `pendentes.vencidos.items` é usado para listagem por paciente — não remover o breakdown
3. `convenioAReceber` é exibido em card proeminente no `FinancialDashboardTab` — não renomear sem atualizar o frontend
4. `receitaReconhecida = caixa + aReceberProducao` — equação deve se manter

---

## Resumo Executivo

O dashboard financeiro tem **uma camada correta** (`calculateRealTime` → `aReceberProducao`) e **uma camada ruidosa** (`calculateAReceber` → `aReceber.total`), convivendo com um **sistema de provisionamento separado** (`/api/provisionamento`) que nunca foi integrado.

A meta engine já usa o cálculo correto. O principal problema é de nomenclatura e exposição: `aReceber.total` induz a leituras erradas porque mistura R$7.100 de direito adquirido com R$15.340 de expectativa futura.

O gap estratégico é a ausência de uma camada de **recorrência implícita** — pacientes ativos que provavelmente farão sessões mas ainda não têm nada agendado. Essa camada transforma o dashboard de "relatório do passado" para "ferramenta de previsão financeira".

As peças já existem no sistema. O que falta é organização, conexão e uma nova função de R$3-4 horas de desenvolvimento.
