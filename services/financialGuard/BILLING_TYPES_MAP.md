# 🏥 MAPEAMENTO DOS TIPOS DE BILLING

## 📋 Resumo dos 4 Tipos

| Tipo | Descrição | Controle Financeiro | Guard Responsável |
|------|-----------|---------------------|-------------------|
| **Particular** | Pagamento direto (PIX, dinheiro, cartão) | Payment individual | `particularGuard` |
| **Pacote** | Sessões pré-pagas (crédito) | Package (sessionsDone) | `packageGuard` |
| **Convênio** | Pagamento via operadora | Guias TISS + Faturamento | `insuranceGuard` (futuro) |
| **Liminar** | Sessões judiciais (indenização) | Liminar (crédito judicial) | `legalGuard` (futuro) |

---

## 💵 1. PARTICULAR

### Características
- Pagamento imediato ou a receber
- Cria `Payment` no banco
- Não tem package
- `billingType: 'particular'`

### CANCEL_APPOINTMENT
```
Se appointment completado:
  → Cancela Payment (status: 'canceled')
  → NÃO restaura nada (não tem package)
```

### COMPLETE_SESSION
```
Se particular:
  → CRIA Payment (pendente/pago)
  → NÃO mexe em package (não existe)
```

### Implementação
✅ **particular.guard.js** - CANCEL implementado  
⚠️ **COMPLETE** - Não precisa de guard (payment criado fora da transaction)

---

## 📦 2. PACOTE

### Características
- Sessões compradas antecipadamente
- Controle via `Package.sessionsDone`
- Pode ser:
  - **Pré-pago total**: Já pago, só consome sessão
  - **Per-session**: Paga conforme usa

### CANCEL_APPOINTMENT
```
Se appointmentStatus === 'completed' && !confirmedAbsence:
  → sessionsDone -= 1
  → Se per-session: totalPaid -= valor, paidSessions -= 1
  → Recalcula balance
```

### COMPLETE_SESSION
```
Se tem crédito disponível (sessionsDone < totalSessions):
  → sessionsDone += 1
  → Se per-session: totalPaid += valor, paidSessions += 1
  → Recalcula balance
  → Cria Payment APENAS se per-session
```

### Regras Críticas
- ❌ NUNCA deixa `sessionsDone > totalSessions`
- ❌ NUNCA duplica consumo (idempotência)
- ✅ Sempre recalcula `balance` e `financialStatus`

### Implementação
✅ **package.guard.js** - CANCEL e COMPLETE implementados

---

## 🏥 3. CONVÊNIO (Insurance)

### Características
- Pagamento via operadora de saúde
- Controle via **Guias TISS**
- Status: `pending_receipt` → `received` → `paid`
- Pode ter glosa (rejeição parcial)

### CANCEL_APPOINTMENT
```
Se appointmentStatus === 'completed':
  → NÃO restaura crédito (convênio não tem package)
  → Marca guia como 'canceled' (se existir)
  → NÃO cancela payment (convênio não cria payment imediato)
  → Evento: INSURANCE_SESSION_CANCELED
```

### COMPLETE_SESSION
```
Se convênio:
  → Cria/atualiza **Guia TISS** (não é Payment!)
  → Status: 'pending_billing'
  → Aguarda envio para operadora
  → NÃO mexe em package
```

### Regras Específicas
- Glosa: pode receber valor menor que o esperado
- Faturamento em lote (não individual)
- Prazo de recebimento: 30-90 dias

### Implementação
⚠️ **insurance.guard.js** - NÃO IMPLEMENTADO (futuro)  
🔜 Prioridade: Média (usar fluxo existente por enquanto)

---

## ⚖️ 4. LIMINAR (Legal)

### Características
- Sessões de indenização judicial
- Controle via **Liminar** (crédito judicial)
- Similar ao package, mas com regras especiais
- Pode ter restrições de uso (ex: só fonoaudiologia)

### CANCEL_APPOINTMENT
```
Se appointmentStatus === 'completed':
  → sessionsDone -= 1 (como package)
  → Marca motivo: 'CANCELADO_LIMINAR'
  → Auditoria extra: log detalhado
  → NÃO gera crédito para paciente (é judicial)
```

### COMPLETE_SESSION
```
Se liminar:
  → sessionsDone += 1 (como package)
  → Verifica se tipo de sessão é permitido
  → Marca origem: 'LIMINAR'
  → NÃO cria Payment (já está pago pela justiça)
```

### Regras Específicas
- Liminar pode expirar (data judicial)
- Pode ter valor máximo por sessão
- Relatórios obrigatórios para justiça

### Implementação
⚠️ **legal.guard.js** - NÃO IMPLEMENTADO (futuro)  
🔜 Prioridade: Baixa (usar package.guard adaptado por enquanto)

---

## 🎯 COMO DETERMINAR O BILLING TYPE

```javascript
function determineBillingType(appointment) {
  if (appointment.billingType === 'insurance') return 'insurance';
  if (appointment.billingType === 'legal') return 'legal';
  if (appointment.package) return 'package';
  return 'particular';
}
```

---

## ✅ STATUS DA IMPLEMENTAÇÃO

| Guard | CANCEL | COMPLETE | Status |
|-------|--------|----------|--------|
| particular | ✅ | N/A* | ✅ Pronto |
| package | ✅ | ✅ | ✅ Pronto |
| insurance | ❌ | ❌ | 🔜 Futuro |
| legal | ❌ | ❌ | 🔜 Futuro |

*Particular no COMPLETE cria payment fora da transaction (não precisa de guard)

---

## 🚨 CENÁRIOS CRÍTICOS PARA TESTAR

### Particular
- [x] Cancelar particular → payment cancelado
- [x] Completar particular → payment criado

### Pacote
- [x] Completar → sessionsDone +1
- [x] Cancelar → sessionsDone -1
- [x] Sem crédito → erro (não completa)
- [x] Per-session → atualiza totalPaid

### Convênio
- [ ] Completar → cria guia TISS
- [ ] Cancelar → marca guia como cancelada
- [ ] Glosa → processa valor reduzido

### Liminar
- [ ] Completar → verifica permissão
- [ ] Cancelar → auditoria judicial
- [ ] Expiração → bloqueia uso

---

## 🔧 PRÓXIMOS PASSOS

1. **Hoje**: Validar particular + package (✅ Feito)
2. **Amanhã**: Implementar insurance.guard (se necessário)
3. **Futuro**: Implementar legal.guard (quando tiver liminar ativa)
