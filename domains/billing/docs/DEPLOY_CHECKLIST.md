# DEPLOY CHECKLIST - Billing V2

> ⚠️ **WARNING**: This checklist must be completed in order. Do not skip steps.

## Pre-Deploy (1 dia antes)

### 1. Backup
- [ ] Backup completo do banco de produção
- [ ] Exportar coleções: `sessions`, `payments`, `appointments`, `insuranceguides`
- [ ] Testar restore em ambiente de staging

### 2. Feature Flags
```javascript
// Todas as flags devem estar DESATIVADAS inicialmente
USE_V2_BILLING_CREATE=false
USE_V2_BILLING_BILLED=false  
USE_V2_BILLING_RECEIVED=false
USE_V2_WORKER=false
USE_V2_RECONCILIATION=false
```

### 3. Monitoramento
- [ ] Alertas configurados para DLQ (billing-dlq)
- [ ] Dashboard de métricas pronto
- [ ] Canal de alertas configurado (Slack/Teams)

### 4. Rollback Plan
- [ ] Script de rollback testado
- [ ] Equipe de plantão notificada
- [ ] Horário de deploy em janela de baixo tráfego

---

## Deploy (Dia D)

### Fase 1: Worker (10 min)
1. [ ] Deploy código V2
2. [ ] Verificar logs de startup
3. [ ] Confirmar conexão com Redis
4. [ ] Feature flag `USE_V2_WORKER=true`
5. [ ] Verificar worker processando (sem erro)

**Rollback trigger:** Worker com erro ou stall

### Fase 2: Create (30 min)
1. [ ] Feature flag `USE_V2_BILLING_CREATE=true`
2. [ ] Criar 1 sessão de teste
3. [ ] Verificar:
   - [ ] Evento publicado na fila
   - [ ] Worker processou
   - [ ] Appointment criado
   - [ ] Payment criado
   - [ ] Guia consumida
   - [ ] Sem duplicata
4. [ ] Comparar com legado (valores devem bater)

**Rollback trigger:** Qualquer duplicata ou erro

### Fase 3: Billed (20 min)
1. [ ] Feature flag `USE_V2_BILLING_BILLED=true`
2. [ ] Faturar sessão de teste
3. [ ] Verificar:
   - [ ] Payment.status = 'billed'
   - [ ] Evento processado
   - [ ] Sem erro de transição

**Rollback trigger:** Erro de transição de status

### Fase 4: Received (20 min)
1. [ ] Feature flag `USE_V2_BILLING_RECEIVED=true`
2. [ ] Marcar como recebido
3. [ ] Verificar:
   - [ ] Payment.status = 'paid'
   - [ ] Session.isPaid = true
   - [ ] Valor correto

**Rollback trigger:** Status inconsistente

### Fase 5: Reconciliation (opcional)
1. [ ] Feature flag `USE_V2_RECONCILIATION=true`
2. [ ] Aguardar 1 ciclo (24h)
3. [ ] Verificar relatório de inconsistências

---

## Post-Deploy (7 dias)

### Dia 1
- [ ] Monitorar DLQ a cada 30 min
- [ ] Verificar métricas de sucesso/erro
- [ ] Confirmar nenhuma duplicata

### Dia 2-3
- [ ] Revisar reconciliação diária
- [ ] Corrigir inconsistências manuais (se houver)
- [ ] Ajustar thresholds de alerta

### Dia 7
- [ ] Relatório de estabilidade
- [ ] Decisão: manter V2 ou rollback
- [ ] Documentar lições aprendidas

---

## Rollback (Emergência)

```javascript
// Execute em segundos:
await featureFlags.disableAll('emergency_rollback');

// Verificar:
// 1. Worker parou de processar novos eventos
// 2. Legado assumiu controle
// 3. Nenhum erro no sistema
```

---

## Métricas de Sucesso

| Métrica | Target | Alerta |
|---------|--------|--------|
| Taxa de sucesso V2 | > 99% | < 95% |
| Duplicatas | 0 | > 0 |
| Tempo médio processamento | < 2s | > 5s |
| DLQ (por hora) | 0 | > 5 |
| Inconsistências reconciliação | 0 | > 0 |

---

## Contatos de Emergência

- Tech Lead: [nome] / [telefone]
- DBA: [nome] / [telefone]
- Infra: [nome] / [telefone]

---

## Scripts Úteis

### Verificar duplicatas
```javascript
db.appointments.aggregate([
  { $match: { 'source.type': 'session' } },
  { $group: { _id: '$source.sessionId', count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
])
```

### Verificar status divergentes
```javascript
db.payments.find({
  status: 'paid',
  'insurance.status': { $ne: 'received' }
})
```

### Status das flags
```javascript
await featureFlags.getAllStatus()
```
