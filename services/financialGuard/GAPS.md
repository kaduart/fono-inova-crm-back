# 🚨 Gaps Conhecidos do FinancialGuard

> Documentação de validações que ainda NÃO estão centralizadas no FinancialGuard mas deveriam estar.

---

## 1. `session.package` — Vínculo Session ↔ Package

**Status:** ❌ NÃO VALIDADO
**Impacto:** Alto — divergência de dados entre session e package
**Onde deveria estar:** `settle.guard.js` ou novo `session.guard.js`

### Problema

Hoje validamos:
- ✅ `payment.package` → pertence ao packageId?
- ✅ `appointment.package` → pertence ao packageId?
- ❌ `session.package` → NÃO validado

### Cenário de risco

```
Session.package = "pkg_A"
Payment.package = "pkg_A"
Appointment.package = "pkg_B"  ← bloqueado pelo guard
```

Mas se:
```
Session.package = "pkg_C"  ← diverge!
Payment.package = "pkg_A"
Appointment.package = "pkg_A"
```

→ O guard NÃO detecta. A session fica órfã ou vinculada ao pacote errado.

### Ação futura

Adicionar `validateSessionLink()` no settle guard ou criar `guards/session.guard.js`:

```js
async function validateSessionLink(sessionId, packageId, mongoSession) {
  const Session = mongoose.model('Session');
  const sessionDoc = await Session.findById(sessionId).session(mongoSession).lean();
  if (sessionDoc && sessionDoc.package?.toString() !== packageId) {
    throw new FinancialGuardError('SESSION_PACKAGE_MISMATCH', {
      sessionId, sessionPackageId: sessionDoc.package, expectedPackageId: packageId
    });
  }
}
```

---

## 2. Criação de Payment fora do Guard

**Status:** ❌ 17+ lugares criam `Payment.create()` diretamente
**Impacto:** Médio — dados inconsistentes, billingType errado, sem validação

### Onde acontece

- `controllers/appointment.js` — cria payment para appointment particular
- `controllers/importFromAgenda.js` — importação em massa
- `controllers/therapyPackageController.js` — cria payments de sessão
- `workers/PaymentWorker.js` — processa pagamentos automáticos

### Problema

Nenhum desses lugares valida:
- Se `billingType` é válido para o contexto
- Se `sessionValue > 0` para packages
- Se `totalSessions > 0`
- Se vínculo package/payment/appointment é consistente

### Ação futura

Criar `guards/create.guard.js` com contexto `CREATE_PAYMENT`:

```js
FinancialGuard.execute({
  context: 'CREATE_PAYMENT',
  billingType: payload.billingType,
  payload: { paymentData: payload },
  session: mongoSession
});
```

---

## 3. `PaymentWorker.processMultiPayment` — Sem propagação

**Status:** ❌ Worker não propaga para Session/Package
**Impacto:** Alto — pagamento processado mas sessão fica "não paga"

### Problema

O worker processa o pagamento mas:
- Não atualiza `Session.isPaid`
- Não atualiza `Package.totalPaid/balance`
- Não chama `buildPackageView()`

A propagação hoje só acontece na **camada de API** (`bulk-settle`, `settlePackagePayments`).

### Ação futura

Refatorar `PaymentWorker.processMultiPayment` para:
1. Chamar `FinancialGuard.execute({ context: 'SETTLE_PAYMENT', ... })`
2. Propagar para Session/Package/View (extrair para service compartilhado)

---

## 4. `particular.guard.js` e `package.guard.js` — Não usam `FinancialGuardError`

**Status:** ⚠️ Parcial
**Impacto:** Baixo — inconsistência de erro entre guards

### Problema

Os guards antigos (`package.guard.js`, `particular.guard.js`) ainda lançam `Error` genérico ou `console.warn`.

### Ação futura

Refatorar para usar `FinancialGuardError` padronizado.

---

## 📋 Prioridade de implementação

| # | Gap | Prioridade | Complexidade |
|---|-----|-----------|--------------|
| 1 | `session.package` validation | 🔴 Alta | Média |
| 2 | `PaymentWorker` propagation | 🔴 Alta | Alta |
| 3 | `CREATE_PAYMENT` guard | 🟡 Média | Alta |
| 4 | Padronizar guards antigos | 🟢 Baixa | Baixa |
