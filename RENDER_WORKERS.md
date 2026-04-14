# 🚀 Workers no Render.com

## Arquitetura atual (modularizada por domínio)

Para evitar saturar o Redis, separamos os workers em **grupos isolados**. Cada grupo roda como um Background Worker independente no Render.

```
Web Service:
  crm-backend           → node server.js            (ENABLE_WORKERS=false)

Worker Services (escolha conforme necessidade):
  crm-worker-all        → node workers/startWorkers.js          (ou WORKER_GROUP=all)
  crm-worker-scheduling → node workers/entrypoints/scheduling-worker.js
  crm-worker-billing    → node workers/entrypoints/billing-worker.js
  crm-worker-whatsapp   → node workers/entrypoints/whatsapp-worker.js
  crm-worker-clinical   → node workers/entrypoints/clinical-worker.js
  crm-worker-ops        → node workers/entrypoints/reconciliation-worker.js
```

## O que cada grupo faz?

| Grupo | Workers inclusos | Conexões Redis (est.) |
|-------|------------------|----------------------|
| `scheduling` | appointment, complete, cancel, create, update, integration, syncMedical | 6–10 |
| `billing` | payment, balance, package, invoice, insurance, billingConsumer, dailyClosing, totals | 8–12 |
| `clinical` | patient, patientProjection, clinicalOrchestrator, session | 4–6 |
| `whatsapp` | leadOrchestrator, followup, inbound, outbound, autoReply, contextBuilder, conversationState | 10–15 |
| `reconciliation` | reconciliation, leadRecovery, outbox, integrationOrchestrator | 4–6 |

## Configuração recomendada no Render

### 🟢 Web Service (`crm-backend`)

**Start Command:**
```bash
node server.js
```

**Environment Variables:**
```bash
NODE_ENV=production
ENABLE_WORKERS=false
```

### 🔵 Worker Service (modo simples — 1 worker com tudo)

**Start Command:**
```bash
node workers/startWorkers.js
```

**Environment Variables:**
```bash
NODE_ENV=production
ENABLE_WORKERS=true
WORKER_GROUP=all
```

> ⚠️ O modo `all` ainda consome bastante conexões. Use os grupos separados se o Redis continuar instável.

### 🔵 Worker Services (modo escalável — recomendado)

Crie **1 Background Worker** para cada grupo que você quer isolar:

#### scheduling-worker
```bash
node workers/entrypoints/scheduling-worker.js
```

#### billing-worker
```bash
node workers/entrypoints/billing-worker.js
```

#### clinical-worker
```bash
node workers/entrypoints/clinical-worker.js
```

#### whatsapp-worker
```bash
node workers/entrypoints/whatsapp-worker.js
```

#### reconciliation-worker
```bash
node workers/entrypoints/reconciliation-worker.js
```

## Logs esperados

### Web Service
```
⏭️ Workers desabilitados (ENABLE_WORKERS !== true). Use o serviço de Worker separado.
```

### Worker (ex: billing)
```
🚀 Iniciando Billing Worker...
🟢 Conectando ao MongoDB...
✅ MongoDB conectado
⚙️  Iniciando grupo: billing
[Registry] ✅ Billing workers iniciados
🎉 Billing Worker pronto!
```

## Troubleshooting

### Redis ainda caindo?
1. Verifique no dashboard do Render o limite de conexões do seu plano Redis.
2. Diminua ainda mais: rode só `scheduling` + `billing` como workers, e deixe o resto em `all` num plano maior.
3. Ou use o modo `WORKER_GROUP=scheduling` no `startWorkers.js` sem criar entrypoint separado.

### Worker não inicia
1. Verifique logs no Render Dashboard.
2. Confirme que `MONGODB_URI` está configurada.
3. Se o erro for `Grupo inválido`, verifique `WORKER_GROUP` (válidos: `all`, `scheduling`, `billing`, `clinical`, `whatsapp`, `reconciliation`).

## Teste em produção

```bash
# Complete um agendamento via API
curl -X PATCH https://seu-app.onrender.com/api/v2/appointments/ID/complete \
  -H "Authorization: Bearer TOKEN"

# Verifique os logs do scheduling-worker no Render
# Deve aparecer: "[WORKER] Job X recebido" e "[SUCCESS] Appointment Y completado"
```

## Regras de ouro

- ❌ **NUNCA** rode `ENABLE_WORKERS=true` no Web Service se já tem workers separados
- ✅ Sempre prefira **grupos menores** a um processo gigante
- ✅ Monitore o número de conexões Redis após cada novo worker adicionado
