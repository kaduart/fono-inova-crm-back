# 📚 Coleção Bruno - CRM 4.0 Event-Driven

> Arquitetura 4.0 com Event-Driven, Workers e Idempotência

---

## 🎯 Nomenclatura Event-Driven

### Eventos de Intenção (REQUESTED)
Disparados pela API quando uma ação é solicitada:

```
APPOINTMENT_CREATE_REQUESTED
APPOINTMENT_CANCEL_REQUESTED
APPOINTMENT_COMPLETE_REQUESTED
PAYMENT_PROCESS_REQUESTED
BALANCE_UPDATE_REQUESTED
```

### Eventos de Resultado (COMPLETED/CANCELED/FAILED)
Disparados pelos Workers quando processamento termina:

```
APPOINTMENT_CREATED
APPOINTMENT_CANCELED
APPOINTMENT_COMPLETED
PAYMENT_COMPLETED
PAYMENT_FAILED
```

---

## 🔄 Estados de Processamento

Durante o processamento async, o agendamento fica em estado intermediário:

```javascript
// Criação
processing_create → scheduled

// Cancelamento  
processing_cancel → canceled

// Complete
processing_complete → confirmed + completed
```

### Guards de Concorrência

Se tentar executar ação enquanto está `processing_*`:

```json
{
  "success": false,
  "error": "Cancelamento já em andamento",
  "status": "processing_cancel"
}
```

---

## 🛡️ Idempotência

Toda requisição gera uma `idempotencyKey` automaticamente:

```
Formato: {appointmentId}_{action}
Exemplo: 65f8a2b3_cancel
```

### Para Requisições Customizadas

Envie no header:
```
X-Idempotency-Key: minha-chave-custom-123
```

### Comportamento

Reenviar mesma key retorna sucesso sem duplicar:
```json
{
  "status": "already_processed",
  "idempotent": true
}
```

---

## 📋 Fluxos de Teste Recomendados

### 1️⃣ Particular Avulso
```
Create Particular (202 Accepted)
  ↓
Check Status (polling até scheduled)
  ↓
Complete Session (202 Accepted)
  ↓
Check Status (polling até completed)
```

### 2️⃣ Pacote com Reaproveitamento
```
Create Package → Session criada (isPaid: true)
  ↓
Cancel Appointment (preserva original*)
  ↓
Create Package (mesmo pacote) → Reaproveita crédito!
  ↓
Complete Session
```

### 3️⃣ Fiado (Add to Balance)
```
Create Particular
  ↓
Complete with Balance (addToBalance: true)
  ↓
Get Patient Balance (deve mostrar débito)
```

### 4️⃣ Idempotência
```
Complete Session
  ↓
Complete Session (mesma idempotencyKey)
  ↓
Retorna: already_processed (não duplicou!)
```

---

## 🔍 Headers Importantes

| Header | Obrigatório | Descrição |
|--------|-------------|-----------|
| `Authorization` | Sim | Bearer token JWT |
| `X-Correlation-Id` | Não | Rastreamento distribuído (gerado se não informado) |
| `X-Idempotency-Key` | Não | Evita duplicidade (gerado automaticamente) |

---

## 🐛 Debug

### Verificar Workers
```bash
# Redis CLI
redis-cli

# Listar filas
KEYS bull:*

# Ver jobs pendentes
LRANGE bull:cancel-orchestrator:wait 0 -1

# Ver jobs ativos
LRANGE bull:cancel-orchestrator:active 0 -1

# Ver DLQ (Dead Letter Queue)
LRANGE bull:cancel-orchestrator:failed 0 -1
```

### Ver Logs Estruturados
```bash
tail -f logs/workers.log | grep "correlationId"
```

---

## ✅ Checklist de Validação

- [ ] Create retorna 202 (não 201)
- [ ] Status inicial é `processing_*`
- [ ] IdempotencyKey retornada no response
- [ ] Polling funciona (Check Status)
- [ ] Reaproveitamento de crédito funciona
- [ ] Cancelamento preserva `original*`
- [ ] Idempotência evita duplicidade
- [ ] DLQ captura falhas

---

**Pronto para testar a arquitetura 4.0! 🚀**
