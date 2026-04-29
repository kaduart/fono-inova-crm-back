# 🛡️ FINANCIAL GUARD — MAPA DE CONTEXTOS

> Fonte da verdade arquitetural do domínio financeiro.

---

## 📋 GUARDS EXISTENTES

| Guard | Arquivo | Contextos Suportados |
|-------|---------|---------------------|
| **package** | `guards/package.guard.js` | `CANCEL_APPOINTMENT`, `COMPLETE_SESSION` |
| **particular** | `guards/particular.guard.js` | `CANCEL_APPOINTMENT` |
| **settle** | `guards/settle.guard.js` | `SETTLE_PAYMENT` |

---

## 🎯 CONTEXTOS DEFINIDOS

### `CANCEL_APPOINTMENT`
**Responsável:** `package.guard.js`, `particular.guard.js`

| billingType | Guard | Ação |
|-------------|-------|------|
| `package` | package | Restaura crédito/sessão, estorna per-session, restaura liminar |
| `particular` | particular | Cancela payment avulso |

---

### `COMPLETE_SESSION`
**Responsável:** `package.guard.js`

| billingType | Guard | Ação |
|-------------|-------|------|
| `package` | package | Consome crédito/sessão, cobra per-session |

---

### `SETTLE_PAYMENT`
**Responsável:** `settle.guard.js`

| billingType | Guard | Ação |
|-------------|-------|------|
| `settle` | settle | Valida se todos os payments são `particular` (ou `null` tratado como particular) |

**Regras:**
- ❌ `convenio` → bloqueia (use faturamento)
- ❌ `insurance` → bloqueia (use faturamento)
- ❌ `liminar` → bloqueia (consome crédito judicial)
- ✅ `particular` → permite
- ✅ `null` → trata como particular (legacy)

---

## 🔄 FLUXO DE USO

```js
// Exemplo: bulk-settle
await FinancialGuard.execute({
  context: 'SETTLE_PAYMENT',
  billingType: 'settle',
  payload: { paymentIds },
  session: mongoSession  // ← obrigatório
});
```

---

## 🚀 PRÓXIMOS CONTEXTOS (futuro)

| Contexto | Descrição | Guard Futuro |
|----------|-----------|-------------|
| `CREATE_PAYMENT` | Validação ao criar payment | `create.guard.js` |
| `PROCESS_BILLING` | Faturamento convênio | `billing.guard.js` |
| `APPLY_LIMINAR` | Consumo de crédito liminar | `liminar.guard.js` |
| `REFUND_PAYMENT` | Estorno de pagamento | `refund.guard.js` |

---

## ⚠️ REGRAS SAGRADAS

1. **SEMPRE** roda dentro de transaction MongoDB
2. **NUNCA** publica evento
3. **NUNCA** chama worker externo
4. **SÓ** mexer no banco (determinístico)
5. **SEMPRE** retorna `{ handled: boolean, ... }`
