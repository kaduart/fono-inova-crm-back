# Checklist Final - Deploy Billing V2

## ✅ Pré-Deploy

### Código
- [x] `billingOrchestratorWorker` removido (arquivo .deprecated)
- [x] `syncMedicalWorker` com idempotência, retry, DLQ
- [x] `insuranceOrchestratorWorker` ativo (lotes de convênio)
- [x] Nenhum TODO crítico no fluxo principal
- [x] Testes passando (`npm run test:e2e:v2`)

### Configuração
- [ ] Variáveis de ambiente configuradas:
  ```bash
  MONGODB_URI=
  REDIS_URL=
  JWT_SECRET=
  ```
- [ ] Filas criadas no Redis:
  ```bash
  redis-cli KEYS "bull:*" | grep -E "(sync-medical|insurance-orchestrator|patient-projection|package-projection)"
  ```

### Banco de Dados
- [ ] Índices criados:
  ```javascript
  db.invoices.createIndex({ payment: 1 }, { unique: true, sparse: true })
  db.eventstores.createIndex({ eventId: 1 }, { unique: true })
  db.insurancebatches.createIndex({ batchNumber: 1 }, { unique: true })
  ```
- [ ] Migrations executadas (se houver)

## 🚀 Deploy

### 1. Backup
```bash
# MongoDB
mongodump --uri="$MONGODB_URI" --out=/backup/pre-billing-v2-$(date +%Y%m%d)

# Redis (opcional)
redis-cli BGSAVE
```

### 2. Deploy Gradual
```bash
# 1. Deploy código (sem ativar workers novos ainda)
pm2 deploy production

# 2. Verificar health check
curl http://localhost:5000/api/v2/health

# 3. Ativar workers um por um
pm2 start syncMedicalWorker
pm2 start insuranceOrchestratorWorker

# 4. Verificar logs
pm2 logs syncMedicalWorker --lines 50
pm2 logs insuranceOrchestratorWorker --lines 50
```

### 3. Validação Imediata
```bash
# Health check
curl http://localhost:5000/api/v2/health | jq

# Consistência inicial
node scripts/validate-billing-consistency.js

# Filas vazias (ou processando)
redis-cli LLEN bull:sync-medical:wait
redis-cli LLEN bull:insurance-orchestrator:wait
```

## 🔍 Pós-Deploy (Primeiras 24h)

### Monitoramento Contínuo
```bash
# A cada 30 minutos nas primeiras 2h
# Depois a cada 2h

# 1. Tamanho das filas
redis-cli LLEN bull:sync-medical:wait
redis-cli LLEN bull:sync-medical:active
redis-cli LLEN bull:sync-medical:failed

# 2. Taxa de processamento
# (comparar invoices criadas vs payments completados)

# 3. Erros
pm2 logs --err --lines 20

# 4. DLQ
redis-cli LLEN bull:sync-medical-dlq:wait
```

### Alertas (PagerDuty/Slack)
- [ ] Fila > 1000 mensagens
- [ ] Jobs falhos > 10/hora
- [ ] Latência p99 > 10s
- [ ] Inconsistência detectada

## 🧪 Testes de Validação

### 1. Teste de Carga (Opcional)
```bash
npm run test:load -- tests/load/syncMedicalWorker.load.test.js
```

### 2. Teste de Consistência
```bash
node scripts/validate-billing-consistency.js
```

### 3. Teste de Replay (Se necessário)
```bash
npm run test -- tests/load/eventReplay.test.js
```

## 🆘 Rollback (Se necessário)

### 1. Parar Workers Novos
```bash
pm2 stop syncMedicalWorker
pm2 stop insuranceOrchestratorWorker
```

### 2. Reverter Código
```bash
# Git revert para versão anterior
git revert HEAD
pm2 deploy production
```

### 3. Verificar Estado
```bash
# Validar consistência
node scripts/validate-billing-consistency.js

# Verificar se invoices estão OK
```

## 📋 Checklist Final

### Funcional
- [ ] Payments completados geram invoices
- [ ] Invoices não duplicadas
- [ ] Lotes de convênio funcionam
- [ ] Views atualizam corretamente

### Performance
- [ ] Throughput > 10 events/s
- [ ] Latência p99 < 5s
- [ ] Sem backlog nas filas

### Observabilidade
- [ ] Logs estruturados visíveis
- [ ] Métricas no dashboard
- [ ] Alertas configurados

### Documentação
- [ ] Runbook atualizado
- [ ] Time treinado
- [ ] Escalation path definido

---

## ✅ APROVAÇÃO FINAL

| Papel | Nome | Assinatura | Data |
|-------|------|------------|------|
| Tech Lead | | | |
| Product Owner | | | |
| SRE/Platform | | | |

**Somente após todas as assinaturas, considerar deploy concluído.**
