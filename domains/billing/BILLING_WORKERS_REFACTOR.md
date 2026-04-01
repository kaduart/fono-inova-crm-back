# Billing Workers - Refatoração Pós-Análise

## Problema Identificado (documento-analise.txt)

Duplicação de workers no domínio Billing:
- `billingOrchestratorWorker.js` - Orquestrador novo (consome eventos clínicos)
- `insuranceOrchestratorWorker.js` - Orquestrador legado (consome eventos internos)

Ambos faziam orquestração, criando confusão de responsabilidades.

## Solução: Unificação

### Estrutura Final

```
billingOrchestratorWorker.js (ÚNICO ORQUESTRADOR)
├── Handlers de Clinical (ACL)
│   ├── SESSION_COMPLETED → adaptSessionCompleted()
│   └── APPOINTMENT_COMPLETED → adaptAppointmentCompleted()
│
├── Handlers de Insurance (Domínio Interno)
│   ├── INSURANCE_BATCH_CREATED
│   ├── INSURANCE_BATCH_SEALED
│   ├── INSURANCE_BATCH_SENT
│   ├── INSURANCE_ITEM_APPROVED
│   ├── INSURANCE_ITEM_REJECTED
│   ├── INSURANCE_PAYMENT_RECEIVED
│   └── INSURANCE_BATCH_REPROCESS_REQUESTED
│
└── Fila: 'billing-orchestrator'
```

### O que foi unificado

| Funcionalidade | Antes | Depois |
|---------------|-------|--------|
| Eventos Clínicos | billingOrchestratorWorker | billingOrchestratorWorker |
| Eventos Insurance | insuranceOrchestratorWorker | billingOrchestratorWorker |
| Fila | billing-orquestrator + insurance-orchestrator | Apenas billing-orchestrator |
| Inicialização | 2 workers | 1 worker |

### Arquivos

- ✅ `billingOrchestratorWorker.js` - Mantido e enriquecido
- ❌ `insuranceOrchestratorWorker.js` - DEPRECATED (mantido para referência)
- ✅ `SessionCompletedAdapter.js` - ACL mantido

## Integração Clinical↔Billing Validada

### Fluxo de Dados

```
Clinical Domain                          Billing Domain
───────────────                          ──────────────
sessionService
   ↓
SESSION_COMPLETED ─────────────────────→ billingOrchestratorWorker
   (eventPublisher)                         ↓
                                            SessionCompletedAdapter
                                                 ↓
                                            CREATE_INSURANCE_ITEM
                                                 ↓
                                            InsuranceBatch
```

### Pontos de Validação (conforme documento-analise.txt)

✅ **1. Mesma fonte de eventos**
- Event Publisher único: `infrastructure/events/eventPublisher.js`
- Fila: `billing-orchestrator`
- Event Store compartilhado: `models/EventStore.js`

✅ **2. Mesmo schema de evento**
```javascript
SESSION_COMPLETED = {
  sessionId: string,
  patientId: string,
  doctorId: string,
  date: date,
  specialty: string,
  insuranceProvider: string,  // ← Chave para billing
  paymentType: string,        // ← 'convenio' trigger
  ...
}
```

✅ **3. Adapter registrado**
- `billingOrchestratorWorker.js` importa e usa `adaptSessionCompleted`
- Handler: `case 'SESSION_COMPLETED': await handleSessionCompleted(...)`

## Próximos Passos

1. **Testar integração end-to-end**
   - Criar sessão no Clinical
   - Verificar evento SESSION_COMPLETED publicado
   - Confirmar billing processou e criou item

2. **Implementar TISS Worker** (futuro)
   - Geração XML
   - Envio operadora
   - Processamento retorno

3. **Implementar WhatsApp Workers** (próxima prioridade)
   - Ver documento WhatsAppWorkers.md
