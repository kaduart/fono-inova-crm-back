# 🏦 ESTUDO DE MIGRAÇÃO: BD Legado → V2

## ⚠️ PREOCUPAÇÃO PRINCIPAL

> O banco legado tem informações que hoje podemos não ter mais
> Precisamos alinhar ANTES de alimentar a partir de agora

---

## 📊 ANÁLISE DOS MODELOS

### 1. PAYMENT (Legado vs V2)

#### Legado (Payment.js atual)
```javascript
{
  // Identificação
  _id: ObjectId,
  
  // Vínculos (legado mistura tudo)
  patient: ObjectId,
  doctor: ObjectId,
  session: ObjectId,           // ← pode ser null
  appointment: ObjectId,       // ← pode ser null
  package: ObjectId,           // ← pode ser null
  
  // Valores (confusão conceitual)
  amount: Number,              // ← às vezes é valor pago, às vezes valor da sessão
  sessionValue: Number,        // ← duplicado?
  
  // Status (muitos valores inconsistentes)
  status: String,              // 'paid', 'pending', 'partial', 'canceled', 'package_paid'...
  paymentStatus: String,       // ← redundante?
  
  // Método (mistura pacote com particular)
  paymentMethod: String,       // 'dinheiro', 'pix', 'cartao', 'convenio', 'package'
  billingType: String,         // ← novo campo, nem todos têm
  
  // Convênio (estrutura antiga)
  insurance: {
    provider: String,
    grossAmount: Number,
    status: String             // 'pending_billing', 'billed', 'received'
  }
  
  // Datas (inconsistência de timezone)
  paymentDate: String|Date,    // ← às vezes string "2024-01-15", às vezes Date
  createdAt: Date,
  paidAt: Date                 // ← nem sempre preenchido
}
```

#### V2 Esperado
```javascript
{
  // Identificação
  _id: ObjectId,
  
  // Vínculos (claros)
  patient: ObjectId,
  professional: ObjectId,      // ← nome mudou: doctor → professional
  
  // Se for PARTICULAR
  session: ObjectId,           // ← preenchido
  appointment: ObjectId,       // ← preenchido
  
  // Se for CONVÊNIO
  billingType: 'convenio',
  insurance: {
    provider: String,
    insuranceProvider: ObjectId,  // ← referência nova
    guideNumber: String,
    grossAmount: Number,
    status: 'pending_billing'|'billed'|'received'
  },
  
  // Se for PACOTE
  billingType: 'convenio',     // ← pacote de convênio
  OR
  billingType: 'particular',   // ← pacote particular (não existe ainda!)
  
  // Valores (semântica clara)
  amount: Number,              // ← valor efetivo (caixa ou produção)
  
  // Status (state machine)
  status: 'pending'|'partial'|'paid'|'canceled'  // ← caixa
  insurance.status: 'pending_billing'|'billed'|'received'  // ← produção convênio
  
  // Método (apenas para particular)
  paymentMethod: 'dinheiro'|'pix'|'cartao'  // ← null se convênio
  
  // Datas (sempre ISO)
  paymentDate: String,         // ← "YYYY-MM-DD"
  createdAt: Date,
  paidAt: Date
}
```

#### 🚨 GAPS ENCONTRADOS

| Campo Legado | Situação V2 | Impacto |
|--------------|-------------|---------|
| `paymentMethod: 'package'` | ❌ Não existe em V2 | Pacotes não têm método de pagamento, são pre-paid |
| `status: 'package_paid'` | ❌ Não existe | Usar `billingType: 'convenio'` + `status: 'paid'` |
| `sessionValue` | ⚠️ Ambíguo | No V2, calcular proporcional do pacote |
| `doctor` | 🔄 Renomeado | Mudou para `professional` |
| `insurance` sem `billingType` | ⚠️ Incompleto | Precisa adicionar `billingType: 'convenio'` |
| `paymentDate` como Date | ⚠️ Inconsistente | V2 espera string "YYYY-MM-DD" |

---

### 2. PACKAGE (Legado vs V2)

#### Legado (Package.js)
```javascript
{
  _id: ObjectId,
  patient: ObjectId,
  doctor: ObjectId,
  
  // Configuração
  totalSessions: Number,
  sessionsDone: Number,        // ← incrementado manualmente?
  
  // Financeiro (conflito com Payment)
  totalValue: Number,
  totalPaid: Number,
  balance: Number,             // ← calculado: totalValue - totalPaid
  sessionValue: Number,        // ← calculado: totalValue / totalSessions
  
  // Status financeiro
  financialStatus: 'unpaid'|'partially_paid'|'paid',
  
  // Tipo (novo campo, nem todos têm)
  type: 'therapy'|'convenio'|'liminar',
  
  // Campos de convênio (opcionais)
  insuranceGuide: ObjectId,
  insuranceProvider: String,
  insuranceGrossAmount: Number,
  
  // Referências
  sessions: [ObjectId],
  appointments: [ObjectId]
}
```

#### V2 Esperado (via PackagesView)
```javascript
{
  packageId: ObjectId,
  patientId: ObjectId,
  doctorId: ObjectId,
  
  type: 'therapy'|'convenio'|'liminar',
  status: 'active'|'finished'|'canceled',
  
  // Métricas de sessões
  totalSessions: Number,
  sessionsUsed: Number,        // ← calculated from appointments completed
  sessionsRemaining: Number,   // ← virtual: total - used - canceled
  sessionsCanceled: Number,
  
  // Financeiro (fonte de verdade: Payment)
  totalValue: Number,          // ← contractedRevenue
  totalPaid: Number,           // ← cashReceived
  balance: Number,             // ← remaining to pay
  sessionValue: Number,        // ← proporcional para recognizedRevenue
  
  // CQRS
  recognizedRevenue: Number,   // ← sessionsUsed * sessionValue
  deferredRevenue: Number      // ← sessionsRemaining * sessionValue
}
```

#### 🚨 GAPS ENCONTRADOS

| Problema | Descrição | Solução |
|----------|-----------|---------|
| `sessionsDone` vs Appointments | Legado usa contador manual | V2 calcula de `appointments.completed` |
| Pagamento parcelado | Legado permite `totalPaid < totalValue` | V2 aceita, mas precisa rastrear parcelas |
| Pacotes sem `type` | Campo é novo | Migrar: se tem `insuranceGuide` → `convenio`, senão → `therapy` |
| Sessões canceladas | Legado não rastreia bem | Adicionar `sessionsCanceled` |

---

### 3. SESSION (Legado vs V2)

#### Legado
```javascript
{
  _id: ObjectId,
  patient: ObjectId,
  doctor: ObjectId,
  package: ObjectId,           // ← pode ser null
  
  status: 'scheduled'|'completed'|'canceled',
  
  // Pagamento (duplicado com Payment!)
  isPaid: Boolean,
  paymentStatus: 'pending'|'paid'|'package_paid',
  paymentMethod: String,
  paymentOrigin: String,
  
  // Convênio
  insuranceGuide: ObjectId,
  insuranceProcessed: Boolean
}
```

#### V2 Esperado
```javascript
{
  _id: ObjectId,
  patient: ObjectId,
  professional: ObjectId,
  package: ObjectId,           // ← se null, é particular avulso
  
  status: 'scheduled'|'completed'|'canceled',
  
  // V2: NÃO duplicar financeiro aqui
  // Fonte de verdade é Payment
  
  // Apenas flag para processamento
  insuranceBillingProcessed: Boolean,
  billingBatchId: ObjectId     // ← NOVO: para evitar duplicar faturamento
}
```

#### 🚨 GAPS ENCONTRADOS

| Problema | Descrição |
|----------|-----------|
| `isPaid` duplicado | Session e Payment dizem coisas diferentes |
| `paymentStatus` | Deve vir de Payment, não de Session |
| `sessionValue` | Deve ser proporcional do pacote |

---

### 4. APPOINTMENT (Legado vs V2)

#### Legado
```javascript
{
  _id: ObjectId,
  patient: ObjectId,
  doctor: ObjectId,
  package: ObjectId,
  
  // Status (muitos!)
  status: String,                    // 'scheduled', 'confirmed', 'completed'
  operationalStatus: String,         // 'scheduled', 'confirmed', 'canceled', 'completed'
  clinicalStatus: String,            // 'pending', 'completed'
  paymentStatus: String,             // 'pending', 'paid', 'billed'
  visualFlag: String,                // 'pending', 'ok', 'attention'
  
  // Convênio
  billingType: 'convenio',
  insuranceProvider: String,
  insuranceValue: Number,
  
  // Vínculo com sessão
  session: ObjectId                  // ← NOVO em V2
}
```

#### V2 Esperado
```javascript
{
  _id: ObjectId,
  patient: ObjectId,
  professional: ObjectId,
  
  // Status simplificado
  operationalStatus: 'scheduled'|'confirmed'|'canceled',
  clinicalStatus: 'pending'|'completed',
  
  // Fonte de verdade para "produção realizada"
  operationalStatus === 'completed' → conta como sessão realizada
  
  // Vínculos
  session: ObjectId,                 // ← preenchido quando session é criada
  package: ObjectId,
  
  // Convênio
  billingType: 'convenio',
  insurance: {
    status: 'pending_billing'|'billed'|'received'
  }
}
```

#### 🚨 GAPS ENCONTRADOS

| Problema | Descrição |
|----------|-----------|
| Muitos status | `status`, `operationalStatus`, `clinicalStatus`, `paymentStatus` | 
| Fonte de verdade | Qual define se "foi atendido"? |
| Vínculo Session | Nem sempre preenchido |

---

## 🎯 DECISÕES CRÍTICAS NECESSÁRIAS

### 1. COMO DEFINIR "PRODUÇÃO REALIZADA"?

Opções:
- A) `Session.status === 'completed'`
- B) `Appointment.operationalStatus === 'completed'`
- C) `Payment.status === 'paid'` (particular) ou `Payment.insurance.status !== 'pending_billing'` (convênio)
- D) Evento `SESSION_COMPLETED` processado

**✅ Recomendação V2: B + verificação de Payment**

```javascript
// Produção = Appointment completado + Payment criado
const production = await Payment.find({
  $or: [
    { status: 'paid' },                    // Particular pago
    { 'insurance.status': { $in: ['pending_billing', 'billed', 'received'] } }  // Convênio
  ]
});
```

### 2. COMO DEFINIR "CAIXA RECEBIDO"?

Opções:
- A) `Payment.status === 'paid'`
- B) Soma de `Payment.amount` onde `paidAt` existe
- C) Evento `PAYMENT_RECEIVED` processado

**✅ Recomendação V2: A + validação de `paidAt`**

### 3. PACOTES: COMO CALCULAR `recognizedRevenue`?

Fórmula correta:
```javascript
recognizedRevenue = sessionsUsed * (totalValue / totalSessions)

// NUNCA usar preço avulso!
```

### 4. CONVÊNIOS: COMO SABER SE FOI "PRODUZIDO"?

```javascript
// Convênio é produção quando:
Session.status === 'completed' 
&& Session.insuranceBillingProcessed === true

// NÃO depende de pagamento (vem depois)
```

---

## 📋 PLANO DE MIGRAÇÃO

### FASE 1: Auditar Dados Legados

```javascript
// Script para verificar inconsistências
const audit = {
  // 1. Payments sem billingType
  paymentsNoBillingType: await Payment.countDocuments({ billingType: { $exists: false } }),
  
  // 2. Sessions com isPaid=true mas sem Payment
  sessionsPaidNoPayment: await Session.countDocuments({
    isPaid: true,
    _id: { $nin: await Payment.distinct('session') }
  }),
  
  // 3. Packages sem type
  packagesNoType: await Package.countDocuments({ type: { $exists: false } }),
  
  // 4. Appointments completados sem Session
  appointmentsNoSession: await Appointment.countDocuments({
    operationalStatus: 'completed',
    session: { $exists: false }
  }),
  
  // 5. Convênios sem insurance.status
  convenioNoStatus: await Payment.countDocuments({
    billingType: 'convenio',
    'insurance.status': { $exists: false }
  })
};
```

### FASE 2: Correções no Legado (ANTES de migrar)

1. **Adicionar `billingType` em todos os Payments**
   ```javascript
   await Payment.updateMany(
     { billingType: { $exists: false }, paymentMethod: 'convenio' },
     { $set: { billingType: 'convenio' } }
   );
   ```

2. **Migrar `paymentMethod: 'package'` → apropriado**
   ```javascript
   // Se tem package + insurance → convenio
   // Se tem package sem insurance → particular (mas isso não existe no legado!)
   ```

3. **Sincronizar Session.isPaid com Payment**
   ```javascript
   // Garantir que Session.isPaid reflete Payment.status
   ```

### FASE 3: Popular V2

1. **Criar Payments faltantes** para sessões de pacote
2. **Criar InsuranceBatch** para convênios já faturados
3. **Calcular PackageCredit** proporcional

---

## ⚠️ RISCOS IDENTIFICADOS

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| Perda de histórico financeiro | Média | Alto | Backup antes de migrar |
| Valores incorretos de pacote | Alta | Alto | Fórmula proporcional |
| Convênios duplicados | Média | Médio | Índice único por session |
| Datas inconsistentes | Alta | Médio | Normalizar para ISO |

---

## 🎯 PRÓXIMO PASSO

Quer que eu crie:

1. **Script de auditoria** → mostra todos os gaps no seu banco atual
2. **Script de correção** → corrige os dados legados antes de migrar
3. **Script de migração V2** → popula o novo formato
4. **Todos acima**

---

**Recomendação: Começar com o script de auditoria para ver o tamanho do problema.**
