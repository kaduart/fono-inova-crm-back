# Clinical Workers Setup

## Visão Geral

Workers do domínio clínico implementando arquitetura event-driven.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Appointment   │────▶│  Orchestrator    │────▶│     Session     │
│    Service      │     │     Worker       │     │     Service     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                       │                          │
         ▼                       ▼                          ▼
   APPOINTMENT_          Decide criar/          SESSION_COMPLETED
   SCHEDULED             atualizar/cancelar     SESSION_CANCELLED
   APPOINTMENT_                                    │
   RESCHEDULED                                     ▼
   APPOINTMENT_                           ┌──────────────────┐
   CANCELLED                              │   SessionWorker  │
                                          └──────────────────┘
                                                   │
                           ┌───────────────────────┼───────────────────────┐
                           ▼                       ▼                       ▼
                    ┌─────────────┐        ┌─────────────┐        ┌─────────────┐
                    │  Analytics  │        │   Calendar  │        │  Notification│
                    │   Service   │        │   Service   │        │   Service   │
                    └─────────────┘        └─────────────┘        └─────────────┘
```

## Workers

### 1. Clinical Orchestrator Worker

**Papel**: Decisão e coordenação entre Appointments e Sessions

**Fila**: `clinical-orchestrator`

**Eventos Consumidos**:
- `APPOINTMENT_SCHEDULED` → Cria sessão vinculada
- `APPOINTMENT_RESCHEDULED` → Atualiza sessão
- `APPOINTMENT_CANCELLED` → Cancela sessão

**Regras**:
- RN-ORCHESTRATOR-001: Se serviceType='session' → criar SESSION
- RN-ORCHESTRATOR-002: Se serviceType='evaluation' → criar SESSION
- RN-ORCHESTRATOR-003: Se vinculado a package → verificar créditos
- RN-ORCHESTRATOR-004/005/006: Remarcação com consistência
- RN-ORCHESTRATOR-007/008/009: Cancelamento com validação

**Por que separado?**
- Mantém consistência entre Appointment e Session
- Centraliza decisões de negócio
- Facilita debugging de fluxos

### 2. Session Worker

**Papel**: Side effects de eventos de sessão

**Fila**: `clinical-session`

**Eventos Consumidos**:
- `SESSION_COMPLETED` → Métricas, notificações, calendário
- `SESSION_CANCELLED` → Métricas, liberação de slot

**Regras**:
- RN-SESSION-WORKER-001/002: Atualizar métricas de produção
- RN-SESSION-WORKER-003: Notificar paciente
- RN-SESSION-WORKER-004/006: Gerenciar slots do calendário
- RN-SESSION-WORKER-005/007: Registrar cancelamentos

**Por que separado?**
- Side effects são independentes da lógica principal
- Pode falhar sem afetar a consistência dos dados
- Permite retry separado

## Setup

```javascript
import { createClinicalOrchestrator, createSessionWorker } from './workers/index.js';
import { sessionService, appointmentService, analyticsService } from './services/index.js';

// Inicializar workers
const orchestratorWorker = createClinicalOrchestrator({
  sessionService,
  appointmentService,
  eventStore
});

const sessionWorker = createSessionWorker({
  analyticsService,
  calendarService,
  notificationService
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await orchestratorWorker.close();
  await sessionWorker.close();
});
```

## Mapeamento Eventos → Workers

| Evento | Fila | Worker |
|--------|------|--------|
| APPOINTMENT_SCHEDULED | clinical-orchestrator | ClinicalOrchestrator |
| APPOINTMENT_RESCHEDULED | clinical-orchestrator | ClinicalOrchestrator |
| APPOINTMENT_CANCELLED | clinical-orchestrator | ClinicalOrchestrator |
| SESSION_COMPLETED | clinical-session | SessionWorker |
| SESSION_CANCELLED | clinical-session | SessionWorker |

## Retry Policy

- **Orchestrator**: 3 tentativas com backoff exponencial
  - Falha em consistência → Alerta crítico
  - Falha em verificação de créditos → Requeue
  
- **Session Worker**: 5 tentativas
  - Falha em side effects → Log warning (não crítico)
  - Analytics pode ser recalculado depois

## Métricas

- `clinical_orchestrator_jobs_processed`
- `clinical_orchestrator_consistency_errors`
- `clinical_session_side_effects_completed`
- `clinical_session_side_effects_failed`
