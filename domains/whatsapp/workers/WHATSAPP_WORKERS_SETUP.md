# WhatsApp Workers - Setup Completo

Baseado no documento-analise.txt (Ponto 2)

## Arquitetura de Workers

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WHATSAPP DOMAIN                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   FLUXO COMPLETO:                                                           │
│                                                                              │
│   1. MessageBufferWorker           4. OrchestratorWorker                    │
│      Fila: whatsapp-message-buffer    Fila: whatsapp-orchestrator          │
│      ├── Lock Global (Redis)          ├── Context Window (12 msgs)          │
│      ├── Idempotência (MD5)           ├── Intent Classification            │
│      └── Debounce (2s)                └── Escalation Rules                 │
│              ↓                                    ↓                         │
│   2. LeadStateWorker               5. NotificationWorker                    │
│      Fila: whatsapp-lead-state        Fila: whatsapp-notification          │
│      ├── Recarrega Estado             ├── Formatação                        │
│      ├── Manual Control Check         ├── Rate Limiting (20/min)           │
│      ├── Inactivity Timeout           ├── Retry (3x backoff)               │
│      └── Kill Switch                  └── Outbox Pattern                   │
│              ↓                                    ↓                         │
│   3. [Pass-through]                6. RealtimeWorker                        │
│      Event: ORCHESTRATOR_RUN_REQUESTED Fila: whatsapp-realtime             │
│                                              ├── Socket.io Rooms           │
│                                              ├── Broadcast                 │
│                                              ├── Dashboard Stats           │
│                                              └── Offline Queue             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Workers

### 1. MessageBufferWorker
**Fila**: `whatsapp-message-buffer`  
**Evento de Entrada**: `WHATSAPP_MESSAGE_RECEIVED` (do webhook)  
**Evento de Saída**: `LEAD_STATE_CHECK_REQUESTED`

**Regras**:
- RN-WHATSAPP-001: Lock global (Redis SET NX + TTL 30s)
- RN-WHATSAPP-002: Buffer de mensagens temporário
- RN-WHATSAPP-003: Idempotência (MD5 do conteúdo, 10s window)
- RN-WHATSAPP-004: Debounce (agrupa msgs em 2s)

**Por que**: Proteção contra flood, duplicatas e mensagens fragmentadas

---

### 2. LeadStateWorker
**Fila**: `whatsapp-lead-state`  
**Evento de Entrada**: `LEAD_STATE_CHECK_REQUESTED`  
**Evento de Saída**: `ORCHESTRATOR_RUN_REQUESTED`

**Regras**:
- RN-WHATSAPP-005: Recarregar estado do lead (último contexto)
- RN-WHATSAPP-006: Verificar controle manual (bloqueio humano)
- RN-WHATSAPP-007: Timeout de inatividade (30min → reset contexto)
- RN-WHATSAPP-008: Kill switch global (emergência)

**Por que**: Garantir que Amanda tenha contexto correto e respeitar controle humano

---

### 3. OrchestratorWorker (Amanda AI)
**Fila**: `whatsapp-orchestrator`  
**Evento de Entrada**: `ORCHESTRATOR_RUN_REQUESTED`  
**Evento de Saída**: `NOTIFICATION_REQUESTED`

**Regras**:
- RN-WHATSAPP-009: Context window (últimas 12 mensagens)
- RN-WHATSAPP-010: First contact detection (novo lead → boas-vindas)
- RN-WHATSAPP-011: Intent classification (classificar intenção)
- RN-WHATSAPP-012: Escalation rules (quando chamar humano)

**Por que**: Centralizar decisão da IA e garantir qualidade das respostas

---

### 4. NotificationWorker
**Fila**: `whatsapp-notification`  
**Evento de Entrada**: `NOTIFICATION_REQUESTED`  
**Evento de Saída**: `MESSAGE_SENT`

**Regras**:
- RN-WHATSAPP-013: Formatação de mensagens
- RN-WHATSAPP-014: Rate limiting (20 msg/min por número)
- RN-WHATSAPP-015: Retry com backoff (3 tentativas)
- RN-WHATSAPP-016: Outbox pattern (garantia de entrega)

**Por que**: Garantir entrega e não ser bloqueado pelo WhatsApp

---

### 5. RealtimeWorker
**Fila**: `whatsapp-realtime`  
**Evento de Entrada**: `MESSAGE_SENT`  
**Eventos Socket**: `new_message`, `conversation_update`, `dashboard_stats`

**Regras**:
- RN-WHATSAPP-017: Socket.io rooms (salas por lead)
- RN-WHATSAPP-018: Broadcast seletivo (só para quem precisa)
- RN-WHATSAPP-019: Dashboard aggregation (métricas em tempo real)
- RN-WHATSAPP-020: Offline handling (queue para reconexão)

**Por que**: UI em tempo real sem bloquear fluxo principal

## Setup

```javascript
import { 
  createMessageBufferWorker,
  createLeadStateWorker,
  createOrchestratorWorker,
  createNotificationWorker,
  createRealtimeWorker
} from './domains/whatsapp/workers/index.js';

// Inicializar workers
const workers = [
  createMessageBufferWorker({ redis, publishEvent }),
  createLeadStateWorker({ Lead, redis, publishEvent }),
  createOrchestratorWorker({ aiService, redis, publishEvent }),
  createNotificationWorker({ whatsappProvider, redis, publishEvent, saveToOutbox }),
  createRealtimeWorker({ io, redis, analyticsService })
];

// Graceful shutdown
process.on('SIGTERM', async () => {
  await Promise.all(workers.map(w => w.close()));
});
```

## Mapeamento de Regras

| Regra | Worker | Implementação |
|-------|--------|---------------|
| RN-WHATSAPP-001 | MessageBufferWorker | `acquireLock(redis, key, ttl)` |
| RN-WHATSAPP-002 | MessageBufferWorker | Buffer temporário em Redis |
| RN-WHATSAPP-003 | MessageBufferWorker | `crypto.createHash('md5')` |
| RN-WHATSAPP-004 | MessageBufferWorker | `addToDebounceBuffer()` |
| RN-WHATSAPP-005 | LeadStateWorker | `Lead.findOne({ phone })` |
| RN-WHATSAPP-006 | LeadStateWorker | `checkManualControl()` |
| RN-WHATSAPP-007 | LeadStateWorker | `INACTIVITY_TIMEOUT = 30min` |
| RN-WHATSAPP-008 | LeadStateWorker | `redis.get(KILL_SWITCH_KEY)` |
| RN-WHATSAPP-009 | OrchestratorWorker | `buildContextWindow(12)` |
| RN-WHATSAPP-010 | OrchestratorWorker | `isNewLead` check |
| RN-WHATSAPP-011 | OrchestratorWorker | `classifyIntent()` |
| RN-WHATSAPP-012 | OrchestratorWorker | `checkEscalationRules()` |
| RN-WHATSAPP-013 | NotificationWorker | `formatMessage()` |
| RN-WHATSAPP-014 | NotificationWorker | `checkRateLimit(20/min)` |
| RN-WHATSAPP-015 | NotificationWorker | Backoff exponencial no BullMQ |
| RN-WHATSAPP-016 | NotificationWorker | `saveToOutbox()` |
| RN-WHATSAPP-017 | RealtimeWorker | `io.to(\`lead:${leadId}\`)` |
| RN-WHATSAPP-018 | RealtimeWorker | `io.to('attendees')` |
| RN-WHATSAPP-019 | RealtimeWorker | `updateDashboardStats()` |
| RN-WHATSAPP-020 | RealtimeWorker | `queueForOfflineUsers()` |

## Prioridades de Fila

| Worker | Prioridade | Concorrência | Crítico? |
|--------|------------|--------------|----------|
| MessageBufferWorker | Alta | 20 | Sim (anti-flood) |
| LeadStateWorker | Alta | 10 | Sim |
| OrchestratorWorker | Média | 5 | Sim (IA limitada) |
| NotificationWorker | Média | 10 | Sim (rate limit) |
| RealtimeWorker | Baixa | 20 | Não (best-effort) |

## Próximos Passos

1. **Testar integração**: Criar testes de ponta a ponta
2. **Implementar aiService**: Conector com OpenAI/Claude
3. **Configurar BullMQ Dashboard**: Monitoramento das filas
4. **Métricas**: Prometheus/Grafana para workers
