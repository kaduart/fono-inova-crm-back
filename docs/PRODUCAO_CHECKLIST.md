# 🚀 CHECKLIST DE PRODUÇÃO - Arquitetura Event-Driven

## Antes do Deploy

### 1. Infraestrutura
- [ ] Redis provisionado (Redis Cloud, AWS ElastiCache, ou local)
- [ ] MongoDB com Replica Set (necessário para transações)
- [ ] Workers podem acessar Redis e MongoDB
- [ ] Variáveis de ambiente configuradas:
  ```bash
  REDIS_HOST=
  REDIS_PORT=6379
  MONGODB_URI=
  USE_OUTBOX_PATTERN=true
  USE_EVENT_DRIVEN_COMPLETE=true
  ROLLOUT_PERCENTAGE=10  # começar com 10%
  ```

### 2. Código
- [ ] Todos os workers testados localmente
- [ ] Outbox Worker rodando sem erros
- [ ] Feature flags configuradas
- [ ] DLQ monitorada

### 3. Monitoramento
- [ ] Logs centralizados (ex: Logtail, Datadog)
- [ ] Alertas configurados para:
  - DLQ > 0
  - Fila acumulando > 100 jobs
  - Erros nos workers

## Deploy

### Fase 1: Dark Launch (0% tráfego)
```bash
# Deploy código, mas não ativa ainda
USE_EVENT_DRIVEN_COMPLETE=false
ROLLOUT_PERCENTAGE=0
```
- Verifica se workers iniciam corretamente
- Verifica se Outbox Worker publica eventos

### Fase 2: Canary (10% tráfego)
```bash
ROLLOUT_PERCENTAGE=10
```
- Monitora taxa de erro
- Verifica consistência dos dados
- Compara performance

### Fase 3: Aumento Gradual
```bash
ROLLOUT_PERCENTAGE=50   # dia 2
ROLLOUT_PERCENTAGE=100  # dia 3
```

### Fase 4: Remover Código Legado
- Quando 100% estável por 1 semana
- Remove código antigo do complete

## Monitoramento em Produção

### Métricas Críticas
```javascript
// Taxa de processamento
queue.getJobCounts('waiting', 'active', 'completed', 'failed')

// Eventos no Outbox
Outbox.countDocuments({ status: 'pending' })

// Inconsistências
reconciliationService.runReconciliation()
```

### Alertas
- **P0**: DLQ > 0 (falha irreversível)
- **P1**: Outbox pending > 100 (backlog)
- **P1**: Worker crashando
- **P2**: Latência da fila > 30s

## Rollback

Se algo der errado:
```bash
# Instantâneo - desativa tudo
USE_EVENT_DRIVEN_COMPLETE=false
ROLLOUT_PERCENTAGE=0
```

Ou gradual:
```bash
ROLLOUT_PERCENTAGE=5
```

## Comandos Úteis

```bash
# Ver filas
redis-cli keys "bull:*"

# Limpar fila (cuidado!)
redis-cli del "bull:balance-update:id"

# Ver workers
pm2 status

# Logs
pm2 logs workers
pm2 logs api
```

## Contatos de Emergência
- [ ] Tech lead:
- [ ] SRE/DevOps:
- [ ] Banco de dados:

---

**Status**: Pronto para produção ✅
