# 🚀 ARQUITETURA 4.0 - COMPLETA

> Regras do legado migradas para Event-Driven puro

---

## 📁 Estrutura

```
back/
├── domain/                          # 🧠 REGRAS DE NEGÓCIO PURAS
│   ├── session/
│   │   ├── cancelSession.js         # Preserva original*, cancela
│   │   └── completeSession.js       # Completa, calcula comissão
│   ├── payment/
│   │   └── cancelPayment.js         # Cancela (não de pacote)
│   ├── package/
│   │   └── consumePackageSession.js # Consome, reaproveita, atualiza financeiro
│   ├── insurance/
│   │   └── consumeInsuranceGuide.js # Consome guia convênio
│   ├── liminar/
│   │   └── recognizeRevenue.js      # Reconhece receita liminar
│   └── index.js                     # Exportações
│
├── workers/                         # 🎼 ORQUESTRADORES
│   ├── cancelOrchestratorWorker.js  # Coordena cancelamento
│   ├── completeOrchestratorWorker.js # Coordena complete
│   ├── createAppointmentWorker.js   # Cria sessão (com reaproveitamento)
│   ├── paymentWorker.js             # Processa pagamentos
│   ├── balanceWorker.js             # Atualiza saldo (atomic $inc)
│   └── index.js                     # Inicialização
│
├── infrastructure/
│   └── events/
│       └── eventPublisher.js        # Publica eventos
│
└── routes/
    ├── appointment.create.EVENT_DRIVEN.js
    ├── appointment.complete.EVENT_DRIVEN.js
    └── appointment.hybrid.js        # Feature flag router
```

---

## 🎯 Regras Migradas do Legado

### ✅ CANCELAMENTO (`domain/session/cancelSession.js`)

```javascript
// Regras do legado (appointment.js:1472-1526):
✅ Preserva dados em 'original*' se estava paga
✅ Marca status: 'canceled'
✅ paymentStatus: 'canceled'
✅ visualFlag: 'blocked'
✅ Guarda histórico

// NOVO: Reaproveitamento
✅ findReusableCanceledSession() - busca crédito
✅ consumeCanceledSessionCredit() - consome e zera
```

### ✅ COMPLETE (`domain/session/completeSession.js`)

```javascript
// Regras do legado:
✅ Status: 'completed'
✅ isPaid: depende do cenário
✅ Calcula comissão (rate * value)
✅ sessionConsumed: true
✅ revenueRecognizedAt
```

### ✅ PAYMENT (`domain/payment/cancelPayment.js`)

```javascript
// REGRA CRÍTICA (appointment.js:1451-1469):
✅ NÃO cancela se kind === 'package_receipt'
✅ NÃO cancela se kind === 'session_payment'
✅ Cancela demais (status: 'canceled')

// Para complete:
✅ createPaymentForComplete() - cria fora da transação
✅ confirmPayment() - confirma após commit
```

### ✅ PACOTE (`domain/package/consumePackageSession.js`)

```javascript
// Consumo:
✅ sessionsDone++ (só se tiver crédito)
✅ NÃO decrementa no cancelamento (igual legado)

// Reaproveitamento:
✅ Busca originalPartialAmount > 0 ou originalIsPaid
✅ Zera após reuso (evita duplicidade)

// Per-session:
✅ updatePackageFinancials() - totalPaid, paidSessions, balance, financialStatus
```

### ✅ CONVÊNIO (`domain/insurance/consumeInsuranceGuide.js`)

```javascript
// Regras do legado (appointment.js:2165-2271):
✅ Consome guia (usedSessions++)
✅ Se esgotou: status = 'exhausted'
✅ Marca session.guideConsumed (idempotência)
✅ Cria Payment billingType='convenio'
```

### ✅ LIMINAR (`domain/liminar/recognizeRevenue.js`)

```javascript
// Regras do legado (appointment.js:2113-2162):
✅ liminarCreditBalance -= sessionValue
✅ recognizedRevenue += sessionValue
✅ totalPaid += sessionValue
✅ Cria Payment kind='revenue_recognition'
```

---

## 🎬 Fluxos

### 1. CANCELAMENTO

```
PATCH /appointments/:id/cancel
    ↓
Publica: APPOINTMENT_CANCELED
    ↓
cancelOrchestratorWorker
    ↓
cancelSession()         → Preserva original*, cancela
cancelPayment()         → Cancela se não for pacote
Atualiza Appointment    → status: 'canceled'
Remove do array Package → NÃO decrementa sessionsDone!
    ↓
Publica: SESSION_CANCELED (para reaproveitamento)
```

### 2. COMPLETE

```
PATCH /appointments/:id/complete
    ↓
completeOrchestratorWorker
    ↓
TRANSAÇÃO:
  completeSession()     → status: 'completed', isPaid?, comissão
  consumePackageSession() → sessionsDone++
  Atualiza Appointment  → confirmed/completed
/COMMIT
    ↓
PÓS-COMMIT:
  confirmPayment()      → pending → paid
  consumeInsuranceGuide() → Se convênio
  createInsurancePayment() → Se convênio
  recognizeLiminarRevenue() → Se liminar
  publish BALANCE_UPDATE → Se addToBalance
```

### 3. CRIAÇÃO COM REAPROVEITAMENTO

```
POST /appointments
    ↓
appointment.create()
    ↓
Publica: APPOINTMENT_CREATED
    ↓
createAppointmentWorker
    ↓
findAndConsumeReusableCredit() → Busca crédito cancelado
    ↓
Se encontrou:
  createPackageSession({ creditData }) → isPaid: true
  Zera original* da sessão antiga
Se não:
  createPackageSession() → isPaid: false
```

---

## 🔥 Idempotência

Todos os workers têm **idempotência**:

```javascript
// Verifica se já processou
if (processedEvents.has(eventId)) {
    return { status: 'already_processed' };
}

// Guard no banco
if (appointment.clinicalStatus === 'completed') {
    return { status: 'already_completed' };
}

// Marca como processado no final
processedEvents.set(eventId, Date.now());
```

---

## 🎛️ Feature Flag

Use para migrar gradualmente:

```javascript
// routes/appointment.js
const use4 = req.query.use4 === 'true' || 
             isEnabled('USE_4_0', { userId: req.user?._id });

if (use4) {
    // Nova arquitetura
    await publishEvent(EventTypes.APPOINTMENT_CANCELED, ...);
    return res.json({ success: true, async: true });
} else {
    // Legado
    await cancelAppointmentLegacy(...);
}
```

---

## 🚀 Como Usar

### 1. Iniciar workers

```javascript
// server.js
import { startAllWorkers } from './workers/index.js';

startAllWorkers();
```

### 2. Usar nas rotas

```javascript
// cancel
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

await publishEvent(
    EventTypes.APPOINTMENT_CANCELED,
    { appointmentId, reason, userId },
    { correlationId }
);
```

### 3. Usar regras de domínio direto (se necessário)

```javascript
import { cancelSession } from '../domain/session/cancelSession.js';

const result = await cancelSession(session, { reason, userId });
```

---

## ✅ Checklist de Migração

- [x] Cancelamento
- [x] Complete (per-session, convênio, liminar)
- [x] Reaproveitamento de crédito
- [x] Idempotência
- [x] Compensação (Saga)
- [ ] Testes E2E
- [ ] Monitoramento
- [ ] Feature flag gradual

---

**Pronto para produção gradual! 🎉**
