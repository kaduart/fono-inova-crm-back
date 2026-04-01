# MAPA DE REGRAS CONSOLIDADO
## União das regras confirmadas + análise do código

---

## 📋 REGRAS POR DOMÍNIO

---

## 1️⃣ AGENDAMENTO (Appointment)

### Status Operacionais Válidos
```javascript
// Do código (Appointment.js linha 66-78)
'pre_agendado'  // Interesse registrado
'scheduled'     // Confirmado
'confirmed'     // Confirmado pelo profissional
'pending'       // Pendente
'canceled'      // Cancelado
'paid'          // Pago
'missed'        // Faltou
```

### Status Clínicos
```javascript
// Do código (Appointment.js linha 79-83)
'pending', 'in_progress', 'completed', 'missed'
```

### Status Financeiros
```javascript
// Do código (Appointment.js linha 143-146)
'pending', 'paid', 'partial', 'canceled', 'advanced', 'package_paid', 'pending_receipt'
```

### Regras Confirmadas + Código

| Regra | Confirmação | Código |
|-------|-------------|--------|
| Pode agendar sem pagamento | ✅ SIM | - |
| Cria trinca (App+Session+Payment) | ✅ HOJE SIM |appointment.js linha 217+ |
| Conflito de horário bloqueia | ✅ SIM | conflictDetection.js linha 137-171 |
| Cancelado libera slot | ✅ SIM | appointmentStatus.js linha 2-7 |
| Secretaria confirma manualmente | ✅ SIM | - |
| Duração padrão 40min | - | conflictDetection.js linha 110 |

---

## 2️⃣ SESSÃO (Session)

### Status Válidos
```javascript
// Do código (Session.js linha 43-48)
'pending', 'completed', 'canceled', 'scheduled'
```

### Flags Importantes
```javascript
isPaid: Boolean
sessionConsumed: Boolean  // true quando completed/missed
paymentStatus: enum ['paid', 'partial', 'pending', 'pending_receipt', 'recognized']
visualFlag: enum ['ok', 'pending', 'blocked']
```

### Regras Confirmadas + Código

| Regra | Confirmação | Código |
|-------|-------------|--------|
| Sessão só consumida quando realizada | ✅ SIM | Session.js linha 296-297 |
| Cancelado NÃO consome | ✅ SIM | Session.js linha 311-319 |
| Completed consome sessão | ✅ SIM | Session.js hook pre-save |
| Falta (missed) também consome | - | Session.js linha 308-310 |
| Guia consumida só no completed | - | Session.js linha 220-267 |

---

## 3️⃣ PACOTE (Package)

### Tipos de Pacote
```javascript
// Do código (Package.js linha 81-86)
'therapy', 'convenio', 'liminar'
```

### Status
```javascript
// Do código (Package.js linha 38, 47-51)
status: ['active', 'in-progress', 'completed']
financialStatus: ['unpaid', 'partially_paid', 'paid']
```

### Controle de Sessões
```javascript
totalSessions: Number (mínimo 1)
sessionsDone: Number (default 0)
remainingSessions: virtual (total - done)
```

### Regras Confirmadas + Código

| Regra | Confirmação | Código |
|-------|-------------|--------|
| Sessão só consumida na execução | ✅ SIM | Package.js + Session.js |
| Pode reaproveitar sessão cancelada | - | appointment.js linha 290-336 |
| Validação de crédito disponível | - | packageValidationWorker.js |

---

## 4️⃣ PAGAMENTO (Payment)

### Tipos
```javascript
// Do código (Payment.js linha 54)
'package_receipt', 'session_payment', 'manual', 'auto', 'session_completion', 'revenue_recognition'
```

### Status
```javascript
// Do código (Payment.js linha 75)
'pending', 'attended', 'billed', 'paid', 'partial', 'canceled', 'advanced', 'package_paid', 'recognized'
```

### Métodos
```javascript
'dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'cartão', 
'transferencia_bancaria', 'plano-unimed', 'convenio', 'liminar_credit', 'outro'
```

### Regras Confirmadas + Código

| Regra | Confirmação | Código |
|-------|-------------|--------|
| Pagamento é consequência da execução | ✅ SIM | - |
| Pode ser antes, depois ou ambos | ✅ SIM | - |
| Criado no agendamento (hoje) | ✅ SIM | appointment.js |
| Ideal: criar só no complete | ✅ MELHORIA | - |

---

## 5️⃣ CONVÊNIO (InsuranceGuide)

### Status
```javascript
// Do código (InsuranceGuide.js)
'active', 'exhausted', 'expired', 'cancelled'
```

### Controle
```javascript
totalSessions: Number
usedSessions: Number
remaining: virtual (total - used)
```

### Regras

| Regra | Confirmação | Código |
|-------|-------------|--------|
| Validação flexível (antes/depois) | ✅ SIM | - |
| Guia consumida só no completed | - | Session.js hook |
| Não pode exceder totalSessions | - | InsuranceGuide.js linha 170-183 |

---

## 6️⃣ CONFLITO DE HORÁRIO

### Regras do Sistema (conflictDetection.js)

```javascript
// Linha 21-22
Horário comercial: 08:00 às 18:00

// Linha 137-171
Verificação de sobreposição:
- Médico não pode ter 2 agendamentos no mesmo horário
- Paciente não pode ter 2 agendamentos no mesmo horário
- Considera duração (padrão 40min)
- Fórmula: newStart < apptEnd && newEnd > apptStart

// Linha 277 (índice)
Apenas 'canceled' libera o slot
```

---

## 🎯 FLUXOS CONSOLIDADOS

### FLUXO 1: Agendamento Particular (HOJE)
```
1. POST /appointments
   ├── Valida conflito de horário
   ├── Cria Appointment (status: pending)
   ├── Cria Session (status: scheduled)
   ├── Cria Payment (status: pending)  ← HOJE CRIA AQUI
   └── Retorna sucesso

2. Secretaria confirma
   └── Atualiza status: confirmed

3. Sessão realizada (/complete)
   ├── Atualiza Session: completed
   ├── Atualiza Payment: paid (se pago)
   ├── Ou gera cobrança (se não pago)
   └── Atualiza Appointment: completed
```

### FLUXO 2: Agendamento Pacote (HOJE)
```
1. POST /appointments (serviceType: package_session)
   ├── Valida pacote existe
   ├── Cria Appointment
   ├── Cria Session (isPaid: true, paymentStatus: package_paid)
   └── NÃO cria Payment (usa crédito do pacote)

2. Sessão realizada (/complete)
   ├── Incrementa Package.sessionsDone
   ├── Marca Session: completed
   └── Consome sessão do pacote
```

### FLUXO 3: Agendamento Convênio
```
1. POST /appointments (billingType: convenio)
   ├── Valida guia (se fornecida)
   ├── Cria Appointment
   ├── Cria Session (insuranceGuide vinculada)
   └── Cria Payment (amount: 0)

2. Sessão realizada (/complete)
   ├── Consome guia (usedSessions++)
   └── Marca para faturamento
```

---

## ⚠️ DECISÕES PENDENTES

### 1. Criar Session/Payment no agendamento ou no complete?

**Opção A (hoje):** Manter como está
- Agendamento cria Session + Payment
- Prós: compatível 100%
- Contras: dados prematuros

**Opção B (melhoria):** Criar só no complete
- Agendamento cria apenas Appointment
- Complete cria Session + Payment
- Prós: mais coerente com regras
- Contras: muda comportamento atual

### 2. Feature Flag
```javascript
USE_LEGACY_CREATE=true   // Opção A
USE_LEGACY_CREATE=false  // Opção B
```

---

## 📊 RESUMO DAS REGRAS CRÍTICAS

| Regra | Origem | Implementação |
|-------|--------|---------------|
| Conflito de horário | Código | ✅ Middleware + índice único |
| Sessão consome só no completed | Confirmação+Código | ✅ Session.js hook |
| Pacote baixa só na execução | Confirmação+Código | ✅ Package + Session |
| Pagamento consequência | Confirmação | ⚠️ Verificar se no código |
| Cancela libera slot | Confirmação+Código | ✅ appointmentStatus.js |
| Trinca no agendamento | Confirmação | ✅ appointment.js |

---

## ✅ PRÓXIMO PASSO

Com base neste mapa consolidado, posso implementar:

1. **createAppointmentService** seguindo EXATAMENTE estas regras
2. **Workers** que respeitam cada validação
3. **Feature flags** para testar sem quebrar o legado

**Posso prosseguir?** 👍
