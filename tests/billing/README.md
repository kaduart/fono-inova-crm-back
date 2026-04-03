# Testes E2E - Billing V2

## Comandos Disponíveis

```bash
# 1. Check pré-deploy (verifica ambiente)
npm run test:billing:pre-deploy

# 2. Testes E2E (fluxo completo)
npm run test:billing:e2e

# 3. Testes de Integração (worker)
npm run test:billing:integration

# 4. Teste de carga (padrão: 10 sessões)
npm run test:billing:load

# 5. Teste de carga customizado
node tests/billing/load-test.js 100  # 100 sessões

# 6. Suite completa (tudo)
npm run test:billing:full
```

## Ordem Recomendada para Go-Live

### Antes do Deploy
```bash
# 1. Verificar ambiente
npm run test:billing:pre-deploy

# 2. Rodar testes E2E
npm run test:billing:e2e

# 3. Teste de carga (simula produção)
npm run test:billing:load 50
```

### Durante o Deploy
```bash
# Após cada fase, valide:
npm run billing:validate
```

## Estrutura dos Testes

### E2E (`billing-v2-e2e.test.js`)
- ✅ Happy path completo (completed → billed → received)
- ✅ Idempotência (não duplica)
- ✅ State machine (transições válidas)
- ✅ Reconciliação (auto-fix)
- ✅ Cancelamento (restaura guia)

### Integration (`billing-worker.integration.test.js`)
- ✅ Worker processando eventos
- ✅ Retry em falhas
- ✅ Ordem dos eventos
- ✅ Concorrência
- ✅ DLQ

### Load Test (`load-test.js`)
- ✅ Performance: throughput, latência
- ✅ Detecção de duplicatas em paralelo
- ✅ Consistência dos dados

## Critérios de Aprovação

| Teste | Critério | Obrigatório |
|-------|----------|-------------|
| Pre-deploy | 100% pass | ✅ Sim |
| E2E | 100% pass | ✅ Sim |
| Integration | 100% pass | ✅ Sim |
| Load (50) | 0 duplicatas | ✅ Sim |
| Load (50) | < 100ms média | 🟡 Ideal |
| Load (50) | 0 falhas | ✅ Sim |

## Solução de Problemas

### Testes falham
```bash
# Limpar banco de teste
mongo crm_test_billing --eval "db.dropDatabase()"

# Limpar filas Redis
redis-cli FLUSHDB

# Rodar novamente
npm run test:billing:e2e
```

### Load test lento
- Verificar índices MongoDB
- Verificar latência Redis
- Reduzir número de sessões: `node tests/billing/load-test.js 10`

### Duplicatas detectadas
- NÃO PROSSEGUIR com deploy
- Verificar idempotência
- Verificar locks
- Corrigir antes de continuar
