# 🛡️ HARDENING DE PRODUÇÃO - CRM 4.0

## Resumo do que foi implementado

### ✅ 1. OUTBOX PATTERN (Anti-perda de eventos)

**Arquivos:**
- `models/Outbox.js` - Modelo para persistir eventos
- `workers/outboxWorker.js` - Processa eventos do MongoDB pro Redis

**Como funciona:**
```
API → Salva no Mongo (Outbox) → Commit → Worker publica no Redis
```

Se o servidor cair entre salvar e publicar → evento está salvo no Mongo!

**Worker iniciado:** `startOutboxWorker()` em `workers/index.js`

---

### ✅ 2. REDIS LOCK (Anti-race condition)

**Arquivo:** `utils/redisLock.js`

**Funções:**
- `acquireLock(resource, ttl)` - Adquire lock
- `releaseLock(resource, token)` - Libera lock
- `withLock(resource, fn, options)` - Executa função com lock

**Uso:**
```javascript
import { withLock } from './utils/redisLock.js';

await withLock(`appointment:${id}`, async () => {
  await completeAppointment(id);
}, { ttl: 30 });
```

---

### ✅ 3. DLQ + REPROCESSAMENTO

**Script:** `scripts/reprocess-dlq.js`

**Comandos:**
```bash
# Listar jobs na DLQ
node scripts/reprocess-dlq.js

# Reprocessar tudo
node scripts/reprocess-dlq.js --all

# Reprocessar evento específico
node scripts/reprocess-dlq.js --event=EVENT_ID

# Filtrar por fila
node scripts/reprocess-dlq.js --queue=complete-orchestrator
```

---

### ✅ 4. LOGGER ESTRUTURADO

**Arquivo:** `utils/logger.js`

**Uso básico:**
```javascript
import { logger } from './utils/logger.js';

logger.info('create', 'appointment_created', { appointmentId: '123' });
// [2026-03-28T00:00:00.000Z] ℹ️ [create] appointment_created: { appointmentId: '123' }
```

**Com correlationId:**
```javascript
import { createContextLogger } from './utils/logger.js';

const log = createContextLogger('corr-123', 'complete');
log.info('session_saved', 'Sessão salva', { sessionId: '456' });
// Inclui correlationId automaticamente nos metadados
```

---

### ✅ 5. HEALTH CHECK V2

**Rota:** `GET /api/v2/health`

**Resposta:**
```json
{
  "success": true,
  "timestamp": "2026-03-28T00:00:00.000Z",
  "version": "4.0.0",
  "checks": {
    "mongodb": true,
    "redis": true,
    "queues": {
      "appointment-processing": { "status": "ok", "waiting": 0, "active": 0, "failed": 0 },
      "complete-orchestrator": { "status": "ok", "waiting": 0, "active": 0, "failed": 0 }
    }
  }
}
```

---

## 🧪 Como Testar

### 1. Health Check
```bash
# No Bruno
GET {{baseUrl}}/v2/health

# Ou curl
curl http://localhost:5000/api/v2/health
```

### 2. Script de Testes Automatizado
```bash
cd back
node scripts/test-hardening.js
```

Testa:
- ✅ Redis Lock (acquire/release)
- ✅ Redis Lock (concorrência)
- ✅ withLock wrapper
- ✅ Logger estruturado
- ✅ Outbox (criação/persistência)
- ✅ Health (MongoDB + Redis)

### 3. Teste Manual Completo
1. Create Particular
2. Aguardar scheduled
3. Complete Session
4. Verificar confirmed
5. Criar novo e Cancel
6. Verificar canceled

---

## 📊 Status dos Workers

```
[Workers] Iniciando workers...

[PaymentWorker] Worker iniciado (com Saga Pattern)
[BalanceWorker] Worker iniciado
[PackageValidationWorker] Worker iniciado
[AppointmentWorker] Worker iniciado
[CreateAppointmentWorker] Worker iniciado
[CancelOrchestrator] Worker iniciado
[CompleteOrchestrator] Worker iniciado
[OutboxWorker] Worker iniciado  ← NOVO

[Workers] Todos os workers iniciados!
```

---

## 🚨 O que falta pra deploy real

### Recomendado fazer antes:

1. **Testar cenários financeiros**
   - Particular completo
   - Pacote pré-pago
   - Pacote per-session
   - Convênio

2. **Simular falhas**
   - Matar worker no meio do processamento
   - Verificar se recupera
   - Verificar DLQ

3. **Monitoramento**
   - Dashboard de filas
   - Alerta de DLQ
   - Métricas de latência

4. **Backup do Outbox**
   - Script para arquivar eventos antigos
   - Retenção de 30 dias

---

## 🎯 Comando Rápido

```bash
# Testar tudo
cd back && npm run dev &
sleep 5
node scripts/test-hardening.js

# Ver filas
curl http://localhost:5000/api/v2/health | jq

# Reprocessar DLQ
node scripts/reprocess-dlq.js --all
```

---

**Sistema blindado!** 🛡️
