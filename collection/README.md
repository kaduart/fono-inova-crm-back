# 📚 Coleção de Testes - CRM 4.0

Coleções para testar a arquitetura Event-Driven 4.0.

---

## 📁 Formatos Disponíveis

| Formato | Arquivo | Uso |
|---------|---------|-----|
| **Bruno** | `bruno/` | [Bruno](https://www.usebruno.com/) - Open source, git-friendly |
| **Postman** | `crm-4.0-collection.json` | Postman, Insomnia, Hoppscotch |

---

## 🎯 Nomenclatura Event-Driven (IMPORTANTE)

### Eventos de Intenção (REQUESTED)
Disparados pela API quando uma ação é solicitada:

| Evento | Descrição |
|--------|-----------|
| `APPOINTMENT_CREATE_REQUESTED` | Criar agendamento |
| `APPOINTMENT_CANCEL_REQUESTED` | Cancelar agendamento |
| `APPOINTMENT_COMPLETE_REQUESTED` | Completar sessão |
| `PAYMENT_PROCESS_REQUESTED` | Processar pagamento |
| `BALANCE_UPDATE_REQUESTED` | Atualizar saldo |

### Eventos de Resultado (COMPLETED/CANCELED)
Disparados pelos Workers quando processamento termina:

| Evento | Descrição |
|--------|-----------|
| `APPOINTMENT_CREATED` | Agendamento criado |
| `APPOINTMENT_CANCELED` | Agendamento cancelado |
| `APPOINTMENT_COMPLETED` | Sessão completada |
| `PAYMENT_COMPLETED` | Pagamento confirmado |
| `PAYMENT_FAILED` | Pagamento falhou |

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
         65f8a2b3_complete_normal
         65f8a2b3_complete_balance
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

## 🚀 Como Usar

### 1. Configurar Environment

```bash
# Bruno
baseUrl: http://localhost:3000/api
token: seu_jwt_token
patientId: id_do_paciente
doctorId: id_do_profissional
packageId: id_do_pacote
```

### 2. Fazer Request

Todas as requisições 4.0 retornam **202 Accepted**:

```json
{
  "success": true,
  "status": "processing_create",
  "idempotencyKey": "65f8a2b3_create",
  "correlationId": "apt_1712345678_abc123"
}
```

### 3. Fazer Polling

Use **Check Status** até sair do estado `processing_*`:

```javascript
while (response.isProcessing) {
  await sleep(2000);
  response = await fetch(`/appointments/${id}/status`);
}
```

---

## 📋 Fluxos de Teste

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
Complete Session (idempotencyKey: xyz_complete_normal)
  ↓
Complete Session (mesma key)
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

## 🔍 Verificações Pós-Operação

### Cancelamento
```javascript
// Session deve ter:
{
  status: 'canceled',
  originalPartialAmount: 200,  // Preservado!
  originalIsPaid: true         // Preservado!
}

// Payment de pacote NÃO deve estar cancelado (kind: package_receipt)
// Payment particular DEVE estar cancelado
```

### Complete Per-Session
```javascript
// Package deve ter:
{
  sessionsDone: 1,
  totalPaid: 200,
  paidSessions: 1,
  financialStatus: 'partially_paid' | 'paid'
}
```

### Complete Convênio
```javascript
// InsuranceGuide deve ter:
{
  usedSessions: 1,
  status: 'active' | 'exhausted'
}

// Session deve ter:
{
  guideConsumed: true,
  paymentStatus: 'pending_receipt'
}
```

### Complete Liminar
```javascript
// Package deve ter:
{
  liminarCreditBalance: 800,  // Diminuiu
  recognizedRevenue: 200       // Aumentou
}

// Payment deve ter:
{
  kind: 'revenue_recognition',
  paymentMethod: 'liminar_credit',
  status: 'paid'
}
```

---

## 🐛 Debug

### Verificar Workers
```bash
# Redis CLI
redis-cli

# Listar filas
KEYS bull:*

# Ver jobs pendentes
LRANGE bull:complete-orchestrator:wait 0 -1

# Ver DLQ (Dead Letter Queue)
LRANGE bull:cancel-orchestrator:failed 0 -1
```

### Ver Logs Estruturados
```bash
tail -f logs/workers.log | grep "correlationId"
```

### Correlation ID
Todos os endpoints 4.0 aceitam o header:
```
X-Correlation-Id: meu-rastreamento-123
```

Use para rastrear um fluxo completo nos logs.

---

## 🔍 Comparando Legado vs 4.0

### O Legado Retorna
```json
{
  "success": true,
  "data": {
    "appointment": { ... },        // Populado
    "session": { ... },            // Populado
    "payment": { ... }             // Populado
  }
}
```

### O 4.0 Retorna (Async)
```json
{
  "success": true,
  "data": {
    "appointmentId": "...",
    "status": "processing_create"  // Criando async
  }
}
```

### Como Verificar se Funcionou

**Opção 1: Via API (Recomendado)**
```
1. Create Particular (POST /v2/appointments) → 202 Accepted
2. Aguarde 2-3 segundos
3. Get Appointment Full (GET /v2/appointments/:id) → Verifica dados
```

**Opção 2: Via Script**
```bash
cd back && node test-comparativo.js <appointmentId>
```

**Opção 3: Via MongoDB**
```javascript
db.appointments.findOne({_id: ObjectId("...")})
db.sessions.findOne({appointmentId: ObjectId("...")})
db.payments.findOne({appointment: ObjectId("...")})
```

### Validações Importantes

| Check | Legado | 4.0 | Como Verificar |
|-------|--------|-----|----------------|
| Session criada | ✅ Síncrono | ✅ Async | Get Appointment Full |
| Payment criado | ✅ Síncrono | ✅ Async | Get Appointment Full |
| Dados populados | ✅ Completo | ✅ Completo | Get Appointment Full |
| Reaproveitamento | ✅ Funciona | ✅ Funciona | Cancelar e recriar |

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

**Pronto para testar! 🚀**
