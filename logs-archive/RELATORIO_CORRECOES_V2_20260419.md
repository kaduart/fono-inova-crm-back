# Relatório de Correções V2 — Dashboard Financeiro
**Data:** 2026-04-19  
**Auditor:** Kimi Code CLI  
**Foco:** V2 apenas (ignorado V1/legado)  

---

## 1. O QUE FOI ENCONTRADO (AUDITORIA)

### 1.1 Bug Crítico: Date Type Mismatch (ISODate vs String)
**Impacto:** Múltiplas queries no V2 retornavam **ZERO resultados** porque comparavam strings `YYYY-MM-DD` contra campos `ISODate` no MongoDB.

**Campos afetados:**
- `Session.date` → `ISODate` (Date object)
- `Appointment.date` → `ISODate` (Date object)
- `Payment.paymentDate` → `String` (`YYYY-MM-DD`)
- `Payment.serviceDate` → `String` (`YYYY-MM-DD`)

**Regra:** No MongoDB, `db.sessions.find({ date: { $gte: "2026-03-01" } })` contra ISODate retorna **vazio**. Silencioso. Sem erro.

---

### 1.2 Arquivos com o Bug

#### A) `services/financial/ConvenioMetricsService.js`
- `_getPeriodDates()` → retornava strings (`start="2026-03-01"`, `end="2026-03-31"`)
- `_getSessoesRealizadas(start, end)` → usava essas strings contra `Session.date` (ISODate) → **0 sessões**
- `_getSessoesAgendadas(start, end)` → mesma coisa
- `_getProvisaoConvenio()` → `ultimoDiaMes` era string contra `Session.date`
- `_getProvisaoAgendadas()` → `primeiroDiaMesSeguinte` era string contra `Session.date`

**Resultado:** Todo o cálculo de "Receita Realizada" de convênio estava vindo **zerado**.

#### B) `routes/financialDashboard.v2.js`
- Endpoint `POST /rebuild-snapshot` → `startDate`/`endDate` vindos do `req.body` (strings) eram usados direto contra `Session.date`
- `calculatePendentes()` → `p.appointment?.date` é ISODate. Ao fazer `p.appointment?.date || ...`, o Date object passava para a variável `dataRef`. Na comparação `dataRef >= startStr`, o JS fazia `toString()` do Date → `"Wed Mar 30 2026..."`, que **nunca** comparava corretamente com `"2026-03-01"`.
- `calculateAReceber()` → tinha **dois `$or` no mesmo nível do objeto query**. Em JavaScript, o segundo `$or` sobrescrevia o primeiro. Então o filtro de datas funcionava, mas o filtro de tipo (convenio) era ignorado.

#### C) `services/financialEngine.js`
- `calculateFinancialSnapshot()` → `new Date(startDate)` contra `paymentDate` (string). Funcionava por acidente em alguns casos, mas não é confiável.
- **Bug grave:** quando `patientId` era passado, a linha `query.$or = [...]` **sobrescrevia** o `$or` das datas. Resultado: filtro de paciente funcionava, mas filtro de data era perdido.

---

### 1.3 Problema de Dados: V2 NÃO Cria Payment para Convênio
**Arquivo:** `services/completeSessionService.v2.js` (linha 195-201)

Quando o V2 completa uma sessão de convênio:
```javascript
sessionUpdate.isPaid = true;
sessionUpdate.paymentStatus = 'paid';
sessionUpdate.paymentOrigin = 'convenio';
```

**Mas NÃO cria um documento `Payment`.**

**Consequência:**
- 27 das 32 sessões de convênio de março/2026 **não têm Payment vinculado**
- O dashboard V2 calcula "a receber" baseado no modelo `Payment`
- Sessões de convênio ficam "invisíveis" para o cálculo de pending_billing do V2
- O valor fica subcontado

**Particular é diferente:** O V2 cria Payment `paid` para particular (linha 276-338). O problema do particular são payments `pending` órfãos do V1 que não foram reutilizados.

---

### 1.4 Resumo dos Dados de Março/2026 (Banco Real)

| Tipo | Sessões Completed | Com Payment | Sem Payment | Valor Sessions |
|------|-------------------|-------------|-------------|----------------|
| Convênio | 32 | 5 | 27 | R$ 2.160 (muitas com sessionValue=0) |
| Particular | 113 | 113 (todos têm) | 0 | R$ 17.050 |

**Payments Particular Pending (março):** 15 payments = R$ 1.825,97  
**Payments Convênio Pending:** 16 payments = R$ 1.700  
**Payments Convênio Pending_Billing:** 21 payments = R$ 2.100  

---

## 2. O QUE FOI CORRIGIDO

### 2.1 `services/financial/ConvenioMetricsService.js`
**5 alterações:**

1. **`_getPeriodDates()`** (linha 458~)
   - Antes: retornava `{ start: "2026-03-01", end: "2026-03-31" }`
   - Depois: retorna `{ start: Date, end: Date, startStr: "...", endStr: "..." }`
   - `start` e `end` agora são objetos `Date` com timezone `America/Sao_Paulo`

2. **`_getSessoesRealizadas(start, end)`** (linha 141~)
   - Antes: `date: { $gte: start, $lte: end }` (string vs ISODate)
   - Depois: converte `start`/`end` para Date antes da query
   - ```js
     const startDate = start instanceof Date ? start : moment.tz(start, TIMEZONE).startOf('day').toDate();
     const endDate = end instanceof Date ? end : moment.tz(end, TIMEZONE).endOf('day').toDate();
     ```

3. **`_getSessoesAgendadas(start, end)`** (linha 163~)
   - Mesma correção de conversão Date

4. **`_getProvisaoConvenio()`** (linha 220~)
   - Antes: `date: { $lte: ultimoDiaMes }` (string)
   - Depois: `const ultimoDiaDate = moment.tz(ultimoDiaMes, TIMEZONE).endOf('day').toDate();`

5. **`_getProvisaoAgendadas()`** (linha 287~)
   - Antes: `date: { $gte: primeiroDiaMesSeguinte }` (string)
   - Depois: `const primeiroDiaDate = moment.tz(primeiroDiaMesSeguinte, TIMEZONE).startOf('day').toDate();`

---

### 2.2 `routes/financialDashboard.v2.js`
**3 alterações:**

1. **`POST /rebuild-snapshot`** (linha 307~)
   - Antes: `Session.find({ date: { $gte: startDate, $lte: endDate } })` → strings do req.body
   - Depois:
     ```js
     const startDateObj = moment.tz(startDate, TIMEZONE).startOf('day').toDate();
     const endDateObj = moment.tz(endDate, TIMEZONE).endOf('day').toDate();
     Session.find({ date: { $gte: startDateObj, $lte: endDateObj } })
     ```

2. **`calculateAReceber(year, month)`** (linha 976~)
   - Antes: dois `$or` no mesmo nível → segundo sobrescrevia o primeiro
   - Depois: envolvido em `$and` com dois `$or` internos
     ```js
     $and: [
       { $or: [ /* filtros de tipo: convenio */ ] },
       { $or: [ /* filtros de data */ ] }
     ]
     ```

3. **`calculatePendentes(year, month)`** (linha 1368~)
   - Antes:
     ```js
     const dataRef = p.appointment?.date || (p.paymentDate ? moment(...).format(...) : null) || ...;
     ```
     Quando `p.appointment?.date` existia (ISODate), o `||` retornava o Date object. A comparação `dataRef >= startStr` falhava silenciosamente.
   - Depois:
     ```js
     let dataRef = null;
     if (p.appointment?.date) {
         dataRef = moment(p.appointment.date).format('YYYY-MM-DD');
     } else if (p.paymentDate) {
         dataRef = moment(p.paymentDate).format('YYYY-MM-DD');
     } else if (p.serviceDate) {
         dataRef = moment(p.serviceDate).format('YYYY-MM-DD');
     }
     ```

---

### 2.3 `services/financialEngine.js`
**1 alteração:**

- **`calculateFinancialSnapshot()`** (linha 55~)
  - Antes: `query.$or` das datas era **sobrescrito** por `query.$or` do patientId
  - Antes: `new Date(startDate)` contra campo string → comportamento imprevisível
  - Depois: usa `$and` para combinar condições sem sobrescrição
    ```js
    const andConditions = [];
    if (dateConditions.length > 0) andConditions.push({ $or: dateConditions });
    if (patientConditions.length > 0) andConditions.push({ $or: patientConditions });
    if (andConditions.length > 0) {
        query.$and = andConditions;
        delete query.$or;
    }
    ```
  - Depois: usa strings puras (`startDate`/`endDate`) contra `paymentDate`/`serviceDate` (que são strings no DB)

---

## 3. O QUE AINDA ESTÁ QUEBRADO / PENDENTE

### 3.1 V2 Não Cria Payment para Convênio
**Arquivo:** `services/completeSessionService.v2.js`

- Quando completa sessão de convênio, marca `isPaid: true` na Session mas **não gera Payment**
- Isso deixa 27 sessões de março/2026 sem documento Payment
- O dashboard V2 não consegue calcular corretamente o "a receber" de convênio

**Sugestão de correção:** No bloco `else if (billingType === 'convenio')`, adicionar criação de Payment com:
```javascript
status: 'pending',
billingType: 'convenio',
'insurance.status': 'pending_billing',
amount: sessionValue,
session: sessionId,
appointment: appointmentId
```

### 3.2 Session Value = 0 para Convênio
**Banco:** 27 das 32 sessões de convênio de março têm `sessionValue: 0` ou ausente

- O `package.insuranceGrossAmount` também está 0 para todas
- Isso faz o `_calcularAReceber()` ignorar a sessão (`if (valor === 0) continue`)
- Mesmo que a query agora funcione, o cálculo de valor vai continuar zerado

**Sugestão:** O cálculo deve buscar o valor do `Payment` vinculado (se existir) ou de uma tabela de preços de convênio.

### 3.3 Payments Particular Órfãos do V1
**Dados:** 15 payments `pending` de março/2026 (total R$ 1.825,97)

- Esses payments foram criados pelo V1 quando o agendamento foi criado
- O V2, ao completar a sessão, pode criar um **novo** Payment `paid` em vez de reutilizar o existente
- Isso deixa o payment original `pending` para sempre

**Sugestão:** Script de reconciliação para encontrar payments `pending` cuja sessão já está `isPaid: true` e corrigir.

### 3.4 `_calcularAReceber()` Simplificado Demais
**Arquivo:** `ConvenioMetricsService.js` linha 393

```javascript
_calcularAReceber(sessoes) {
    for (const sessao of sessoes) {
        if (sessao.isPaid === true) continue;
        const status = 'pending_billing';  // ← SEMPRE pending_billing
        ...
    }
}
```

- Não verifica se há Payment com `insurance.status: 'billed'`
- Não verifica `insurance.status: 'partial'`
- Toda sessão não paga é classificada como `pending_billing`, mesmo que já tenha sido faturada

### 3.5 `calculatePendentes()` Ineficiente
**Arquivo:** `financialDashboard.v2.js`

- Carrega **TODOS** os 281 payments `pending` do banco para memória
- Filtra em JavaScript
- Funciona, mas não escala

**Sugestão:** Mover o filtro para a query do MongoDB com `$and` + `$or` de datas.

---

## 4. COMO TESTAR AS CORREÇÕES

### 4.1 ConvenioMetricsService
```bash
curl "http://localhost:5000/api/financial/dashboard?month=3&year=2026"
```
Verificar se `receitaRealizada.total` agora mostra valor > 0 (antes vinha 0).

### 4.2 Dashboard V3 Pendentes
```bash
curl "http://localhost:5000/v2/financial/dashboard?month=3&year=2026"
```
Verificar se:
- `pendentes.particular.total` continua R$ 1.825 (dados reais)
- `pendentes.convenio.total` mostra os payments existentes
- Não há erro de comparação de datas no console

### 4.3 Rebuild Snapshot
```bash
curl -X POST "http://localhost:5000/v2/financial/dashboard/rebuild-snapshot" \
  -H "Content-Type: application/json" \
  -d '{"startDate":"2026-03-01","endDate":"2026-03-31"}'
```
Verificar se agora processa as sessions (antes retornava 0 sessions por causa do string vs ISODate).

---

## 5. ARQUIVOS MODIFICADOS

```
back/services/financial/ConvenioMetricsService.js   (+25 linhas)
back/routes/financialDashboard.v2.js                (+42 linhas)
back/services/financialEngine.js                     (+36 linhas)
```

**Total:** +103 linhas em 3 arquivos.

---

## 6. PRÓXIMOS PASSOS RECOMENDADOS

1. **Deploy das correções** e monitorar logs do dashboard
2. **Corrigir `completeSessionService.v2.js`** para criar Payment ao completar convênio
3. **Script de reconciliação:** alinhar payments `pending` órfãos do V1 com sessões já pagas
4. **Popular `sessionValue`** nas sessões de convênio (ou buscar de outra fonte)
5. **Refatorar `calculatePendentes()`** para filtrar no MongoDB em vez de carregar tudo
