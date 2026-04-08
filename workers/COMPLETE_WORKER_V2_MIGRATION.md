# Complete Orchestrator Worker v2.0 - Migração

## 🚨 Problemas Corrigidos

### 1. 🔴 Conexão MongoDB (CRÍTICO)
**Problema:** Worker não garantia conexão com MongoDB
**Solução:** `ensureMongoConnection()` - conecta antes de processar e verifica a cada job

### 2. 🔴 Liberação de Lock (CRÍTICO)
**Problema:** Se worker falhasse, appointment ficava preso em `processing_complete`
**Solução:** `releaseAppointmentLock()` - libera automaticamente no `catch` e no `failed` handler

### 3. 🔴 Payment Fora da Transação (ALTO)
**Problema:** Payment criado fora da transação principal
**Solução:** Payment agora criado dentro da transação MongoDB

### 4. 🔴 Lock TTL Baixo (MÉDIO)
**Problema:** TTL de 30s podia expirar durante processamento
**Solução:** TTL aumentado para 180s

### 5. 🔴 Retry (MÉDIO)
**Problema:** Sem retry automático
**Solução:** Worker configurado com 3 tentativas e backoff exponencial

## 📋 Mudanças no Código

### Worker (completeOrchestratorWorker.js)

```javascript
// NOVO: Garante conexão Mongo
async function ensureMongoConnection() { ... }

// NOVO: Libera lock em caso de falha
async function releaseAppointmentLock(appointmentId, reason) { ... }

// MUDANÇA: TTL do lock 30s → 180s
withLock(..., { ttl: 180 })

// NOVO: Configuração de retry
{
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 }
}

// NOVO: Handler de falha libera lock
worker.on('failed', async (job, error) => {
  await releaseAppointmentLock(appointmentId, error.message);
});
```

## 🔄 Fluxo de Recovery

```
1. Job falha → catch libera lock
2. BullMQ retry (3 tentativas)
3. Se esgotar tentativas → failed handler libera lock
4. Move para DLQ (Dead Letter Queue)
5. Cron de backup (se existir) limpa após 5min
```

## 🚀 Deploy

```bash
# Commit
git add back/workers/completeOrchestratorWorker.js
git commit -m "fix: worker robusto com retry, lock e garantias"
git push origin main

# Deploy automático no Render
```

## ✅ Validação

Após deploy, verifique:

```bash
# Logs do worker
tail -f logs | grep "CompleteOrchestrator"

# Deve mostrar:
# "🟢 MongoDB conectado"
# "✅ Worker iniciado (v2.0 - Produção)"

# Teste um complete e verifique se:
# 1. Não trava em processing_complete
# 2. Se falhar, libera para scheduled
# 3. Retry funciona (tentativa 1, 2, 3)
```

## 🗑️ Deprecações

O cron de recovery (`appointmentRecovery.cron.js`) agora é **backup apenas**:
- Antes: Única forma de liberar agendamentos
- Depois: Última linha de defesa (caso o worker morra completamente)
