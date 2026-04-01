# 📦 Event Store - Documentação

> **Versão:** 1.0  
> **Status:** Implementado  
> **Data:** 29/03/2026

---

## 🎯 O que é o Event Store?

O Event Store é uma **camada de persistência imutável** que guarda todos os eventos do sistema, permitindo:

- **Audit** completa (quem fez o quê, quando e por quê)
- **Replay** de eventos (reprocessar fluxos)
- **Idempotência** persistente (sobrevive a reinícios)
- **Rastreabilidade** (correlationId → todos os eventos)

---

## 🏗️ Arquitetura

```
┌─────────────────┐
│   Controller    │──┐
└─────────────────┘  │
                     │
┌─────────────────┐  │
│     Worker      │──┤  Publica
└─────────────────┘  │  Evento
                     │
┌─────────────────┐  │
│  Outro Worker   │──┘
└─────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│         EVENT PUBLISHER             │
│                                     │
│  1. Gera eventId (UUID)             │
│  2. PERSISTE no Event Store         │
│  3. ENVIA para fila BullMQ          │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│          EVENT STORE (MongoDB)      │
│                                     │
│  - eventId (UUID)                   │
│  - eventType                        │
│  - aggregateType + aggregateId      │
│  - payload (dados)                  │
│  - metadata (correlationId, user)   │
│  - status (pending → processed)     │
│  - sequenceNumber (ordem)           │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│         REDIS / BULLMQ              │
│                                     │
│  Filas por domínio:                 │
│  - appointment-processing           │
│  - update-orchestrator              │
│  - complete-orchestrator            │
│  - notification                     │
│  - etc...                           │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│           WORKERS                   │
│                                     │
│  - Consomem da fila                 │
│  - Verificam idempotência           │
│  - Processam regra de negócio       │
│  - Atualizam Event Store            │
│  - Publicam novos eventos           │
└─────────────────────────────────────┘
```

---

## 📋 Schema do Event Store

```javascript
{
  // Identificação
  eventId: "uuid-v7",           // UUID único do evento
  eventType: "APPOINTMENT_CREATED",
  eventVersion: 1,              // Versão do schema
  
  // Aggregate (entidade)
  aggregateType: "appointment", // appointment, lead, patient, etc
  aggregateId: "123",           // ID da entidade
  sequenceNumber: 5,            // Ordem no aggregate
  
  // Dados
  payload: {                    // Dados específicos do evento
    patientId: "...",
    doctorId: "...",
    date: "2026-03-30T10:00:00Z"
  },
  
  // Metadados
  metadata: {
    correlationId: "uuid",      // Rastreia fluxo completo
    causationId: "uuid",        // ID do evento que causou este
    source: "appointmentController",
    userId: "...",
    userEmail: "...",
    ip: "...",
    userAgent: "...",
    featureFlags: { ... }
  },
  
  // Controle de processamento
  status: "processed",          // pending, processing, processed, failed, dead_letter
  processedAt: Date,
  processedBy: "workerName",
  attempts: 0,
  
  // Erro (se falhou)
  error: {
    message: "...",
    stack: "...",
    code: "..."
  },
  
  // Idempotência
  idempotencyKey: "123_create",
  
  // Timestamps
  createdAt: Date,              // Quando o evento ocorreu
  expiresAt: Date               // TTL (opcional)
}
```

---

## 🔄 Fluxo de Vida do Evento

```
┌──────────┐    ┌────────────┐    ┌────────────┐    ┌──────────┐    ┌──────────┐
│  PENDING │───▶│ PROCESSING │───▶│  PROCESSED │    │  FAILED  │───▶│    DLQ   │
└──────────┘    └────────────┘    └────────────┘    └──────────┘    └──────────┘
       │               │                  │                │
       │               │                  │                │
       │               │                  │                └── 3 tentativas
       │               │                  │
       │               │                  └── Sucesso
       │               │
       │               └── Worker pega
       │
       └── Criado pelo Event Publisher
```

---

## 🛡️ Idempotência

### Como funciona:

1. **Geração:** Cada evento recebe um `idempotencyKey` único
   ```
   {aggregateId}_{action}
   exemplo: "123_create", "123_update", "123_complete"
   ```

2. **Verificação:** Antes de processar, worker verifica se já existe
   ```javascript
   if (await eventExists(idempotencyKey)) {
     return { idempotent: true };
   }
   ```

3. **Persistência:** Event Store garante unicidade via índice

### Vantagens:

- ✅ Sobrevive a reinícios do servidor
- ✅ Funciona em múltiplas instâncias
- ✅ Auditável (sabe quando foi duplicado)

---

## 📊 Uso

### Publicar Evento

```javascript
import { publishEvent, EventTypes } from './infrastructure/events/eventPublisher.js';

const result = await publishEvent(
  EventTypes.APPOINTMENT_CREATED,
  {
    patientId: "123",
    doctorId: "456",
    date: "2026-03-30T10:00:00Z"
  },
  {
    correlationId: "corr_123",
    metadata: {
      userId: "user_789",
      source: "appointmentController"
    }
  }
);

// Retorna:
// {
//   eventId: "uuid",
//   eventType: "APPOINTMENT_CREATED",
//   jobId: "bullmq_job_id",
//   eventStoreId: "mongo_document_id"
// }
```

### Processar Evento (Worker)

```javascript
import { 
  markEventProcessed, 
  markEventFailed,
  eventExists 
} from './infrastructure/events/eventStoreService.js';

const worker = new Worker('appointment-processing', async (job) => {
  const { eventId, idempotencyKey, payload } = job.data;
  
  // 1. Verifica idempotência
  if (await eventExists(idempotencyKey)) {
    return { idempotent: true };
  }
  
  try {
    // 2. Processa
    await processAppointment(payload);
    
    // 3. Marca como processado
    await markEventProcessed(eventId, 'appointmentWorker');
    
  } catch (error) {
    // 4. Marca como falho
    await markEventFailed(eventId, error);
    throw error;
  }
});
```

### Replay de Eventos

```bash
# Estatísticas
node scripts/replay-events.js --stats

# Eventos pendentes
node scripts/replay-events.js --pending

# Replay de um aggregate específico
node scripts/replay-events.js --aggregate=appointment --id=123

# Replay por tipo de evento
node scripts/replay-events.js --eventType=APPOINTMENT_CREATED --from=2026-03-01
```

### Query de Eventos

```javascript
import EventStore from './models/EventStore.js';

// Timeline de um aggregate
const timeline = await EventStore.findByAggregate('appointment', '123');

// Busca por correlationId
const events = await findByCorrelation('corr_123');

// Último evento de um aggregate
const last = await EventStore.findLastByAggregate('appointment', '123');
```

---

## 🎨 Decisões de Design

### 1. Append-Only
- Eventos **nunca** são deletados ou atualizados
- Status muda (pending → processed), mas o documento permanece

### 2. Sequence Number
- Garante ordem dentro de um aggregate
- Útil para replay e consistência

### 3. Separação de Responsabilidades
- **Event Publisher:** Publica eventos (persiste + enfileira)
- **Event Store:** Persiste eventos
- **Workers:** Processam eventos

### 4. TTL (Time to Live)
- Eventos podem ter data de expiração
- MongoDB remove automaticamente
- Útil para não acumular dados infinitamente

---

## 📈 Índices

```javascript
// Query principal (por aggregate)
{ aggregateType: 1, aggregateId: 1, sequenceNumber: 1 }

// Query por tipo e período (analytics)
{ eventType: 1, createdAt: -1 }

// Query por status (reprocessamento)
{ status: 1, createdAt: 1 }

// Query por correlation (rastreabilidade)
{ 'metadata.correlationId': 1, createdAt: 1 }

// Idempotência
{ idempotencyKey: 1 }  // unique, sparse

// TTL
{ expiresAt: 1 }  // expireAfterSeconds: 0
```

---

## 🔒 Segurança

### Proteções:

1. **Idempotência:** Não processa eventos duplicados
2. **Dead Letter Queue:** Eventos que falham múltiplas vezes são isolados
3. **Replay Controlado:** Só replay com permissões adequadas
4. **Audit Trail:** Tudo é registrado (quem, quando, o quê)

---

## 📊 Monitoramento

### Métricas Importantes:

```javascript
// Estatísticas gerais
const stats = await EventStore.getStats();
// Retorna:
// [
//   { _id: 'processed', total: 1000, types: [...] },
//   { _id: 'pending', total: 10, types: [...] },
//   { _id: 'failed', total: 5, types: [...] }
// ]

// Eventos pendentes (alerta se > 100)
const pending = await getPendingEvents({ limit: 100 });

// Eventos antigos não processados
const stuck = await EventStore.find({
  status: 'pending',
  createdAt: { $lt: new Date(Date.now() - 60 * 60 * 1000) } // > 1h
});
```

---

## 🚀 Próximos Passos

- [ ] Implementar Event Store em todos os workers
- [ ] Dashboard de monitoramento
- [ ] Alertas automáticos (eventos pendentes, falhas)
- [ ] Compressão de eventos antigos
- [ ] Snapshot de aggregates (para replay rápido)

---

## 📚 Referências

- [Event Sourcing Pattern](https://microservices.io/patterns/data/event-sourcing.html)
- [CQRS](https://martinfowler.com/bliki/CQRS.html)
- [Idempotency Keys](https://brandur.org/idempotency-keys)
