# ✅ CHECKLIST E2E - 15 MINUTOS PRÉ-DEPLOY

> Validação rápida antes de ir pra produção

---

## 🚀 PASSO 1: Restart Server (1 min)

```bash
npm run dev
```

Verificar no log:
```
🔒 LOCK V2 - Modo ativado
```

---

## 🧪 PASSO 2: Teste Particular (3 min)

### 2.1 Criar Package
```
04-packages/particular-flow/1-Create
```
**Esperado:** 200 + package criado

### 2.2 Completar Sessão
```
09-complete-flow/01-happy-path/2-Complete
```
**Esperado:**
```json
{
  "success": true,
  "data": {
    "balanceAmount": 150,
    "paymentStatus": "unpaid",
    "isPaid": false
  }
}
```

### 2.3 Validar
```
09-complete-flow/03-validation/3-Check->>
```
**Esperado:** ✅✅✅✅ (4 checks)

---

## 🧪 PASSO 3: Teste Convênio (3 min)

```
04-packages/convenio-flow/1-Create → 2-Check
```

**Esperado:**
- `balanceAmount = 0` (não gera cobrança)
- `paymentStatus = pending_receipt`

---

## 🧪 PASSO 4: Teste Liminar (3 min)

```
04-packages/liminar-flow/1-Create → 3-Complete
```

**Esperado:**
- `paymentStatus = paid`
- `isPaid = true`
- `liminarCreditBalance` decrementado

---

## 🧪 PASSO 5: Teste Cancel (3 min)

```
08-cancel-flow/01-happy-path/1-Cancel → 2-Check
```

**Esperado:**
- Status: `processing_cancel` → `canceled`
- Package: `sessionsRemaining` restaurado

---

## 🧪 PASSO 6: Idempotência (2 min)

Rodar **2x** o mesmo complete:
```
09-complete-flow/01-happy-path/2-Complete
```

**Esperado:**
- 1ª vez: `idempotent: false`
- 2ª vez: `idempotent: true`
- Balance NÃO duplica

---

## ✅ RESULTADO

Se passou em tudo:
```
🎉 SISTEMA PRONTO PARA DEPLOY
```

Se falhou algum:
```
❌ NÃO DEPLOYAR - Revisar logs
```

---

## 💀 EMERGÊNCIA

Se precisar rollback:
```bash
# Reverter para versão anterior
git checkout HEAD~1 -- routes/appointment.v2.js
npm run dev
```

---

**Tempo total:** 15 minutos  
**Confiança:** 95% de cobertura de riscos 💀
