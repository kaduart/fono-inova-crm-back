# 📋 REGRAS DE NEGÓCIO CONSOLIDADAS

> **Sistema:** CRM Clínica v8  
> **Módulos:** Appointment, Session, Payment, Package  
> **Última atualização:** 2025-04-01

---

## 🎯 RESUMO EXECUTIVO

```
┌─────────────────────────────────────────────────────────────────┐
│  FLUXO DE VIDA DE UM ATENDIMENTO                                │
├─────────────────────────────────────────────────────────────────┤
│  1. CRIAÇÃO → Cria Appointment + Session (+ Payment se aplica) │
│  2. AGENDAMENTO → Status: scheduled/pending                    │
│  3. CONFIRMAÇÃO → Status: confirmed (sem pagamento)            │
│  4. COMPLETE → AQUI A MÁGICA ACONTECE!                         │
│     - Atualiza Session → completed                             │
│     - Consome pacote (se houver)                               │
│     - Cria/atualiza Payment (depende do tipo)                  │
│     - Reconhece receita (liminar)                              │
│     - Consome guia (convênio)                                  │
│  5. CANCELAMENTO → Reversão controlada                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📦 PACKAGE (Pacote)

### Tipos de Pacote

| Tipo | Descrição | Campo `type` |
|------|-----------|--------------|
| **Therapy** | Particular pré-pago | `'therapy'` |
| **Convênio** | Plano de saúde | `'convenio'` |
| **Liminar** | Judicial | `'liminar'` |

### Tipos de Pagamento do Pacote

| Tipo | Descrição | Campo `paymentType` |
|------|-----------|---------------------|
| **À vista** | Pago integral no início | `'full'` ou `null` |
| **Por sessão** | Paga conforme usa | `'per-session'` |
| **Parcelado** | Entrada + parcelas | `'installment'` |

### Status Financeiro do Pacote

```javascript
// Calculado automaticamente no pre-save
if (totalPaid === 0)              → 'unpaid'
if (totalPaid < totalValue)       → 'partially_paid'  
if (totalPaid >= totalValue)      → 'paid'
```

### Campos Importantes

```javascript
{
  totalSessions: Number,        // Total de sessões contratadas
  sessionsDone: Number,         // Sessões já realizadas (completed)
  totalPaid: Number,            // Valor total já pago
  totalValue: Number,           // Valor total do pacote (FIXO)
  balance: Number,              // totalValue - totalPaid (calculado)
  paidSessions: Number,         // Sessões quitadas (pode ser fracionado)
  financialStatus: String,      // unpaid | partially_paid | paid
  
  // Convênio
  insuranceGuide: ObjectId,     // Guia vinculada
  insuranceProvider: String,    // Nome do convênio
  
  // Liminar
  liminarProcessNumber: String,
  liminarCreditBalance: Number,
  recognizedRevenue: Number     // Receita já reconhecida
}
```

### Regra de Consumo de Crédito

```
Sessão é consumida (sessionsDone++) SOMENTE quando:
- Session.status muda para 'completed'
- E appointment.clinicalStatus !== 'completed' (idempotência)
```

---

## 📅 APPOINTMENT (Agendamento)

### Status Operacional

| Status | Descrição | Transições |
|--------|-----------|------------|
| `pre_agendado` | Interesse, sem horário fixo | → scheduled |
| `scheduled` | Agendado, aguardando | → confirmed, canceled |
| `pending` | Pendente de confirmação | → confirmed, canceled |
| `confirmed` | Confirmado/pago | → completed |
| `paid` | Pago (sinônimo de confirmed) | → completed |
| `canceled` | Cancelado | (final) |
| `missed` | Faltou | (final) |

### Status Clínico

| Status | Descrição |
|--------|-----------|
| `pending` | Aguardando atendimento |
| `in_progress` | Em atendimento |
| `completed` | Atendimento concluído |
| `missed` | Paciente faltou |

### Status de Pagamento

| Status | Quando Usar |
|--------|-------------|
| `pending` | Aguardando pagamento |
| `paid` | Pago integral |
| `partial` | Pago parcialmente |
| `canceled` | Cancelado |
| `advanced` | Pagamento antecipado |
| `package_paid` | Pago via crédito de pacote |
| `pending_receipt` | Convênio - aguardando recebimento |

---

## 🎫 SESSION (Sessão)

### Status

| Status | Significado | Consome Pacote? | Gera Comissão? |
|--------|-------------|-----------------|----------------|
| `scheduled` | Agendada | ❌ Não | ❌ Não |
| `pending` | Pendente | ❌ Não | ❌ Não |
| `completed` | Concluída | ✅ Sim | ✅ Sim |
| `canceled` | Cancelada | ❌ Não (estorna) | ❌ Não |

### Campos Financeiros

```javascript
{
  isPaid: Boolean,              // Sessão está paga?
  paymentStatus: String,        // paid | partial | pending | pending_receipt
  partialAmount: Number,        // Valor pago parcialmente
  paymentMethod: String,        // dinheiro | pix | cartão | convenio | liminar_credit
  
  // Flags de controle
  sessionConsumed: Boolean,     // Consome do pacote/saldo?
  guideConsumed: Boolean,       // Guia de convênio já consumida?
  
  // Campos para cancelamento (preservam histórico)
  originalPartialAmount: Number,
  originalPaymentStatus: String,
  originalPaymentMethod: String,
  originalIsPaid: Boolean,
  
  // Rastreabilidade
  paymentOrigin: String,        // auto_per_session | manual_balance | package_prepaid | convenio | liminar | individual
  correlationId: String,        // ID de rastreamento
  
  // Comissão
  commissionRate: Number,       // % de comissão (ex: 0.5 = 50%)
  commissionValue: Number       // Valor calculado
}
```

### Visual Flag (UI)

| Flag | Significado | Cor |
|------|-------------|-----|
| `ok` | Tudo certo | 🟢 Verde |
| `pending` | Atenção/Pendente | 🟡 Amarelo |
| `blocked` | Bloqueado/Não pode | 🔴 Vermelho |

---

## 💰 PAYMENT (Pagamento)

### Status

| Status | Descrição |
|--------|-----------|
| `pending` | Pendente |
| `paid` | Pago/Confirmado |
| `partial` | Pago parcialmente |
| `canceled` | Cancelado |

### Tipos (kind)

| Tipo | Descrição |
|------|-----------|
| `package_receipt` | Recibo de pacote |
| `session_payment` | Pagamento de sessão avulsa |
| `manual` | Lançamento manual |
| `auto` | Gerado automaticamente |
| `revenue_recognition` | Reconhecimento de receita (liminar) |

### Billing Type

| Tipo | Descrição |
|------|-----------|
| `particular` | Pagamento direto |
| `convenio` | Plano de saúde |

---

## 🔥 FLUXOS DETALHADOS

### 1️⃣ FLUXO: Particular Avulso (Sem Pacote)

```
CRIAÇÃO (POST /appointments)
├── Cria Appointment
│   ├── operationalStatus: 'scheduled'
│   ├── clinicalStatus: 'pending'
│   ├── paymentStatus: 'pending'
│   └── sessionValue: <valor>
│
├── Cria Session
│   ├── status: 'scheduled'
│   ├── isPaid: false
│   ├── paymentStatus: 'pending'
│   └── visualFlag: 'pending'
│
└── Cria Payment
    ├── status: 'pending'
    ├── kind: 'manual' | 'auto'
    └── billingType: 'particular'

COMPLETE (PATCH /:id/complete)
├── Session → status: 'completed'
│   ├── isPaid: true
│   ├── paymentStatus: 'paid'
│   ├── visualFlag: 'ok'
│   └── paymentOrigin: 'auto_per_session'
│
├── Appointment → operationalStatus: 'confirmed'
│   ├── clinicalStatus: 'completed'
│   ├── paymentStatus: 'paid'
│   └── visualFlag: 'ok'
│
└── Payment → status: 'paid' (confirma)
```

### 2️⃣ FLUXO: Pacote Therapy (Pré-pago)

```
CRIAÇÃO com amount <= 0 (usa crédito)
├── Cria Appointment
│   ├── package: <packageId>
│   ├── serviceType: 'package_session'
│   └── paymentStatus: 'package_paid'
│
├── Cria Session
│   ├── status: 'scheduled'
│   ├── isPaid: true          // Já pago pelo pacote!
│   ├── paymentStatus: 'paid' // ou 'package_paid'
│   ├── visualFlag: 'ok'
│   └── paymentOrigin: 'package_prepaid'
│
└── NÃO cria Payment (usa crédito existente)

COMPLETE
├── Session → status: 'completed'
│   ├── sessionConsumed: true
│   └── commission calculada
│
├── Package → sessionsDone++ (incrementa)
│
└── Appointment → operationalStatus: 'confirmed'
```

### 3️⃣ FLUXO: Pacote Per-Session (Paga por sessão)

```
CRIAÇÃO com amount <= 0
├── Igual ao Therapy (acima)
└── NÃO cria Payment no agendamento

COMPLETE
├── Cria Payment (FORA da transação!)
│   ├── amount: package.sessionValue
│   ├── status: 'pending' (inicial)
│   ├── kind: 'session_payment'
│   └── paymentOrigin: 'auto_per_session'
│
├── Package
│   ├── totalPaid += amount
│   ├── paidSessions++
│   ├── balance = totalValue - totalPaid
│   └── financialStatus: recalculado
│
├── Session → status: 'completed'
│   ├── isPaid: true
│   ├── paymentStatus: 'paid'
│   └── paymentId: <novoPayment>
│
└── Payment → status: 'paid' (após commit)
```

### 4️⃣ FLUXO: Pacote Convênio

```
CRIAÇÃO
├── Cria Appointment
│   ├── package: <packageId>
│   ├── billingType: 'convenio'
│   └── insuranceGuide: <guideId>
│
├── Cria Session
│   ├── isPaid: false
│   ├── paymentStatus: 'pending'
│   └── visualFlag: 'pending'
│
└── NÃO cria Payment (fatura depois)

COMPLETE
├── Session → status: 'completed'
│   ├── paymentStatus: 'pending_receipt'
│   └── visualFlag: 'pending'
│
├── Consome Guia de Convênio
│   ├── guide.usedSessions++
│   └── Se esgotou: guide.status = 'exhausted'
│
├── Cria Payment (pós-commit)
│   ├── billingType: 'convenio'
│   ├── status: 'pending'
│   ├── insuranceProvider: <nome>
│   ├── insuranceValue: <valorConvenio>
│   └── kind: 'manual'
│
└── Appointment → paymentStatus: 'pending_receipt'
```

### 5️⃣ FLUXO: Pacote Liminar (Judicial)

```
CRIAÇÃO
├── Similar ao Therapy
└── package.type = 'liminar'

COMPLETE
├── Session → status: 'completed'
│
├── Reconhece Receita
│   ├── package.liminarCreditBalance -= sessionValue
│   ├── package.recognizedRevenue += sessionValue
│   └── package.totalPaid += sessionValue
│
└── Cria Payment
    ├── status: 'paid'
    ├── kind: 'revenue_recognition'
    ├── paymentMethod: 'liminar_credit'
    ├── billingType: 'particular'
    └── notes: "Receita reconhecida - Processo: XXX"
```

### 6️⃣ FLUXO: Fiado (Add to Balance)

```
COMPLETE com addToBalance=true
├── Session → status: 'completed'
│   ├── isPaid: false
│   ├── paymentStatus: 'pending'
│   ├── visualFlag: 'pending'
│   └── addedToBalance: true
│
├── PatientBalance.addDebit()
│   ├── currentBalance += amount
│   └── transactions: [{ type: 'debit', amount, ... }]
│
└── Appointment
    ├── paymentStatus: 'pending'
    ├── visualFlag: 'pending'
    ├── addedToBalance: true
    └── balanceAmount: <valor>
```

### 7️⃣ FLUXO: Cancelamento

```
CANCEL (PATCH /:id/cancel)
├── Appointment
│   ├── operationalStatus: 'canceled'
│   ├── clinicalStatus: 'missed' (se confirmedAbsence) ou 'pending'
│   └── paymentStatus: 'canceled'
│
├── Session
│   ├── status: 'canceled'
│   ├── paymentStatus: 'canceled'
│   ├── visualFlag: 'blocked'
│   └── SE estava paga:
│       ├── originalPartialAmount = partialAmount
│       ├── originalPaymentStatus = paymentStatus
│       ├── originalPaymentMethod = paymentMethod
│       └── originalIsPaid = isPaid
│
└── Payment (se não for de pacote)
    └── status: 'canceled'

REAGENDAMENTO (reaproveitamento)
├── Busca sessão cancelada paga
│   └── canceledPaidSession = Session.findOne({
│         package: packageId,
│         status: 'canceled',
│         $or: [
│           { originalPaymentStatus: { $exists: true } },
│           { originalIsPaid: true }
│         ]
│       })
│
└── Nova Sessão
    ├── isPaid: true (do crédito reaproveitado)
    ├── partialAmount: canceledPaidSession.originalPartialAmount
    └── Zera campos "original" da sessão antiga
```

---

## ⚙️ REGRAS DE IDEMPOTÊNCIA

### Complete

```javascript
// Guard 1: Já adicionou ao saldo
if (addToBalance && appointment.addedToBalance === true) {
  return; // Não duplica
}

// Guard 2: Já foi completado
if (!addToBalance && 
    appointment.operationalStatus === 'confirmed' && 
    appointment.clinicalStatus === 'completed') {
  return; // Não duplica
}

// Guard 3: Só incrementa pacote se não estava completed
const shouldIncrementPackage = 
  appointment.package && 
  appointment.clinicalStatus !== 'completed';
```

### Consumo de Guia Convênio

```javascript
// Hook post-findOneAndUpdate na Session
if (doc.guideConsumed) return; // Já consumiu
if (doc.status !== 'completed') return; // Só consome se completed
// ... consome guia
```

---

## 🔄 TRANSAÇÕES E CONSISTÊNCIA

### Estratégia do Complete Otimizado

```
FASE 1: BUSCA (fora da transação)
  → Busca appointment com populate
  → Valida guards de idempotência

FASE 2: TRANSAÇÃO MÍNIMA
  → Updates apenas (sem creates pesados)
  → Cria Payment fora se necessário
  → Commit

FASE 2.5: CONFIRMAÇÃO (após commit)
  → Atualiza Payment: pending → paid
  → Se falhar: log crítico (inconsistência)

FASE 3: PÓS-COMMIT (fire-and-forget)
  → Reconhece receita liminar
  → Consome guia convênio
  → Atualiza saldo devedor
  → Audit trail
  → Sync externo
```

### Compensação (Rollback)

```javascript
// Se transação falhar após criar Payment
try {
  await Payment.updateOne(
    { _id: perSessionPayment._id },
    { 
      status: 'canceled',
      cancellationReason: 'transaction_rollback',
      canceledAt: new Date()
    }
  );
} catch (compensateErr) {
  // 🚨 Log crítico - Payment inconsistente!
}
```

---

## 🎨 VISUAL FLAG - LÓGICA DE EXIBIÇÃO

### Appointment

| Condição | visualFlag |
|----------|------------|
| paymentStatus === 'paid' | 'ok' |
| paymentStatus === 'package_paid' | 'ok' |
| paymentStatus === 'pending' | 'pending' |
| paymentStatus === 'pending_receipt' | 'pending' |
| operationalStatus === 'canceled' | 'blocked' |

### Session

| Condição | visualFlag |
|----------|------------|
| isPaid === true | 'ok' |
| paymentStatus === 'paid' | 'ok' |
| paymentStatus === 'package_paid' | 'ok' |
| paymentStatus === 'pending' | 'pending' |
| paymentStatus === 'pending_receipt' | 'pending' |
| status === 'canceled' | 'blocked' |

---

## 🧮 CÁLCULO DE COMISSÃO

```javascript
// Na Session quando status muda para 'completed'
if (status === 'completed') {
  sessionConsumed = true;
  
  if (commissionRate && sessionValue) {
    commissionValue = sessionValue * commissionRate;
  }
  
  revenueRecognizedAt = new Date();
}

// Reversão (completed → canceled)
if (oldStatus === 'completed' && newStatus === 'canceled') {
  sessionConsumed = false;
  commissionValue = 0;
  // NÃO zera revenueRecognizedAt (histórico)
}
```

---

## 📊 MATRIZ DE DECISÃO - COMPLETE

| Tipo | addToBalance | Cria Payment? | Session isPaid | Package Increment |
|------|--------------|---------------|----------------|-------------------|
| Particular | false | ✅ Sim (se não existir) | true | N/A |
| Particular | true | ❌ Não | false | N/A |
| Pacote Therapy | false | ❌ Não | true | ✅ Sim |
| Pacote Per-Session | false | ✅ Sim | true | ✅ Sim (paga) |
| Pacote Convênio | false | ✅ Sim (convenio) | false | ✅ Sim |
| Pacote Liminar | false | ✅ Sim (revenue) | true | ✅ Sim |

---

## 🚨 EDGE CASES E RESTRIÇÕES

### 1. Pacote Esgotado
```javascript
// Se sessionsDone >= totalSessions
// Fluxo continua, mas pode criar Payment avulso
// ou bloquear (depende da regra de negócio)
```

### 2. Guia Convênio Esgotada
```javascript
// Se guide.usedSessions >= guide.totalSessions
// guide.status = 'exhausted'
// Próximo complete vai falhar ou criar Payment particular
```

### 3. Liminar sem Crédito
```javascript
// Se liminarCreditBalance < sessionValue
// Pode: bloquear, criar Payment particular, ou alertar
```

### 4. Reagendamento de Cancelado
```javascript
// Sessão cancelada preserva dados em 'original*'
// Nova sessão pode reaproveitar esses dados
// Idempotência: só reaproveita se tiver crédito
```

---

## 🔗 RELACIONAMENTOS

```
Appointment
├── patient → Patient
├── doctor → Doctor
├── session → Session (1:1)
├── package → Package (N:1)
├── payment → Payment (1:1)
└── insuranceGuide → InsuranceGuide

Session
├── patient → Patient
├── doctor → Doctor
├── package → Package
├── appointmentId → Appointment
└── paymentId → Payment

Payment
├── patient → Patient
├── doctor → Doctor
├── appointment → Appointment
├── session → Session
└── package → Package

Package
├── patient → Patient
├── doctor → Doctor
├── sessions → [Session]
├── appointments → [Appointment]
└── payments → [Payment]
```

---

## 📝 CHECKLIST DE IMPLEMENTAÇÃO

### Ao criar Appointment:
- [ ] Criar Appointment com status apropriado
- [ ] Criar Session vinculada
- [ ] Criar Payment SOMENTE se:
  - Particular com amount > 0
  - Pacote com amount > 0 (está pagando)
- [ ] NÃO criar Payment se:
  - Pacote pré-pago (usa crédito)
  - Convênio (fatura depois)

### Ao completar:
- [ ] Verificar guards de idempotência
- [ ] Atualizar Session → completed
- [ ] Se pacote: incrementar sessionsDone
- [ ] Se per-session: criar Payment
- [ ] Se convênio: consumir guia
- [ ] Se liminar: reconhecer receita
- [ ] Se addToBalance: adicionar débito
- [ ] Confirmar Payment (fora da transação)
- [ ] Audit trail

### Ao cancelar:
- [ ] Preservar dados financeiros em 'original*'
- [ ] Marcar como 'canceled'
- [ ] NÃO deletar Payment (auditoria)
- [ ] Reverter sessionConsumed se necessário

---

## 💡 DICAS DE DEBUG

```javascript
// Log estruturado para tracing
console.log(`[complete] correlationId: ${correlationId}`, {
  appointmentId,
  patientId,
  packageId,
  addToBalance,
  timestamp: new Date().toISOString()
});

// Verificar estado antes de operar
console.log(`[complete] Estado atual:`, {
  operationalStatus: appointment.operationalStatus,
  clinicalStatus: appointment.clinicalStatus,
  paymentStatus: appointment.paymentStatus,
  hasPackage: !!appointment.package,
  hasPayment: !!appointment.payment
});
```

---

**Fim do documento**
