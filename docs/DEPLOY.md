# 🚀 Deploy do Novo WhatsAppOrchestrator

## Configuração no Render (PRD)

### 1. Variáveis de Ambiente

Adicione no Render Dashboard:

```bash
# Ativa o novo orquestrador (mas só para canary)
NEW_ORCHESTRATOR=true

# Lista de telefones de teste (seus números)
AMANDA_CANARY_PHONES=5561981694922,556292013573,5562992013573
```

### 2. Deploy Gradual

**Fase 1 - Canary (Agora):**
- Só seus números de teste usam o novo orquestrador
- O resto continua no legado

**Fase 2 - Aumentar (se estiver ok):**
```bash
# Mude para 10% dos leads aleatórios
NEW_ORCHESTRATOR_PERCENTAGE=10
```

**Fase 3 - Full:**
```bash
# Todos usam o novo
NEW_ORCHESTRATOR_PERCENTAGE=100
```

### 3. Rollback

Se der problema:
```bash
NEW_ORCHESTRATOR=false
```

Deploy em 30 segundos e volta ao legado.

## Monitoramento

Verifique os logs no Render:
```
[WhatsAppOrchestrator] DECISION { handler: 'bookingHandler', ... }
```

vs legado:
```
[ORCHESTRATOR] Processando...
```

## Testes antes do Deploy

```bash
# Local
node tests/testDecisionEngine.js

# Com Mongo
node tests/testNewOrchestrator.js
```

✅ Todos devem passar!
