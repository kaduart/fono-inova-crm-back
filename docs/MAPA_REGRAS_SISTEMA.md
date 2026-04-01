# MAPA OFICIAL DE REGRAS DO SISTEMA
## Análise do Código Legado - Não criei nada novo, apenas documentei o que existe

---

## 📋 REGRAS POR DOMÍNIO

---

## 1️⃣ AGENDAMENTO (Appointment)

### Status Válidos (operationalStatus)
```javascript
// Modelo Appointment.js linha 66-78
enum: [
  'pre_agendado',      // Interesse registrado, aguarda confirmação
  'scheduled',         // Confirmado pela secretaria/paciente
  'confirmed',         // Confirmado pelo profissional
  'pending',
  'canceled',          // Cancelado
  'paid',
  'missed'
]
```

### Status Clínico (clinicalStatus)
```javascript
// Modelo Appointment.js linha 79-83
enum: ['pending', 'in_progress', 'completed', 'missed']
default: 'pending'
```

### Status Financeiro (paymentStatus)
```javascript
// Modelo Appointment.js linha 143-146
enum: [
  'pending',          // Pendente
  'paid',             // Pago
  'partial',          // Parcial
  'canceled',         // Cancelado
  'advanced',         // Adiantado
  'package_paid',     // Pago por pacote
  'pending_receipt'   // Aguardando recebimento (convênio)
]
```

### Regra CRÍTICA 1: Conflito de Horário
```javascript
// middleware/conflictDetection.js linha 62-220

// NÃO pode haver sobreposição de horário:
// 1. Mesmo médico não pode ter 2 agendamentos no mesmo horário
// 2. Mesmo paciente não pode ter 2 agendamentos no mesmo horário
// 3. Status 'canceled' libera o slot (não bloqueia)

// Lógica de sobreposição (linha 147):
const overlaps = newStartMinutes < apptEnd && newEndMinutes > apptStart;

// Duração padrão: 40 minutos
```

### Regra 2: Horário Comercial
```javascript
// middleware/conflictDetection.js linha 21-22
const BUSINESS_START = "08:00";
const BUSINESS_END = "18:00";
// (Obs: verificação existe mas pode ser flexível no código atual)
```

### Regra 3: Índice Único
```javascript
// Appointment.js linha 270-281
// Índice único: doctor + date + time (apenas para status não-cancelados)
// Previne duplicatas no banco
```

---

## 2️⃣ PACOTE (Package)

### Campos de Controle
```javascript
// Package.js linha 31, 36, 168-169
totalSessions: Number (mínimo: 1)
sessionsDone: Number (default: 0)
remainingSessions: virtual (totalSessions - sessionsDone)
```

### Status do Pacote
```javascript
// Package.js linha 38
enum: ['active', 'in-progress', 'completed']
```

### Status Financeiro
```javascript
// Package.js linha 47-51
enum: ['unpaid', 'partially_paid', 'paid']
```

### Tipos de Pacote
```javascript
// Package.js linha 81-86
enum: ['therapy', 'convenio', 'liminar']
default: 'therapy'
```

### Regra CRÍTICA 1: Consumo de Sessão
```javascript
// Quando uma sessão é marcada como 'completed':
// 1. Package.sessionsDone é incrementado
// 2. Session.sessionConsumed = true

// Session.js linha 296-297:
if (this.status === 'completed') {
    this.sessionConsumed = true;
}
```

### Regra 2: Cancelamento Devolve Sessão?
```javascript
// Session.js linha 311-319:
if (this.status === 'canceled') {
    this.sessionConsumed = false;  // NÃO CONSOME
    // Mas NÃO há código automático para devolver ao pacote!
    // Isso é feito manualmente ou não é feito
}
```

### Regra 3: Reaproveitamento de Crédito
```javascript
// appointment.js linha 290-336
// Se existe sessão cancelada com pagamento original:
// - Reaproveita o crédito (originalPartialAmount)
// - Zera os campos "originais" da sessão cancelada
```

---

## 3️⃣ PAGAMENTO (Payment)

### Tipos de Pagamento
```javascript
// Payment.js linha 54
enum: [
  'package_receipt',     // Recibo do pacote
  'session_payment',     // Pagamento de sessão
  'manual',
  'auto',
  'session_completion',  // Conclusão de sessão
  'revenue_recognition'
]
```

### Status de Pagamento
```javascript
// Payment.js linha 75
enum: [
  'pending',
  'attended',
  'billed',
  'paid',
  'partial',
  'canceled',
  'advanced',
  'package_paid',
  'recognized'
]
```

### Métodos de Pagamento
```javascript
// Payment.js linha 67-71
enum: [
  'dinheiro',
  'pix',
  'cartao_credito',
  'cartao_debito',
  'cartão',
  'transferencia_bancaria',
  'plano-unimed',
  'convenio',
  'liminar_credit',
  'outro'
]
```

### Regra CRÍTICA: Quando Criar Pagamento?
```javascript
// Análise do código atual:

// 1. PACOTE (serviceType === 'package_session'):
//    - Se amount > 0: cria pagamento
//    - Se amount <= 0: NÃO cria pagamento (usa crédito existente)

// 2. PARTICULAR (serviceType === 'session'):
//    - Cria pagamento normalmente
//    - Pode ser antes ou depois (não há bloqueio rígido)

// 3. CONVÊNIO:
//    - Payment criado com valor 0 inicialmente
//    - Atualizado quando faturado/recebido

// 4. ADIANTADO (isAdvancePayment):
//    - Cria pagamento + sessões futuras
```

---

## 4️⃣ CONVÊNIO (InsuranceGuide)

### Regras da Guia
```javascript
// InsuranceGuide.js

totalSessions: Number (total de sessões autorizadas)
usedSessions: Number (sessões já utilizadas)

// Validações (linha 170-210):
// 1. usedSessions não pode exceder totalSessions
// 2. Se usedSessions >= totalSessions → status = 'exhausted'
// 3. Bloquear redução de totalSessions para abaixo de usedSessions
```

### Status da Guia
```javascript
enum: ['active', 'exhausted', 'expired', 'cancelled']
```

### Regra CRÍTICA: Consumo da Guia
```javascript
// Session.js linha 210-267 (Hook post-findOneAndUpdate)

// Sessão consome guia QUANDO:
// 1. status muda para 'completed'
// 2. insuranceGuide está preenchido
// 3. guideConsumed === false (idempotência)

// Se completou → usedSessions++
// Se reverter (completed → outro) → NÃO reverte automaticamente!
```

---

## 5️⃣ SESSÃO (Session)

### Status
```javascript
// Session.js linha 43-48
enum: ['pending', 'completed', 'canceled', 'scheduled']
```

### Status Financeiro
```javascript
// Session.js linha 52-57
enum: ['paid', 'partial', 'pending', 'pending_receipt', 'recognized']
```

### Flags Importantes
```javascript
sessionConsumed: Boolean  // true se completed/missed
isPaid: Boolean
paymentStatus: String
visualFlag: String ('ok', 'pending', 'blocked')
```

### Regra CRÍTICA: O que consome sessão?
```javascript
// Session.js linha 296-310:

// Consome sessão (sessionConsumed = true):
// - status === 'completed'
// - status === 'missed'

// NÃO consome:
// - status === 'canceled'
// - status === 'scheduled' (pendente)
```

---

## 🎯 FLUXOS REAIS DO SISTEMA

### FLUXO 1: Agendamento Particular Avulso
```
1. API recebe request (patient, doctor, date, time, amount)
2. Middleware checkAppointmentConflicts:
   - Verifica se médico está livre
   - Verifica se paciente está livre
   - Retorna 409 se conflito
3. Cria Appointment (status: pending)
4. Se amount > 0:
   - Cria Payment (status: pending)
   - Vincula Payment ao Appointment
5. Retorna sucesso

Pagamento pode ser:
- Feito na hora (immediate)
- Deixado para depois (balance)
```

### FLUXO 2: Agendamento com Pacote
```
1. API recebe request (packageId, date, time)
2. Verifica se pacote existe
3. Verifica conflito de horário
4. Se amount <= 0 (usando crédito):
   - NÃO cria Payment
   - Verifica se há sessão cancelada para reaproveitar
   - Cria Session vinculada ao pacote
   - Session.isPaid = true (já pago pelo pacote)
5. Se amount > 0 (pagando mais):
   - Cria Payment normalmente
```

### FLUXO 3: Agendamento Convênio
```
1. API detecta billingType = 'convenio'
2. Usa billingOrchestrator
3. Valida guia ativa
4. Cria Session com insuranceGuide vinculada
5. Cria Payment (amount: 0, status: pending)
6. Guia só é consumida quando sessão for 'completed'
```

### FLUXO 4: Complete Session (o que já refatoramos)
```
Já documentado em completeSessionEventService.js
```

---

## ⚠️ REGRAS QUE NÃO PODEM MUDAR

### 1. NUNCA agendar sem verificar conflito
```javascript
// checkAppointmentConflicts é OBRIGATÓRIO
// Índice único no banco é segunda camada de proteção
```

### 2. Pacote NUNCA consumir sessão no agendamento
```javascript
// Sessão só é consumida quando status = 'completed'
// Isso permite cancelar sem perder crédito
```

### 3. Convênio NUNCA consumir guia no agendamento
```javascript
// Guia só é consumida quando Session.status = 'completed'
// (guideConsumed flag)
```

### 4. Cancelamento libera slot
```javascript
// operationalStatus = 'canceled' → não bloqueia mais o horário
```

---

## 📊 RESUMO PARA IMPLEMENTAÇÃO

| Cenário | Cria Payment? | Consome Sessão? | Validações |
|---------|--------------|-----------------|------------|
| Particular (amount > 0) | SIM | No complete | Conflito |
| Particular (amount = 0) | NÃO | No complete | Conflito |
| Pacote (usando crédito) | NÃO | No complete | Conflito + crédito disponível |
| Pacote (pagando mais) | SIM | No complete | Conflito |
| Convênio | SIM (amount: 0) | No complete | Conflito + guia válida |

---

**Documento gerado por análise do código em:**
- `/back/models/Appointment.js`
- `/back/models/Package.js`
- `/back/models/Session.js`
- `/back/models/Payment.js`
- `/back/models/InsuranceGuide.js`
- `/back/middleware/conflictDetection.js`
- `/back/routes/appointment.js`
- `/back/constants/appointmentStatus.js`

**Nenhuma regra foi criada - apenas extraída do código existente.**
