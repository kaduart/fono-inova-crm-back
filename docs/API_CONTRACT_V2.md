# 📋 API Contract V2 - Complete Session

> Contrato estável entre backend e frontend

---

## 🎯 Endpoint

```
PATCH /api/v2/appointments/:id/complete?v2=true
```

---

## 📤 Request

### Headers
```http
Authorization: Bearer <token>
Content-Type: application/json
```

### Body
```json
{
  "notes": "string (opcional)",
  "evolution": "string (opcional)"
}
```

---

## 📥 Response (200 OK)

### DTO Completo

```json
{
  "success": true,
  "data": {
    "appointmentId": "string",
    "clinicalStatus": "completed",
    "operationalStatus": "completed",
    "paymentStatus": "unpaid | paid | pending_receipt",
    "balanceAmount": 150.00,
    "sessionValue": 150.00,
    "isPaid": false,
    "completedAt": "2026-04-12T03:55:16.000Z",
    "sessionId": "string",
    "packageId": "string"
  },
  "meta": {
    "version": "v2",
    "correlationId": "string",
    "timestamp": "2026-04-12T03:55:16.000Z"
  }
}
```

---

## 🧩 DTO por Tipo de Package

### Particular Per-Session (Gera Dívida)

```json
{
  "clinicalStatus": "completed",
  "operationalStatus": "completed",
  "paymentStatus": "unpaid",
  "balanceAmount": 150.00,
  "isPaid": false
}
```

**Regra:** `balanceAmount = sessionValue` (dívida criada)

---

### Convênio

```json
{
  "clinicalStatus": "completed",
  "operationalStatus": "completed",
  "paymentStatus": "pending_receipt",
  "balanceAmount": 0,
  "isPaid": false
}
```

**Regra:** Sem débito imediato, aguarda recibo do convênio

---

### Liminar

```json
{
  "clinicalStatus": "completed",
  "operationalStatus": "completed",
  "paymentStatus": "paid",
  "balanceAmount": 0,
  "isPaid": true,
  "paymentMethod": "liminar_credit"
}
```

**Regra:** Pago via crédito judicial

---

## ⚠️ Response 409 Conflict (Idempotência)

```json
{
  "success": true,
  "idempotent": true,
  "message": "Sessão já estava completada",
  "data": {
    "appointmentId": "string",
    "clinicalStatus": "completed"
  }
}
```

---

## ❌ Response 400 Bad Request

```json
{
  "success": false,
  "error": {
    "code": "INVALID_STATUS",
    "message": "Cannot complete canceled session"
  }
}
```

---

## 📊 Fonte de Verdade

| Entidade | Campo | Significado |
|----------|-------|-------------|
| **Package** | `balance` | Verdade financeira agregada |
| **Package** | `sessionsDone` | Contador de sessões |
| **Appointment** | `balanceAmount` | Snapshot financeiro (read-only) |
| **Appointment** | `paymentStatus` | Estado de pagamento operacional |

**Regra de Ouro:** `Package.balance` é a fonte oficial. `Appointment.balanceAmount` é snapshot histórico.

---

## 🔄 Estados Válidos

```
scheduled → completed ✅
confirmed → completed ✅
canceled  → completed ❌ (400)
completed → completed 🔄 (409 idempotente)
```

---

## 📝 Checklist Frontend

- [ ] Usar `operationalStatus` para UI (badges/cores)
- [ ] Usar `balanceAmount` para mostrar dívida
- [ ] Usar `paymentStatus` para fluxo de cobrança
- [ ] Tratar 409 como sucesso (idempotência)
- [ ] Nunca confiar em `balanceAmount` para cálculos financeiros (usar Package)
