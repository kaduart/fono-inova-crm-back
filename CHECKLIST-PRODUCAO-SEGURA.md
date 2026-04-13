# ✅ CHECKLIST DE PRODUÇÃO SEGURA

> **Status:** Pós-Refactor sem Transaction  
> **Data:** 10/04/2026  
> **Versão:** 1.0

---

## 🚨 ANTES DE SUBIR PRA PRODUÇÃO

### ✅ 1. TESTES OBRIGATÓRIOS (FLUXO COMPLETO)

Execute na ordem e anote os tempos:

```bash
# 1. CREATE PAYMENT
POST /api/v2/appointments
Esperado: < 50ms
✅ __ms - OK / ❌ Falhou

# 2. UPDATE PAYMENT  
PATCH /api/payments/:id
Esperado: < 100ms
✅ __ms - OK / ❌ Falhou

# 3. COMPLETE APPOINTMENT
PATCH /api/v2/appointments/:id/complete
Esperado: < 100ms
✅ __ms - OK / ❌ Falhou

# 4. CANCEL APPOINTMENT
PATCH /api/v2/appointments/:id/cancel
Esperado: < 50ms
✅ __ms - OK / ❌ Falhou

# 5. LISTAGEM
GET /api/v2/appointments?light=true
Esperado: < 100ms
✅ __ms - OK / ❌ Falhou
```

---

## 🔍 2. VERIFICAÇÃO DE CONSISTÊNCIA (CRÍTICO!)

Após cada operação, verifique no MongoDB:

### Teste de Idempotência (NÃO PODE DUPLICAR)

```javascript
// Execute 3x o mesmo request rapidamente
// Depois verifique:

// 1. Número de payments
 db.payments.countDocuments({appointment: ObjectId("...")})
 // Esperado: 1 (não 3!)

// 2. Número de sessions
 db.sessions.countDocuments({appointment: ObjectId("...")})
 // Esperado: 1 (não 3!)

// 3. Appointment status
 db.appointments.findOne({_id: ObjectId("...")})
 // Esperado: clinicalStatus: "completed" (não "processing_complete")
```

### Teste de Consistência Financeira

```javascript
// Após COMPLETE:
// Verifique se payment.status === appointment.paymentStatus

db.payments.findOne({_id: ...}).status
// Deve bater com:
db.appointments.findOne({_id: ...}).paymentStatus
```

### Teste de Pacote (se usar packages)

```javascript
// Após complete de sessão de pacote:
db.packages.findOne({_id: ...})
// sessionsDone deve ter incrementado em 1
```

---

## 📊 3. LOGS OBRIGATÓRIOS (VERIFICAR NO SERVIDOR)

Execute e procure por estes padrões:

```bash
# Monitore os logs
tail -f back/logs/server.log | grep -E "(⚡|❌|Background|ERRO)"
```

### Logs que DEVEM aparecer (sinais de saúde):

```
✅ [CompleteService] ⚡ Essential done in 85ms
✅ [POST /v2/appointments] ✅ Appointment criado: 45ms
✅ [Payment PATCH] ⚡ Completo em 78ms
✅ [CompleteService] ✅ Background tasks done (245ms)
✅ [cancel] ✅ Evento publicado (async)
```

### Logs que NÃO devem aparecer (sinais de problema):

```
❌ [CompleteService] ⚠️ Background erro
❌ [Payment] Transaction abortada
❌ [appointment] Duplicate key error
❌ ERRO: WriteConflict
❌ Retry attempt 2/8
```

---

## 🔔 4. ALERTAS DE INCONSISTÊNCIA (MONITORAR)

### Query pra detectar problemas:

```javascript
// 1. Appointments "completed" sem payment "paid"
db.appointments.find({
  clinicalStatus: "completed",
  $or: [
    { paymentStatus: { $ne: "paid" } },
    { paymentStatus: { $exists: false } }
  ]
})
// Esperado: 0 resultados

// 2. Sessions "completed" sem isPaid: true
db.sessions.find({
  status: "completed",
  isPaid: { $ne: true }
})
// Esperado: 0 resultados (se for particular)

// 3. Packages com sessionsDone > totalSessions
db.packages.find({
  $expr: { $gt: ["$sessionsDone", "$totalSessions"] }
})
// Esperado: 0 resultados

// 4. Payments duplicados por appointment
db.payments.aggregate([
  { $group: { _id: "$appointment", count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
])
// Esperado: array vazio
```

---

## 🛡️ 5. ROLLBACK PLAN (SE DER MERDA)

### Se detectar inconsistência:

#### Opção A: Reprocessar (menos invasivo)
```javascript
// Re-execute o complete para o appointment problemático
// Via API ou direto no banco
```

#### Opção B: Correção manual (emergência)
```javascript
// Corrigir status específico
 db.appointments.updateOne(
   {_id: ObjectId("...")},
   {$set: {paymentStatus: "paid", clinicalStatus: "completed"}}
 )
```

#### Opção C: Voltar transactions (último recurso)
```bash
# Reverte o arquivo
 git checkout back/routes/appointment.v2.js
 git checkout back/services/appointmentCompleteService.js
# Reinicia server
```

---

## 📈 6. MÉTRICAS DE ACOMPANHAMENTO

Durante 24h após deploy, monitore:

| Métrica | Alerta se... |
|---------|-------------|
| Tempo médio de complete | > 500ms |
| Erros de "Duplicate key" | > 0 |
| Appointments stuck em "processing_*" | > 5 |
| Background errors | > 10/h |
| Payments sem appointment vinculado | > 0 |

---

## ✅ 7. CHECKLIST FINAL (PRA MARCAR)

- [ ] Teste de create executado (< 50ms)
- [ ] Teste de update executado (< 100ms)
- [ ] Teste de complete executado (< 100ms)
- [ ] Teste de cancel executado (< 50ms)
- [ ] Idempotência verificada (não duplicou)
- [ ] Consistência financeira OK
- [ ] Logs sem erros críticos
- [ ] Queries de verificação passaram
- [ ] Rollback plan testado
- [ ] Time notificado das mudanças
- [ ] Documentação atualizada

---

## 🚀 COMANDO ÚNICO DE VALIDAÇÃO

Rode tudo de uma vez:

```bash
#!/bin/bash
echo "🧪 TESTE COMPLETO DE PRODUÇÃO"
echo "=============================="

# Health check
echo "1. Health check..."
curl -s http://localhost:5000/api/health > /dev/null && echo "✅ OK" || echo "❌ FALHOU"

# Criar (assumindo token e dados válidos)
echo "2. Create appointment..."
TIME_CREATE=$(curl -s -w "%{time_total}" -o /tmp/create.json -X POST http://localhost:5000/api/v2/appointments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"patientId":"...","doctorId":"...","date":"2026-04-15","time":"14:00","specialty":"fonoaudiologia"}')
echo "⏱️  ${TIME_CREATE}s"

# Extrair ID
APPT_ID=$(cat /tmp/create.json | grep -o '"appointmentId":"[^"]*"' | cut -d'"' -f4)
echo "🆔 ID: $APPT_ID"

# Complete
echo "3. Complete..."
TIME_COMPLETE=$(curl -s -w "%{time_total}" -X PATCH "http://localhost:5000/api/v2/appointments/${APPT_ID}/complete" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"addToBalance":false}')
echo "⏱️  ${TIME_COMPLETE}s"

echo ""
echo "✅ TESTES CONCLUÍDOS!"
echo "Verifique os tempos acima."
```

---

## 📞 EM CASO DE EMERGÊNCIA

Se tudo der errado:

1. **Pare o deploy**
2. **Colete logs:** `tar -czf logs-emergency.tar.gz back/logs/`
3. **Verifique inconsistências:** rode as queries da seção 4
4. **Decida:** Rollback (Opção C) ou Correção manual (Opção B)
5. **Comunique:** Avise o time no Slack/Discord

---

**Status:** ⏳ Aguardando execução dos testes

**Responsável:** _____________

**Data do deploy:** _____________
