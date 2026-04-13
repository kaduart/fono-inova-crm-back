# ✅ V2 Stability Checklist

> Checklist de estabilidade do sistema V2

---

## 🎯 Core Engine (BACKEND)

### Complete Session V2
- [x] `completeSessionService.v2.js` criado e testado
- [x] Atualização de `sessionsDone` no Package
- [x] Atualização de `balance` no Package
- [x] Atualização de `balanceAmount` no Appointment
- [x] Atualização de `paymentStatus` no Appointment
- [x] Idempotência funcionando (não completa 2x)
- [x] Validação de estado (não completa canceled)
- [x] Transaction MongoDB garantindo consistência

### Cancel Session V2
- [x] Async flow (202 Accepted)
- [x] Workers processando cancelamento
- [x] Restauração de `sessionsRemaining`
- [x] Idempotência (409 em retry)
- [x] Proteção RN clínica (não cancela completed)

---

## 📋 API Contract

### DTOs Padronizados
- [x] Resposta de sucesso (200)
- [x] Resposta idempotente (409)
- [x] Resposta de erro (400)
- [x] Campos consistentes por tipo de package

### Documentação
- [x] `API_CONTRACT_V2.md` criado
- [x] Contrato de request/response definido
- [x] Estados válidos documentados
- [x] Fonte de verdade explicada

---

## 🧪 Test Coverage

### Cenários de Teste
- [x] Particular per-session (gera dívida)
- [x] Convênio (sem débito imediato)
- [x] Liminar (consome crédito)
- [x] Cancelamento de scheduled
- [x] Tentativa de cancelar completed (erro)
- [x] Idempotência de cancelamento

### Validações Automatizadas
- [x] `sessionsDone` incrementado
- [x] `balance`/`balanceAmount` consistente
- [x] `paymentStatus` correto por tipo
- [x] `operationalStatus` atualizado

---

## 🔧 Campos Normalizados

### Package
```javascript
{
  sessionsDone: Number,        // ✅ Padronizado
  balance: Number,             // ✅ Verdade financeira agregada
  financialStatus: String,     // ✅ unpaid | paid | etc
  type: String                 // ✅ therapy | convenio | liminar
}
```

### Appointment
```javascript
{
  operationalStatus: String,   // ✅ scheduled | completed | canceled
  clinicalStatus: String,      // ✅ scheduled | completed | canceled
  paymentStatus: String,       // ✅ unpaid | paid | pending_receipt
  balanceAmount: Number,       // ✅ Snapshot financeiro
  sessionValue: Number         // ✅ Valor da sessão
}
```

---

## 📊 Estado do Sistema

### O que está funcionando
✅ Engine financeira V2 (per-session)
✅ **LOCK V2 MODE** - Sem dualidade V1/V2
✅ Cancelamento assíncrono V2
✅ Consistência entre Package e Appointment
✅ Idempotência em operações críticas
✅ DTO em todas as respostas
✅ Validações de regras de negócio

### O que precisa de atenção
⚠️ Package balance vs Appointment balanceAmount (documentado)
⚠️ sessionsRemaining calculado dinamicamente (não persistido)

---

## 🚀 Próximos Passos Sugeridos

### Alta Prioridade
- [x] **LOCK V2 MODE** - Remover dualidade V1/V2
- [x] Implementar DTO no endpoint (refactor response)
- [x] Adicionar testes automatizados (Jest)
- [ ] Criar monitor de inconsistências

### Média Prioridade
- [ ] Documentar decision log (por que cada campo existe)
- [ ] Criar migration para dados legados
- [ ] Adicionar métricas de performance

### Baixa Prioridade
- [ ] Refactor V1 para usar mesmo padrão
- [ ] Criar dashboard de saúde do sistema

---

## 💀 Status Final

```
Sistema V2: ✅ PRODUCTION READY (LOCK V2 MODE)

Engine financeira:   ✅ Estável
LOCK V2 MODE:        ✅ Sem dualidade
Cancel flow:         ✅ Estável
API Contract:        ✅ DTO garantido
Consistência:        ✅ Validada
Testes:              ✅ Funcionando
```

**Data:** 2026-04-12
**Versão:** v2.0-stable
