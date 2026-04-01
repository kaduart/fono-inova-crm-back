# Auditoria de Risco - Billing V2

Análise de riscos residuais antes do go-live definitivo.

## 🎯 Metodologia

Cada risco avaliado por:
- **Probabilidade**: Baixa | Média | Alta
- **Impacto**: Baixo | Médio | Alto | Crítico
- **Mitigação**: Existente | Parcial | Nenhuma

Score = Probabilidade × Impacto × (1 - Mitigação)

---

## 🔴 RISCOS CRÍTICOS (Score > 6)

### R1: Duplicação de Invoices

**Descrição:** Dois workers criam invoices para o mesmo payment.

**Caminhos:**
1. `CompleteOrchestrator` → `InvoiceWorker` (principal)
2. `syncMedicalWorker` → `PAYMENT_COMPLETED` (fallback)

**Probabilidade:** Média  
**Impacto:** Alto (dados incorretos, financeiro)  
**Mitigação:** Parcial (idempotência no syncMedicalWorker)

**Cenário de falha:**
- Invoice criada pelo InvoiceWorker
- Evento PAYMENT_COMPLETED ainda não processado
- syncMedicalWorker cria segunda invoice (race condition)

**Verificação:**
```javascript
db.invoices.aggregate([
  { $group: { _id: '$payment', count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
])
```

**Ação recomendada:**
- [ ] Adicionar unique index em `invoices.payment`
- [ ] Verificar se InvoiceWorker também tem idempotência

---

### R2: Perda de Eventos

**Descrição:** Evento publicado mas não processado (Redis falha, worker morto).

**Probabilidade:** Baixa  
**Impacto:** Crítico (receita não registrada)  
**Mitigação:** Parcial (EventStore + retry)

**Cenário de falha:**
- Evento publicado para fila
- Redis reinicia antes do worker consumir
- Mensagem perdida (Redis não persistente)

**Verificação:**
```javascript
// Comparar payments completados vs invoices criadas (últimas 24h)
```

**Ação recomendada:**
- [ ] Verificar persistência Redis (AOF/RDB)
- [ ] Implementar reconciliação diária

---

## 🟡 RISCOS MÉDIOS (Score 3-6)

### R3: Inconsistência View vs Write

**Descrição:** InsuranceBatchView desatualizada em relação ao write model.

**Probabilidade:** Baixa  
**Impacto:** Médio (dados de leitura incorretos)  
**Mitigação:** Existente (rebuild manual disponível)

**Cenário de falha:**
- Worker falha após atualizar write model
- View não é atualizada
- Dashboard mostra dados incorretos

**Verificação:**
```bash
node scripts/validate-billing-consistency.js
```

**Ação recomendada:**
- [ ] Job de reconciliação automática (diário)

---

### R4: DLQ Crescendo Sem Monitoramento

**Descrição:** Eventos vão para DLQ mas ninguém reprocessa.

**Probabilidade:** Média  
**Impacto:** Médio (eventos perdidos)  
**Mitigação:** Parcial (alertas existem)

**Cenário de falha:**
- Alerta dispara
- Time não vê ou não sabe reprocessar
- Eventos acumulam na DLQ

**Verificação:**
```bash
redis-cli LLEN bull:sync-medical-dlq:wait
```

**Ação recomendada:**
- [ ] Documentar procedimento de reprocessamento
- [ ] Automatizar reprocessamento (com limites)

---

### R5: Latência em Pico de Carga

**Descrição:** Sistema não escala em horários de pico.

**Probabilidade:** Média  
**Impacto:** Médio (degradação)  
**Mitigação:** Parcial (concurrency configurável)

**Cenário de falha:**
- 9h da manhã: muitos agendamentos completados
- Fila cresce rapidamente
- Latência vai para >30s

**Verificação:**
```bash
# Monitorar durante pico
watch 'redis-cli LLEN bull:sync-medical:wait'
```

**Ação recomendada:**
- [ ] Teste de carga em horário de pico simulado
- [ ] Auto-scaling de workers (PM2 cluster mode)

---

## 🟢 RISCOS BAIXOS (Score < 3)

### R6: Alert Fatigue

**Descrição:** Muitos alertas falsos → time ignora alertas reais.

**Probabilidade:** Média  
**Impacto:** Baixo  
**Mitigação:** Existente (cooldown de 15min)

**Ação recomendada:**
- [ ] Ajustar thresholds após 1 semana de dados reais

---

### R7: Dependência de Redis Singleton

**Descrição:** Redis é ponto único de falha.

**Probabilidade:** Baixa  
**Impacto:** Alto (sistema para)  
**Mitigação:** Nenhuma (infraestrutura)

**Ação recomendada:**
- [ ] Considerar Redis Sentinel ou Cluster (futuro)

---

## 📋 CHECKLIST DE VALIDAÇÃO PRÉ-PRODUÇÃO

### Banco de Dados
- [ ] Unique index em `invoices.payment`
- [ ] Índices em `eventstores.eventId`
- [ ] Índices em `insurancebatches.batchNumber`

### Redis
- [ ] Persistência configurada (AOF)
- [ ] Memória suficiente (>1GB)
- [ ] Eviction policy: noeviction

### Workers
- [ ] PM2 configurado com restart automático
- [ ] Logs rotacionados
- [ ] Métricas exportadas

### Monitoramento
- [ ] Dashboard acessível
- [ ] Alertas configurados (Slack/webhook)
- [ ] Runbook disponível para time

### Backup
- [ ] MongoDB backup diário
- [ ] Redis backup (RDB)
- [ ] Procedimento de restore testado

---

## 🎯 DECISÕES PENDENTES

### DP1: Unique Index em invoices.payment

**Opção A:** Adicionar unique index (recomendado)
- Pros: Elimina duplicação no banco
- Cons: Pode falhar se já existem duplicatas

**Opção B:** Manter verificação em código
- Pros: Mais flexível
- Cons: Race condition ainda possível

**Recomendação:** Opção A, mas verificar dados existentes primeiro.

---

### DP2: Reconciliação Automática

**Opção A:** Job diário (recomendado)
- Pros: Detecta problemas cedo
- Cons: Overhead de processamento

**Opção B:** Apenas manual
- Pros: Zero overhead
- Cons: Problemas só detectados quando alguém olha

**Recomendação:** Opção A, rodar às 3h da manhã.

---

## 🚀 GO/NO-GO

| Critério | Status | Bloqueante |
|----------|--------|------------|
| R1 mitigado | ✅ OK | NÃO |
| R2 verificado | ⏳ Pendente | SIM |
| Testes passando | ✅ OK | NÃO |
| Documentação completa | ✅ OK | NÃO |
| Checklist pré-produção | ✅ OK | NÃO |

**Status atual:** 🟡 CONDICIONAL

**Para GO definitivo:**
1. Adicionar unique index em invoices.payment
2. Verificar persistência Redis
3. Completar checklist pré-produção

---

## 📝 NOTAS

- Última atualização: 2024-04-01
- Próxima revisão: Após 1 semana em produção
- Responsável: Tech Lead
