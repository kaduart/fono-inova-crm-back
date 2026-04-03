# BACKLOG V2 - IMPLEMENTAÇÃO COMPLETA

> Arquivo vivo - atualizar conforme evolução

---

## ✅ BACKEND - IMPLEMENTADO

### 1. Core Services
| Componente | Arquivo | Status | Observação |
|------------|---------|--------|------------|
| Service V2 (completo) | `domains/billing/services/insuranceBillingService.v2.js` | ✅ Pronto | Ciclo completo: completed → billed → received |
| Worker BullMQ | `domains/billing/workers/billingConsumerWorker.js` | ✅ Pronto | Processa eventos da fila |
| State Machine | `domains/billing/models/FinancialStateMachine.js` | ✅ Pronto | Transições: pending → billed → paid |
| Reconciliation | `domains/billing/services/ReconciliationService.js` | ✅ Pronto | 5 checks + auto-fix |
| Feature Flags | `domains/billing/config/FeatureFlags.js` | ✅ Pronto | Controle granular por etapa |

### 2. Scripts de Operação
| Script | Comando | Status |
|--------|---------|--------|
| Validate | `npm run billing:validate` | ✅ Pronto |
| Monitor | `npm run billing:monitor` | ✅ Pronto |
| Rollback | `npm run billing:rollback` | ✅ Pronto |
| Go-live | `npm run billing:go-live [fase]` | ✅ Pronto |
| Status | `npm run billing:status` | ✅ Pronto |

### 3. Testes
| Teste | Arquivo | Status |
|-------|---------|--------|
| E2E Completo | `tests/billing/billing-v2-e2e.test.js` | ✅ Pronto |
| Integration Worker | `tests/billing/billing-worker.integration.test.js` | ✅ Pronto |
| Load Test | `tests/billing/load-test.js` | ✅ Pronto |
| Pre-deploy Check | `tests/billing/pre-deploy-check.js` | ✅ Pronto |

### 4. Documentação
| Doc | Arquivo | Status |
|-----|---------|--------|
| Playbook Go-live | `domains/billing/docs/PLAYBOOK_GO_LIVE.md` | ✅ Pronto |
| Guia Teste Vera | `domains/billing/docs/GUIA_TESTE_VERA.md` | ✅ Pronto |
| Fluxo Front | `domains/billing/docs/FLUXO_FRONT.md` | ✅ Pronto |
| Resumo Execução | `domains/billing/docs/RESUMO_EXECUCAO.txt` | ✅ Pronto |

---

## 🔧 FRONTEND - PENDENTE / A IMPLEMENTAR

### 1. Dashboard de Monitoramento (PRIORIDADE ALTA)
```
Tela: /admin/billing/monitoramento

Funcionalidades:
- [ ] Cards em tempo real:
  - Sessões processadas (hoje)
  - Taxa de sucesso (%)
  - Jobs na fila
  - DLQ (alerta se > 0)
  
- [ ] Gráfico de throughput (eventos/hora)
- [ ] Lista de últimos eventos processados
- [ ] Alertas visuais (verde/vermelho)

Dados da API: polling a cada 30s ou WebSocket
Endpoint necessário: GET /api/billing/stats
```

### 2. Tela de Reconciliação (PRIORIDADE ALTA)
```
Tela: /admin/billing/reconciliacao

Funcionalidades:
- [ ] Botão "Executar Reconciliação"
- [ ] Tabela de inconsistências encontradas:
  - Tipo (Session sem Payment, Payment duplicado, etc)
  - Severidade (HIGH/CRITICAL)
  - Ação (Auto-fix / Manual)
  - Botão "Corrigir" (para auto-fix)
  
- [ ] Relatório diário agendado
- [ ] Exportar CSV

Endpoint: POST /api/billing/reconcile
```

### 3. Controle de Feature Flags (PRIORIDADE MÉDIA)
```
Tela: /admin/billing/flags

Funcionalidades:
- [ ] Toggle switches para cada flag:
  - USE_V2_WORKER
  - USE_V2_BILLING_CREATE
  - USE_V2_BILLING_BILLED
  - USE_V2_BILLING_RECEIVED
  
- [ ] Botão "Desativar Tudo" (EMERGÊNCIA)
- [ ] Histórico de alterações (quem, quando)
- [ ] Validação antes de ativar (check prévio)

Endpoint: 
- GET /api/billing/flags
- POST /api/billing/flags/:key
```

### 4. DLQ Manager (PRIORIDADE MÉDIA)
```
Tela: /admin/billing/dlq

Funcionalidades:
- [ ] Lista de jobs falhos:
  - Session ID
  - Erro
  - Tentativas
  - Data
  
- [ ] Botões:
  - "Reprocessar" (retry)
  - "Ignorar" (remover)
  - "Ver detalhes" (stack trace)
  
- [ ] Estatísticas: total, por tipo de erro

Endpoint: GET /api/billing/dlq
```

### 5. Auditoria Financeira (PRIORIDADE BAIXA)
```
Tela: /admin/billing/auditoria

Funcionalidades:
- [ ] Timeline de eventos por sessão:
  - SESSION_COMPLETED (horário, correlationId)
  - INSURANCE_GUIDE_LOCKED
  - INSURANCE_BILLING_CREATED
  - INSURANCE_BILLING_BILLED
  - INSURANCE_PAYMENT_RECEIVED
  
- [ ] Filtros: por paciente, por data, por status
- [ ] Exportar auditoria (PDF/CSV)

Endpoint: GET /api/billing/audit/:sessionId
```

### 6. Alertas em Tempo Real (PRIORIDADE MÉDIA)
```
Integração: Slack/Email/WhatsApp

Alertas:
- [ ] DLQ recebeu job (falha)
- [ ] Taxa de sucesso < 95%
- [ ] Duplicata detectada
- [ ] Inconsistência crítica
- [ ] Rollback executado

Config:
- [ ] Canal de alerta
- [ ] Frequência (imediato / digest diário)
- [ ] Níveis (CRITICAL apenas, ou tudo)
```

---

## 📡 ENDPOINTS NECESSÁRIOS (CRIAR NO BACK)

### Para Dashboard
```javascript
// GET /api/billing/stats
{
  "timestamp": "2024-01-15T10:00:00Z",
  "summary": {
    "sessionsProcessedToday": 45,
    "successRate": 97.8,
    "queueLength": 3,
    "dlqLength": 0
  },
  "hourly": [
    { "hour": 9, "count": 12 },
    { "hour": 10, "count": 15 }
  ],
  "recentEvents": [
    {
      "type": "SESSION_COMPLETED",
      "sessionId": "...",
      "status": "success",
      "timestamp": "..."
    }
  ]
}
```

### Para Reconciliação
```javascript
// POST /api/billing/reconcile
// Executa reconciliação e retorna relatório

// GET /api/billing/reconcile/report
// Último relatório gerado
```

### Para Feature Flags
```javascript
// GET /api/billing/flags
[
  { "key": "USE_V2_WORKER", "enabled": true, "updatedAt": "..." }
]

// POST /api/billing/flags/:key
{ "enabled": false }
```

### Para DLQ
```javascript
// GET /api/billing/dlq
{
  "total": 5,
  "jobs": [
    {
      "id": "...",
      "sessionId": "...",
      "error": "...",
      "attempts": 3,
      "failedAt": "..."
    }
  ]
}

// POST /api/billing/dlq/:jobId/retry
```

### Para Auditoria
```javascript
// GET /api/billing/audit/:sessionId
{
  "sessionId": "...",
  "timeline": [
    {
      "event": "SESSION_COMPLETED",
      "timestamp": "...",
      "correlationId": "...",
      "metadata": {...}
    }
  ]
}
```

---

## 🎯 PRIORIDADES DE IMPLEMENTAÇÃO

### Semana 1 (Crítico)
1. [ ] Endpoint `/api/billing/stats`
2. [ ] Dashboard básico (cards + fila)
3. [ ] Alerta DLQ > 0

### Semana 2 (Importante)
4. [ ] Tela de reconciliação
5. [ ] Controle de feature flags
6. [ ] Endpoint `/api/billing/reconcile`

### Semana 3 (Melhoria)
7. [ ] DLQ Manager
8. [ ] Auditoria por sessão
9. [ ] Alertas Slack/Email

---

## 🧪 TESTES QUE PRECISAM PASSAR

### Antes de liberar V2 para todos:
- [ ] Teste E2E completo passando
- [ ] Load test com 100+ sessões
- [ ] 24h em staging sem inconsistências
- [ ] Rollback testado e funcionando
- [ ] Time treinado no processo

---

## 📊 MÉTRICAS DE SUCESSO

| Métrica | Target | Onde ver |
|---------|--------|----------|
| Taxa de sucesso | > 99% | Dashboard |
| Tempo médio processamento | < 2s | Dashboard |
| Duplicatas | 0 | Reconciliação |
| DLQ | 0 | Dashboard + Alerta |
| Inconsistências | 0 | Reconciliação |

---

## 🚨 ROLLBACK - QUANDO EXECUTAR

**Executar imediatamente se:**
- Taxa de sucesso < 95%
- DLQ crescendo (> 10 jobs)
- Duplicatas detectadas
- Usuários reportando erros no front
- Inconsistências não auto-corrigidas

**Comando:**
```bash
npm run billing:rollback
```

---

## 📝 ATUALIZAÇÕES (log)

| Data | O que foi feito | Por |
|------|-----------------|-----|
| 2024-01-15 | Criado backlog inicial | Kimi |
| | | |

---

## 🔗 LINKS ÚTEIS

- Documentação V2: `domains/billing/docs/`
- Scripts: `scripts/` (billing:*)
- Testes: `tests/billing/`
- Playbook Go-live: `domains/billing/docs/PLAYBOOK_GO_LIVE.md`
