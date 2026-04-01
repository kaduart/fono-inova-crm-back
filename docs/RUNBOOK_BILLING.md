# Runbook - Billing & Convênio

Guia operacional para monitoramento e troubleshooting do sistema de billing.

## 🎯 Responsabilidades

| Componente | Função | Fila |
|------------|--------|------|
| `syncMedicalWorker` | Criar invoices per-session | `sync-medical` |
| `insuranceOrchestratorWorker` | Gerenciar lotes de convênio | `insurance-orchestrator` |
| `patientProjectionWorker` | Atualizar views de pacientes | `patient-projection` |
| `packageProjectionWorker` | Atualizar views de pacotes | `package-projection` |

## 📊 Dashboards

### Health Check
```bash
curl http://localhost:5000/api/v2/health
```

Verifica: MongoDB, Redis, todas as filas

### Métricas de Eventos
```bash
curl http://localhost:5000/api/observability/metrics
```

### Consistência Billing
```bash
curl http://localhost:5000/api/v2/insurance-batches/consistency/check
```

## 🚨 Alertas

### 1. Fila com backlog
```bash
# Verificar tamanho da fila
redis-cli LLEN bull:sync-medical:wait

# Se > 1000: investigar worker
# Se > 5000: página on-call
```

### 2. Jobs falhando
```bash
# Verificar jobs falhos
redis-cli LRANGE bull:sync-medical:failed 0 10

# Se > 10 falhas/hora: investigar
```

### 3. Inconsistência detectada
```bash
# Rodar validação
node scripts/validate-billing-consistency.js

# Se erros encontrados:
node scripts/validate-billing-consistency.js --fix
```

## 🔧 Troubleshooting

### Problema: Invoices não sendo criadas

**Sintomas:**
- Payments completados mas sem invoice
- Fila `sync-medical` vazia

**Passos:**
1. Verificar se worker está rodando:
   ```bash
   ps aux | grep node
   ```

2. Verificar logs:
   ```bash
   tail -f logs/syncMedicalWorker.log
   ```

3. Verificar EventStore:
   ```javascript
   db.eventstores.find({ 
     eventType: 'PAYMENT_COMPLETED',
     status: { $ne: 'processed' }
   }).limit(10)
   ```

### Problema: Invoices duplicadas

**Sintomas:**
- Mesmo payment com múltiplas invoices
- Erro em relatórios financeiros

**Passos:**
1. Identificar duplicatas:
   ```javascript
   db.invoices.aggregate([
     { $group: { _id: '$payment', count: { $sum: 1 } } },
     { $match: { count: { $gt: 1 } } }
   ])
   ```

2. Corrigir:
   ```bash
   node scripts/validate-billing-consistency.js --fix
   ```

### Problema: Lotes de convênio travados

**Sintomas:**
- Status `processing` por muito tempo
- Não avança para `sent`

**Passos:**
1. Verificar fila:
   ```bash
   redis-cli LRANGE bull:insurance-orchestrator:wait 0 10
   ```

2. Verificar DLQ:
   ```bash
   redis-cli LRANGE bull:insurance-orchestrator-dlq:wait 0 10
   ```

3. Reprocessar se necessário (via API de DLQ)

## 🔄 Procedimentos

### Reiniciar worker

```bash
# Parar
pm2 stop syncMedicalWorker

# Limpar fila (se necessário)
redis-cli DEL bull:sync-medical:wait

# Iniciar
pm2 start syncMedicalWorker
```

### Reprocessar evento da DLQ

```bash
# Listar
node -e "
const { listDLQMessages } = require('./workers/syncMedicalWorker');
listDLQMessages().then(console.log);
"

# Reprocessar específico
curl -X POST http://localhost:5000/api/v2/admin/dlq/sync-medical/:jobId/reprocess
```

### Rebuild de views

```bash
# Rebuild específico
curl -X POST http://localhost:5000/api/v2/insurance-batches/:id/rebuild

# Rebuild em massa (cuidado!)
node scripts/rebuild-all-views.js
```

## 📈 SLIs e SLOs

| Métrica | SLI | SLO | Alerta |
|---------|-----|-----|--------|
| Throughput | eventos/segundo | > 10/s | < 5/s |
| Latência p99 | tempo de processamento | < 5s | > 10s |
| Taxa de erro | jobs falhos / total | < 1% | > 5% |
| Consistência | invoices duplicadas | 0 | > 0 |

## 📝 Logs Importantes

### SyncMedicalWorker
- `job_start`: Início de processamento
- `invoice_created`: Invoice criada com sucesso
- `invoice_already_exists`: Idempotência funcionando
- `job_error`: Erro no processamento
- `job_dlq`: Evento movido para DLQ

### InsuranceOrchestratorWorker
- `batch_created`: Lote criado
- `batch_sent`: Lote enviado para operadora
- `item_approved`: Item aprovado
- `view_updated`: View atualizada

## 🆘 Contatos

- On-call: #alerts-billing
- Escalation: #platform-team
- Documentação: https://wiki.company.com/billing
