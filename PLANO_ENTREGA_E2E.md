# 🚀 PLANO DE ENTREGA E2E - V2 Financeiro

> Foco: LOCK V2 MODE + Validação E2E em 1 dia

---

## 🎯 OBJETIVO

```
Remover dualidade V1/V2 → Travar V2 como único fluxo → Validar E2E
```

---

## 📋 CHECKLIST DE ENTREGA

### FASE 1: LOCK V2 MODE (30 min)

- [ ] **Remover query param `?v2=true` do endpoint**
  - Arquivo: `routes/appointment.v2.js`
  - Ação: Sempre usar `completeSessionV2`
  
- [ ] **Remover fallback para V1/Legacy no complete**
  - Deletar bloco `appointmentCompleteService.complete`
  
- [ ] **Remover flag `useFinancialGuard` condicional**
  - Sempre usar transaction com Financial Guard

---

### FASE 2: PACKAGE CONSISTÊNCIA (15 min)

Validar em todos os tipos:

| Campo | Particular | Convênio | Liminar |
|-------|------------|----------|---------|
| `sessionsDone` | ✅ incrementa | ✅ incrementa | ✅ incrementa |
| `balance` | ✅ += value | ❌ 0 | ❌ 0 (credit--) |
| `paymentStatus` | unpaid | pending_receipt | paid |

---

### FASE 3: E2E MANUAL (30 min)

Rodar na collection Bruno:

```
04-packages/convenio-flow/ → Cria + Check
04-packages/particular-flow/ → Cria
09-complete-flow/ → Complete + Valida
08-cancel-flow/ → Cancel + Valida
```

**Validações rápidas:**
- [ ] Particular: `balanceAmount = sessionValue`
- [ ] Convênio: `balanceAmount = 0`
- [ ] Liminar: `paymentStatus = paid`
- [ ] Cancel: `sessionsRemaining` restaurado

---

### FASE 4: SANITY CHECK (10 min)

```bash
# 1. Verificar NaN/undefined
node -e "console.log('Check campos:', {balance: typeof 150, sessions: typeof 1})"

# 2. Verificar consistência
# sessionsDone + sessionsRemaining = totalSessions
```

---

## 🔧 IMPLEMENTAÇÃO LOCK V2

### Antes (dualidade):
```javascript
if (useV2Service) {
  result = await completeSessionV2(...)
} else if (useFinancialGuard) {
  result = await completeSessionEventDrivenV2(...)
} else {
  result = await appointmentCompleteService.complete(...) // ❌ LEGACY
}
```

### Depois (V2 only):
```javascript
// 🚀 SEMPRE V2
result = await completeSessionV2(id, { notes, evolution }, session);
```

---

## ⚠️ RISCOS COBERTOS

| Risco | Mitigação |
|-------|-----------|
| V1/V2 paralelo | ❌ Removido - só existe V2 |
| Query param esquecido | ❌ Removido - não depende mais |
| DTO faltando | ✅ Forçado no middleware |
| Balance divergente | ✅ Validação E2E |

---

## ✅ CRITÉRIO DE PRONTO

```
✅ Endpoint sempre retorna DTO V2
✅ Nenhum código legado no caminho
✅ E2E passou em particular/convênio/liminar
✅ Cancel não afeta completed
✅ Sem NaN/undefined nos logs
```

---

## 🚀 PRÓXIMO PASSO

1. **Aplicar LOCK V2** (eu faço agora)
2. **Rodar E2E manual** (você valida)
3. **Deploy** 💀

Quer que eu aplique o LOCK V2 agora?
