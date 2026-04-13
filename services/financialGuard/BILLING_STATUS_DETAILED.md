# 🏥 STATUS DETALHADO - TIPOS DE BILLING

## 📊 Matriz de Implementação

| Tipo | Guard | Status | CANCEL | COMPLETE | Validação |
|------|-------|--------|--------|----------|-----------|
| **📦 Pacote Pré-pago** | package | ✅ Pronto | Restaura sessão | Consome sessão | Testado ✅ |
| **📦 Pacote Per-session** | package | ✅ Pronto | Restaura + estorna | Consome + cobra | Testado ✅ |
| **💵 Particular** | particular | ⚠️ Parcial | Cancela payment | N/A* | Testado ✅ |
| **🏥 Convênio** | insurance | ❌ Futuro | Marca guia | Cria guia TISS | Não implementado |
| **⚖️ Liminar** | legal | ❌ Futuro | Auditoria | Consome crédito judicial | Não implementado |
| **💳 Particular Antecipado** | particular | ⚠️ Parcial | Cancela payment | N/A* | Mesmo particular |

*Particular não usa Guard no COMPLETE (payment criado fora da transaction)

---

## 📦 1. PACOTE PRÉ-PAGO (Total)

### Características
- Cliente pagou TUDO antecipadamente
- Ex: 10 sessões por R$ 1.000 (R$ 100 cada)

### Banco de Dados
```javascript
{
  totalSessions: 10,
  sessionsDone: 0,
  totalPaid: 1000,
  paidSessions: 10,  // Todas já pagas
  balance: 0,
  paymentType: 'prepaid'
}
```

### COMPLETE_SESSION
```javascript
// ANTES
sessionsDone: 3
paidSessions: 10

// DEPOIS (+1 sessão)
sessionsDone: 4  // ✅ +1
paidSessions: 10 // ❌ NÃO muda (já tá pago)
```

**Regra**: Só incrementa `sessionsDone`. NÃO mexe em `paidSessions` nem `totalPaid`.

### CANCEL_APPOINTMENT
```javascript
// ANTES (appointment estava completed)
sessionsDone: 4

// DEPOIS (cancelamento)
sessionsDone: 3  // ✅ -1
// NÃO mexe em paidSessions (dinheiro já recebido)
```

**Regra**: Decrementa `sessionsDone`. NÃO estorna dinheiro (já foi pago antecipadamente).

---

## 📦 2. PACOTE PER-SESSION

### Características
- Cliente paga CONFORME usa
- Ex: 10 sessões, paga R$ 100 cada vez que usa

### Banco de Dados
```javascript
{
  totalSessions: 10,
  sessionsDone: 0,
  totalPaid: 0,
  paidSessions: 0,
  balance: 0,
  paymentType: 'per-session'
}
```

### COMPLETE_SESSION
```javascript
// ANTES
sessionsDone: 3
paidSessions: 3
totalPaid: 300

// DEPOIS (+1 sessão de R$ 100)
sessionsDone: 4   // ✅ +1
paidSessions: 4   // ✅ +1
totalPaid: 400    // ✅ +100
```

**Regra**: Incrementa `sessionsDone`, `paidSessions` E `totalPaid`.

### CANCEL_APPOINTMENT
```javascript
// ANTES (appointment estava completed)
sessionsDone: 4
paidSessions: 4
totalPaid: 400

// DEPOIS (cancelamento)
sessionsDone: 3   // ✅ -1
paidSessions: 3   // ✅ -1  
totalPaid: 300    // ✅ -100 (estorna)
```

**Regra**: Decrementa tudo (sessão NÃO foi paga efetivamente ainda, ou estorna se já pagou).

---

## 💵 3. PARTICULAR PAGO NA SESSÃO

### Características
- Sem package
- Pagamento direto (PIX, dinheiro, cartão)
- Cria `Payment` no banco

### Banco de Dados
```javascript
// Appointment
{
  billingType: 'particular',
  package: null,
  payment: ObjectId('...'),  // Referência ao Payment
  sessionValue: 150
}

// Payment
{
  amount: 150,
  status: 'pending' | 'paid',
  kind: 'manual'
}
```

### COMPLETE_SESSION
```javascript
// Financial Guard: NÃO executa (retorna 'BILLING_TYPE_NOT_MAPPED')
// Payment criado FORA da transaction (event-driven)
```

**Regra**: 
- NÃO usa Financial Guard no complete
- Payment criado async após transaction
- Session marcada como completed

### CANCEL_APPOINTMENT
```javascript
// Financial Guard PARTICULAR executa:
Payment.status = 'canceled'
Payment.canceledAt = Date.now()
```

**Regra**: Cancela o Payment se existir.

---

## 💳 4. PARTICULAR ANTECIPADO

### Características
- Parece particular mas é "pré-pago"
- Cliente pagou antecipadamente por sessões avulsas

### Implementação
**Tratado como PARTICULAR** (não tem package vinculado)

```javascript
// Na prática, é um particular comum
// O "antecipado" é só uma forma de pagamento, não altera regra
```

**Regra**: Mesmo comportamento do PARTICULAR padrão.

---

## 🏥 5. CONVÊNIO (NÃO IMPLEMENTADO)

### Características
- Pagamento via operadora de saúde
- Controle por GUIAS TISS (não é Payment)
- Prazo de recebimento: 30-90 dias

### Banco de Dados (Esperado)
```javascript
{
  billingType: 'convenio',
  insuranceGuide: ObjectId('...'),
  paymentStatus: 'pending_billing' | 'billed' | 'received'
}
```

### COMPLETE_SESSION (Futuro)
```javascript
// insurance.guard.handle()
→ Cria/atualiza Guia TISS
→ Status: 'pending_billing'
→ NÃO cria Payment
```

### CANCEL_APPOINTMENT (Futuro)
```javascript
// insurance.guard.handle()
→ Marca guia como 'canceled'
→ NÃO estorna (convênio não tem crédito)
```

**Status**: 🔜 NÃO IMPLEMENTADO (usa fluxo legado)

---

## ⚖️ 6. LIMINAR (NÃO IMPLEMENTADO)

### Características
- Sessões judiciais (indenização)
- Crédito judicial controlado
- Pode ter restrições de uso

### Banco de Dados (Esperado)
```javascript
{
  billingType: 'liminar',
  liminarCredit: ObjectId('...'),
  sessionType: 'fonoaudiologia' // Pode ter restrição
}
```

### COMPLETE_SESSION (Futuro)
```javascript
// legal.guard.handle()
→ Verifica se tipo de sessão é permitido
→ Consome crédito judicial (similar a package)
→ Marca origem: 'LIMINAR'
→ NÃO cria Payment (já pago pela justiça)
```

### CANCEL_APPOINTMENT (Futuro)
```javascript
// legal.guard.handle()
→ Restaura crédito judicial
→ Auditoria extra (log detalhado)
→ NÃO gera crédito para paciente
```

**Status**: 🔜 NÃO IMPLEMENTADO (usa fluxo legado)

---

## 🎯 RESUMO VISUAL

```
COMPLETE_SESSION
┌─────────────────────────────────────────────────────────┐
│ 📦 Pacote Pré-pago                                      │
│    → sessionsDone += 1                                  │
│    → paidSessions: NÃO muda                             │
│    → totalPaid: NÃO muda                                │
├─────────────────────────────────────────────────────────┤
│ 📦 Pacote Per-session                                   │
│    → sessionsDone += 1                                  │
│    → paidSessions += 1                                  │
│    → totalPaid += valor                                 │
├─────────────────────────────────────────────────────────┤
│ 💵 Particular (qualquer forma)                          │
│    → NÃO usa Financial Guard                            │
│    → Payment criado fora (async)                        │
├─────────────────────────────────────────────────────────┤
│ 🏥 Convênio                                             │
│    → 🔜 NÃO IMPLEMENTADO                                │
│    → Deveria criar guia TISS                            │
├─────────────────────────────────────────────────────────┤
│ ⚖️ Liminar                                              │
│    → 🔜 NÃO IMPLEMENTADO                                │
│    → Deveria consumir crédito judicial                  │
└─────────────────────────────────────────────────────────┘

CANCEL_APPOINTMENT
┌─────────────────────────────────────────────────────────┐
│ 📦 Pacote Pré-pago                                      │
│    → sessionsDone -= 1                                  │
│    → NÃO estorna dinheiro (já foi pago)                 │
├─────────────────────────────────────────────────────────┤
│ 📦 Pacote Per-session                                   │
│    → sessionsDone -= 1                                  │
│    → paidSessions -= 1                                  │
│    → totalPaid -= valor (estorna)                       │
├─────────────────────────────────────────────────────────┤
│ 💵 Particular                                           │
│    → Cancela Payment (status: 'canceled')               │
├─────────────────────────────────────────────────────────┤
│ 🏥 Convênio / ⚖️ Liminar                                │
│    → 🔜 NÃO IMPLEMENTADO                                │
└─────────────────────────────────────────────────────────┘
```

---

## ✅ STATUS FINAL

| Tipo | Implementado | Testado | Produção |
|------|--------------|---------|----------|
| Pacote Pré-pago | ✅ | ✅ | ✅ SIM |
| Pacote Per-session | ✅ | ✅ | ✅ SIM |
| Particular (todas formas) | ✅ | ✅ | ✅ SIM |
| Convênio | ❌ | ❌ | ⚠️ Usa legado |
| Liminar | ❌ | ❌ | ⚠️ Usa legado |

---

## 🚀 RECOMENDAÇÃO

### Agora (Hoje)
- ✅ Pacote: Pronto para produção
- ✅ Particular: Pronto para produção

### Futuro (Próximas semanas)
- 🔜 Implementar `insurance.guard.js`
- 🔜 Implementar `legal.guard.js`

### Não quebra (Seguro)
Convênio e Liminar estão usando fluxo legado e **NÃO QUEBRAM** o sistema.
