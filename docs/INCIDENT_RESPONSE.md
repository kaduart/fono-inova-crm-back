# Incident Response - Billing

Playbook para resposta a incidentes no sistema de billing.

## 🚨 Severidade

| Nível | Descrição | Exemplo | Resposta |
|-------|-----------|---------|----------|
| SEV1 | Sistema parado | Nenhuma invoice sendo criada | Imediata (15min) |
| SEV2 | Degradação severa | >50% de falhas | Imediata (30min) |
| SEV3 | Degradação parcial | Latência alta, backlog | 2h |
| SEV4 | Alerta preventivo | Threshold próximo | 24h |

## 📞 Comunicação

### Canais
- **Slack**: #incidents-billing
- **PagerDuty**: Escalation automático para SEV1/SEV2
- **Bridge**: Google Meet (link no Slack)

### Roles
- **Incident Commander**: Primeiro a responder
- **Tech Lead**: Escalation técnica
- **Comms Lead**: Comunicação externa

## 🔥 Runbooks por Tipo

### TIPO 1: Fila com Backlog (SEV2/SEV3)

**Sintomas:**
- Fila `sync-medical` > 1000 mensagens
- Latência crescente

**Diagnóstico:**
```bash
# 1. Verificar tamanho das filas
redis-cli LLEN bull:sync-medical:wait
redis-cli LLEN bull:sync-medical:active

# 2. Verificar workers ativos
pm2 status

# 3. Verificar logs
pm2 logs syncMedicalWorker --lines 100
```

**Ações:**

1. **Se workers parados:**
   ```bash
   pm2 restart syncMedicalWorker
   ```

2. **Se backlog muito grande:**
   ```bash
   # Escalar workers temporariamente
   pm2 start syncMedicalWorker --instances 3
   
   # Monitorar redução
   watch 'redis-cli LLEN bull:sync-medical:wait'
   ```

3. **Se não reduzir:**
   - Verificar MongoDB (locks lentos)
   - Verificar Redis (memória)

---

### TIPO 2: Taxa de Erro Alta (SEV1/SEV2)

**Sintomas:**
- >5% de jobs falhando
- DLQ crescendo

**Diagnóstico:**
```bash
# 1. Verificar jobs falhos
redis-cli LRANGE bull:sync-medical:failed 0 10

# 2. Verificar padrão de erro
pm2 logs syncMedicalWorker --err --lines 50

# 3. Verificar EventStore
db.eventstores.find({ status: 'failed' }).sort({ failedAt: -1 }).limit(10)
```

**Ações:**

1. **Se erro de MongoDB (timeout, lock):**
   - Verificar índices
   - Verificar load no Atlas
   - Considerar scale-up

2. **Se erro de lógica (bug):**
   - Identificar padrão
   - Se isolado: reprocessar manualmente
   - Se generalizado: rollback

3. **Reprocessar da DLQ:**
   ```bash
   # Listar
   node -e "const { listDLQMessages } = require('./workers/syncMedicalWorker'); listDLQMessages().then(console.log);"
   
   # Reprocessar
   curl -X POST http://localhost:5000/api/v2/admin/dlq/sync-medical/:jobId/reprocess
   ```

---

### TIPO 3: Inconsistência de Dados (SEV2)

**Sintomas:**
- Invoices duplicadas
- Batch view desatualizada

**Diagnóstico:**
```bash
# 1. Rodar validação
node scripts/validate-billing-consistency.js

# 2. Verificar duplicatas específicas
db.invoices.aggregate([
  { $group: { _id: '$payment', count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
])
```

**Ações:**

1. **Correção automática:**
   ```bash
   node scripts/validate-billing-consistency.js --fix
   ```

2. **Se não resolver:**
   - Identificar IDs problemáticos
   - Correção manual via script
   - Documentar para análise pós-incidente

---

### TIPO 4: Latência Alta (SEV3)

**Sintomas:**
- p99 > 10s
- Timeouts crescentes

**Diagnóstico:**
```bash
# 1. Verificar métricas
curl http://localhost:5000/api/metrics/dashboard

# 2. Verificar MongoDB
# Atlas Dashboard → Metrics

# 3. Verificar Redis
redis-cli INFO memory
```

**Ações:**

1. **Se MongoDB lento:**
   - Verificar slow queries
   - Verificar índices faltantes
   - Considerar scale-up

2. **Se Redis lento:**
   - Verificar memória
   - Verificar evicted keys
   - Considerar Redis upgrade

---

## 🔄 Rollback

### Quando fazer rollback
- Bug em produção afetando >10% dos eventos
- Degradação severa (>50% de falhas)
- Dados sendo corrompidos

### Como fazer

1. **Parar workers novos:**
   ```bash
   pm2 stop syncMedicalWorker
   pm2 stop insuranceOrchestratorWorker
   ```

2. **Reverter código:**
   ```bash
   git revert HEAD
   npm run deploy
   ```

3. **Validar:**
   ```bash
   curl http://localhost:5000/api/v2/health
   node scripts/validate-billing-consistency.js
   ```

4. **Comunicar:**
   - Post-mortem no Slack
   - Ticket para análise

---

## 📊 Pós-Incidente

### Dentro de 24h
- [ ] Incidente documentado
- [ ] Timeline criada
- [ ] Impacto quantificado

### Dentro de 1 semana
- [ ] Post-mortem completo
- [ ] Action items definidos
- [ ] Runbook atualizado (se necessário)

### Template de Post-Mortem

```markdown
# Post-Mortem: [Título] - [Data]

## Resumo
- Severidade: SEV[X]
- Duração: [X minutos]
- Impacto: [X invoices afetadas, $X em receita]

## Timeline
- HH:MM - Alerta disparado
- HH:MM - Resposta iniciada
- HH:MM - Identificado
- HH:MM - Mitigado
- HH:MM - Resolvido

## Causa Raiz
[Descrição técnica]

## Ações Tomadas
1. [Ação imediata]
2. [Ação de mitigação]

## Action Items
- [ ] [Item] - Owner - Due date
- [ ] [Item] - Owner - Due date

## Lições Aprendidas
[O que melhorar]
```

---

## 📚 Referências

- Runbook operacional: `RUNBOOK_BILLING.md`
- Dashboard de métricas: `/api/metrics/dashboard`
- Health check: `/api/v2/health`
- Validação: `scripts/validate-billing-consistency.js`
