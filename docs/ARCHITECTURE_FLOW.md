# ARCHITECTURE FLOW — CRM Clínica v8
## Contrato mental do sistema. Leia antes de qualquer implementação.

> **Regra zero:** qualquer agente (humano ou IA) que tocar neste sistema DEVE ler este arquivo primeiro.  
> Se você não leu, parou. Se leu e ignorou, quebrou produção.

---

## 1. DOMÍNIOS E ENTIDADES CORE

```
Patient ────────────────────────────────────┐
   │                                         │
   ├── Appointment (agendamento)             │
   │       └── Session (sessão clínica)      │
   │       └── Payment (financeiro)          │
   │                                         │
   ├── Package (pacote de sessões)           │
   │       └── Session (consumida)           │
   │       └── Payment (venda do pacote)     │
   │                                         │
   └── Lead → [converte em Patient]          │
         └── Followup                        │
                                             │
Doctor ──────────────────────────────────────┘
   └── Comissão (calculada por sessão)
```

---

## 2. CICLOS DE VIDA

### Appointment
```
pre_agendado → scheduled → confirmed → completed
                                    ↘ cancelled
                                    ↘ force_cancelled  (admin apenas)
```
- **`pre_agendado`** = nasce SEMPRE assim desde 2026-05-07
- **`scheduled`** = secretária marcou no calendário
- **`confirmed`** = confirmação manual pela secretária
- **`completed`** = sessão realizada → dispara settlement financeiro
- **`cancelled`** = libera slot automaticamente
- **`force_cancelled`** = admin com reversal financeiro opcional (audit log obrigatório)

> ⚠️ Todos os filtros de agendamentos ativos DEVEM incluir `pre_agendado` além de `scheduled/confirmed`

### Session
```
scheduled → completed
         ↘ cancelled
```
- Criada JUNTO com Appointment (trinca)
- `completed` apenas quando Appointment é `completed`
- Sessão de pacote: baixa só no `completed`, nunca no agendamento

### Payment
```
pending → paid
       ↘ partial
       ↘ consumed  (pacote pago e consumido — downgrade automático de paid)
       ↘ recognized (convênio/liminar reconhecido)
```
- **Provisioning**: `pending` nasce no agendamento
- **Settlement**: `paid` ocorre no `completed` do Appointment
- Sempre usar `paymentStatusService.transitionPaymentStatus()` — NUNCA update direto

### Package
```
unpaid → partially_paid → paid
```
- `financialStatus` calculado automaticamente no pre-save
- Sessão de pacote só é consumida no `completed`
- Tipos: `therapy` (particular) | `convenio` (plano) | `liminar` (judicial)
- paymentType: `full` | `per-session` | `installment`

### Lead
```
novo → atendimento → convertido
              ↘ perdido
```
- Conversão gera Patient
- Bloco `operational` para camada secretária (desde 2026-05-21)

---

## 3. FLUXOS PRINCIPAIS

### FLUXO 1 — Agendamento Particular

```
1. POST /api/appointments
   → cria: Appointment (pre_agendado)
   → cria: Session (scheduled)
   → cria: Payment (pending, kind=appointment_payment)
   → NÃO exige pagamento na criação

2. Secretária confirma
   → PATCH /api/appointments/:id  { status: confirmed }
   → Appointment.status = confirmed

3. Sessão realizada
   → POST /api/appointments/:id/complete
   → Appointment.status = completed
   → Session.status = completed
   → paymentStatusService.transitionPaymentStatus(paymentId, 'paid')
      → emite PAYMENT_STATUS_CHANGED
      → unifiedFinancialService calcula caixa/produção

4. Cancelamento (se ocorrer)
   → POST /api/appointments/:id/cancel
   → Appointment.status = cancelled
   → Slot liberado automaticamente
   → Payment revertido se necessário
```

### FLUXO 2 — Agendamento com Pacote

```
1. Venda do pacote
   → POST /api/packages
   → Package criado (financialStatus=unpaid ou paid, dependendo de paymentType)
   → Payment de venda: kind=package_receipt, status=paid (se full)

2. Agendamento vinculado ao pacote
   → POST /api/appointments { packageId }
   → Appointment + Session + Payment(kind=package_consumed) criados
   → Payment.isFromPackage = true → NÃO entra em caixa

3. Sessão realizada
   → /complete
   → Session.status = completed
   → Package.sessionsUsed += 1
   → Payment.status = consumed (package_consumed)
   → Package.financialStatus recalculado no pre-save

4. Regra de valuation (hierarquia):
   1. package.sessionValue
   2. package.totalValue / package.totalSessions
   3. session.sessionValue
   4. 0 (fallback de segurança)
   → Implementado em: utils/resolveSessionFinancialValue.js
```

### FLUXO 3 — Convênio (Insurance)

```
1. Agendamento com billingType=convenio
   → Appointment + Session + Payment (pending, billingType=convenio) criados

2. Sessão realizada
   → /complete
   → Session.status = completed
   → Payment permanece pending (aguarda repasse da seguradora)

3A. Faturamento em lote (Batch)
   → insuranceBatchService.createBatch([paymentIds])
   → insuranceBatchService.processReturn(batchId)
   → transitionPaymentStatus(paymentId, 'paid')

3B. Faturamento avulso (sem lote)
   → autoInsuranceSettlementService.settleInsurancePayment(paymentId)
   → transitionPaymentStatus(paymentId, 'paid')

4. DRE
   → unifiedFinancialService.v2.js lê Payment.status='paid', billingType='convenio'
   → entra em produção, NÃO entra em caixa particular
```

### FLUXO 4 — Cancelamento com Reversal Financeiro

```
Nível 1: admin-edit (seguro)
   → Edição simples via AppointmentModal
   → Sem impacto financeiro

Nível 2: forceCancel + reverseFinancial=false
   → status = force_cancelled
   → audit log obrigatório
   → financeiro permanece como está

Nível 3: forceCancel + reverseFinancial=true  ← CRÍTICO
   → status = force_cancelled
   → Payment revertido: paid → pending
   → audit log obrigatório
   → unifiedFinancialService recomputa métricas
```

### FLUXO 5 — Amanda (WhatsApp Bot)

```
Mensagem recebida
   → detectAllFlags()        ← classifica intenção e contexto
   → BusinessRulesAdapter()  ← aplica regras do negócio
   → DecisionResolver()      ← RULE | HYBRID | AI
   → ResponseBuilder()       ← monta resposta

DecisionResolver modos:
   RULE  → resposta determinística por regra
   HYBRID → regra + contexto AI
   AI    → GPT com contexto completo

INVARIANTE: nunca disparar mensagem sem validação de contexto
```

### FLUXO 6 — Regime de Competência Financeira

```
PRODUÇÃO (competência clínica)
   = Sessões completed no período
   → data: appointment.date ?? session.date
   → fonte: Session (status=completed)

CAIXA (competência financeira)
   = Pagamentos recebidos no período
   → data: payment.financialDate ?? payment.paymentDate
   → fonte: Payment (status=paid, isFromPackage≠true)

A RECEBER
   = Produção realizada sem payment.status=paid
   → fonte: ReconciliationService

PROJEÇÃO (futuro)
   = Appointments scheduled/confirmed ainda não completados
   → PaymentPage usa Appointment como projeção financeira virtual
   → NUNCA misturar com caixa real
```

---

## 4. RESPONSABILIDADES DOS SERVIÇOS

| Serviço | Responsabilidade | NÃO faz |
|---------|-----------------|---------|
| `paymentStatusService.js` | ÚNICA fonte de mudança de Payment.status | Nunca calcular valor |
| `unifiedFinancialService.v2.js` | Produção + Caixa + A Receber (leitura) | Nunca mudar status |
| `resolveSessionFinancialValue.js` | Valuation de sessão (hierarquia) | Nunca salvar |
| `insuranceBatchService.js` | Lote de convênio + processReturn | Settlement avulso |
| `autoInsuranceSettlementService.js` | Settlement avulso de convênio | Lote |
| `commissionRule.service.js` | Comissão por sessão (cálculo) | Gerar Expense |
| `commissionService.js` | Comissão mensal do profissional | Cálculo por sessão |
| `ProfessionalFinancialService` | Resultado financeiro do profissional | Settlement histórico |
| `ProfessionalSettlementService` | Fechamento histórico congelado | Resultados em aberto |
| `ReconciliationService` | Auditoria + divergências + A Receber | Nenhum write |
| `syncAffectedViews` | Sincroniza views após mutation | Nenhum cálculo |

---

## 5. HIERARQUIA DE CÁLCULO FINANCEIRO

```
Session.status = completed
       ↓
resolveSessionFinancialValue()  →  valor unitário da sessão
       ↓
paymentStatusService.transitionPaymentStatus()  →  emite PAYMENT_STATUS_CHANGED
       ↓
unifiedFinancialService.v2.js   →  Produção / Caixa / A Receber (geral)
       ↓
commissionRule.service.js       →  Comissão por sessão
       ↓
commissionService.js            →  Comissão mensal do profissional
       ↓
ProfessionalFinancialService    →  Resultado do profissional
       ↓
ProfessionalSettlementService   →  Fechamento histórico congelado
       ↓
ReconciliationService           →  Auditoria e divergências
```

---

## 6. INVARIANTES — NUNCA PODEM QUEBRAR

1. **Trinca obrigatória**: todo Appointment cria Session + Payment junto
2. **Status inicial**: todo Appointment nasce como `pre_agendado`
3. **Filtros ativos**: sempre incluir `pre_agendado` além de `scheduled/confirmed`
4. **Payment.status**: nunca alterar diretamente no Mongo — sempre via `transitionPaymentStatus()`
5. **Sessão de pacote**: `payment.isFromPackage = true` → NUNCA entra em caixa
6. **nextAppointment**: nunca salvo manualmente — sempre calculado como virtual
7. **Cancelamento**: libera slot automaticamente
8. **KPIs financeiros**: computados APENAS no backend — nunca no frontend
9. **Amanda**: nunca dispara mensagem sem validação de contexto (`detectAllFlags` primeiro)
10. **GMB images**: usar apenas `sanitizePermanentMedia` — sem fallbacks Unsplash/Pollinations
11. **Comissão**: não usar `Session.commissionValue` — sempre via `commissionRule.service.js`

---

## 7. PROIBIDO — ANTI-PATTERNS QUE QUEBRAM O SISTEMA

```js
// ❌ NUNCA — atualização direta de Payment.status
await Payment.findByIdAndUpdate(id, { status: 'paid' });

// ✅ SEMPRE
await transitionPaymentStatus(id, 'paid', { reason: 'manual', userId });

// ❌ NUNCA — pacote_consumed entra em caixa
if (payment.isFromPackage) countAsCaixa(); // ERRADO

// ✅ SEMPRE — defesa em profundidade
{ isFromPackage: { $ne: true }, kind: { $ne: 'package_consumed' } }

// ❌ NUNCA — calcular KPI no frontend
const total = appointments.reduce((sum, a) => sum + a.amount, 0);

// ✅ SEMPRE — consumir do backend
const { caixa } = await fetch('/api/v2/financial/dashboard');

// ❌ NUNCA — criar Payment avulso sem idempotência
await new Payment({ appointmentId }).save(); // pode duplicar

// ✅ SEMPRE — verificar existência antes
const existing = await Payment.findOne({ appointmentId, kind });
if (!existing) await new Payment(...).save();

// ❌ NUNCA — usar FinancialProjection, TotalsSnapshot, FinancialDailySnapshot
// Todos DEPRECATED — sem novos consumidores

// ❌ NUNCA — calcular DRE fora do pipeline de payments
// DRE só lê — nunca escreve ou calcula fora dos services oficiais
```

---

## 8. MAPA DE ENDPOINTS CRÍTICOS

| Ação | Endpoint | Quem chama |
|------|----------|-----------|
| Criar agendamento | `POST /api/appointments` | Frontend |
| Completar sessão | `POST /api/appointments/:id/complete` | Frontend |
| Cancelar | `POST /api/appointments/:id/cancel` | Frontend |
| Force cancel | `POST /api/appointments/:id/force-cancel` | Admin |
| Dashboard financeiro | `GET /api/v2/financial/dashboard` | Frontend |
| Caixa | `GET /api/v2/cashflow` | Frontend |
| Resultado profissional | `GET /api/v2/professionals/:id/summary` | Frontend |
| Reconciliação | `GET /api/internal/financial/reconciliation/issues` | Admin |
| Settlement convênio avulso | `autoInsuranceSettlementService` | Interno |
| Batch convênio | `insuranceBatchService` | Admin |

---

## 9. MAPA DE DATAS — QUAL CAMPO USAR

| Propósito | Campo oficial | Fallback |
|-----------|--------------|---------|
| Caixa / DRE | `payment.financialDate` | `payment.paymentDate` |
| Competência clínica | `appointment.date` | `session.date` |
| Auditoria operacional | `payment.paidAt` | — |
| Auditoria técnica | `payment.createdAt` | — |

---

## 10. PAYMENT.KIND — REFERÊNCIA RÁPIDA

| kind | Entra em caixa? | Descrição |
|------|----------------|-----------|
| `package_receipt` | ✅ Sim | Venda de pacote |
| `session_payment` | ✅ Sim | Sessão avulsa paga |
| `appointment_payment` | ✅ Sim | Pagamento vinculado a agendamento |
| `revenue_recognition` | ✅ Sim | Reconhecimento liminar/pacote |
| `package_consumed` | ❌ Nunca | Consumo de sessão de pacote |
| `monthly_settlement` | ✅ Sim | Fechamento mensal |
| `debt_settlement` | ✅ Sim | Quitação de dívida |

---

## 11. O QUE NÃO USAR MAIS (DEPRECATED)

| Não usar | Substituto |
|----------|-----------|
| `FinancialProjection` | `unifiedFinancialService.v2.js` |
| `TotalsSnapshot` | `unifiedFinancialService.v2.js` |
| `FinancialDailySnapshot` | `unifiedFinancialService.v2.js` |
| `financialMetrics.service.js` | `unifiedFinancialService.v2.js` |
| `routes/financial/cashflow.js` | `/api/v2/cashflow` |
| `routes/financial/dashboard.routes.js` | `/api/v2/financial/dashboard` |
| `Session.commissionValue` | `commissionRule.service.js` |
| `Appointment` como base financeira | `Session` é a unidade financeira |
| `Package` como base de produção | `resolveSessionFinancialValue()` |

---

## 12. HEADER OBRIGATÓRIO NOS SERVICES CRÍTICOS

Todo service que toca financeiro ou appointment deve ter:

```js
/**
 * FLOW REFERENCE: back/docs/ARCHITECTURE_FLOW.md
 * Domínio: [Payment | Appointment | Package | Session | Insurance]
 * Fluxo: [ex: "Fluxo 1 — Agendamento Particular > step 3"]
 */
```

---

## Changelog

| Data | Mudança |
|------|---------|
| 2026-06-19 | Criação — consolidação de todos os fluxos do sistema |
