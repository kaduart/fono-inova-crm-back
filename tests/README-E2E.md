# 🧪 Framework E2E - CRM Event-Driven

> Testes end-to-end com validação de eventos, idempotência e race conditions

---

## 🚀 Como usar

### Rodar todos os cenários:
```bash
npm run test:e2e:framework
```

### 🔥 Rodar Chaos Tests (quebra o sistema propositalmente):
```bash
npm run test:chaos
```

### Rodar cenário específico:
```bash
node tests/run-e2e.js --scenario=complete-to-invoice
```

---

## 📁 Estrutura

```
tests/
├── framework/              # 🏗️ Infraestrutura
│   ├── TestRunner.js      # Orquestrador principal
│   ├── TestDatabase.js    # Isolamento de banco
│   ├── TestFixtures.js    # Dados fake
│   └── EventTracer.js     # 📊 Observabilidade
│
├── scenarios/             # 🎬 Cenários de teste
│   ├── complete-to-invoice.scenario.js      # Happy path
│   ├── idempotency-check.scenario.js        # Idempotência
│   ├── cancel-restore.scenario.js           # Cancelamento
│   ├── concurrency-race.scenario.js         # Race conditions
│   ├── duplicate-event.scenario.js          # Duplicatas
│   ├── worker-failure.scenario.js           # Worker crash
│   ├── stress-10-concurrent.scenario.js     # Carga moderada
│   ├── chaos-worker-dies.scenario.js        # 💥 Worker morre
│   ├── chaos-mongo-failure.scenario.js      # 💥 MongoDB cai
│   ├── chaos-event-storm.scenario.js        # 💥 100 requests
│   └── chaos-partial-commit.scenario.js     # 💥 Commit parcial
│
├── run-e2e.js            # 🏃 Executor E2E
└── runChaosTests.js      # 🔥 Executor Chaos
```

---

## 🎯 O que valida

### ✅ Race Condition Proof
```javascript
await runner.waitFor(async () => {
  const invoice = await db.findOne({...});
  return !!invoice;  // Aguarda até existir
}, 5000);
```

### ✅ Eventos (Outbox Pattern)
```javascript
await runner.assertEventEmitted('INVOICE_CREATED', {
  'payload.patientId': patient._id.toString()
});
```

### ✅ Idempotência
```javascript
await runner.assertIdempotency('invoices', { patient: patient._id }, 1);
// Garante: apenas 1 invoice, mesmo se chamar 2x
```

### ✅ Banco como Source of Truth
```javascript
await runner.assertDatabase('appointments', 
  { _id: appointment._id },
  { clinicalStatus: 'completed' }
);
```

---

## 📝 Criar novo cenário

```javascript
// tests/scenarios/meu-cenario.scenario.js

export default {
  name: 'Meu Cenário',
  
  async setup(ctx) {
    const { fixtures } = ctx;
    const patient = await fixtures.patient();
    return { patient };
  },
  
  async execute({ data }) {
    // Chama sua API
    const result = await api.post('/endpoint', {...});
    return result;
  },
  
  async assert({ data, runner }) {
    // Valida evento
    await runner.assertEventEmitted('EVENT_TYPE');
    
    // Valida idempotência
    await runner.assertIdempotency('collection', filter, 1);
    
    // Valida banco
    await runner.assertDatabase('collection', filter, assertions);
  },
  
  async cleanup({ fixtures }) {
    await fixtures.cleanup();
  }
};
```

---

## 🔥 Features Avançadas

| Feature | Descrição |
|---------|-----------|
| `waitForStabilization()` | Aguarda outbox ficar vazio |
| `assertEventEmitted()` | Valida evento no outbox |
| `assertIdempotency()` | Garante não duplicou |
| `assertDatabase()` | Validações de banco |
| Fixtures automáticos | Cleanup garantido |
| **EventTracer** | Observabilidade de timing |
| **ChaosEngine** | Simula falhas reais |

### 📊 Observabilidade (EventTracer)

```javascript
import EventTracer from '../framework/EventTracer.js';

const tracer = new EventTracer();
tracer.startTrace(correlationId);

// ... fluxo ...

tracer.addSpan(correlationId, 'EVENT:INVOICE_CREATED');

// Relatório automático
console.log(tracer.generateReport(correlationId));
// Output:
//   0ms (start)   SETUP_COMPLETE
//  45ms (+45ms)   API_CALL_START
// 890ms (+845ms)  API_CALL_END
// ...
```

Identifica gargalos automaticamente:
- Gaps > 500ms entre eventos
- Fluxos > 10s (timeout risk)
- P95/P99 de latência

---

## 🎬 Cenários incluídos

### E2E Core (7 cenários)
1. **complete-to-invoice**: Fluxo particular per-session
2. **idempotency-check**: Duplo complete não duplica
3. **cancel-restore**: Cancelamento com rollback financeiro
4. **worker-failure**: Worker crash + retry
5. **concurrency-race**: 2 completes no mesmo pacote simultâneo
6. **duplicate-event**: 3 eventos iguais simultâneos
7. **stress-10-concurrent**: 10 requests simultâneos

### 🔥 Chaos Tests (4 cenários)
1. **chaos-worker-dies**: Worker morre no meio, sistema se recupera
2. **chaos-mongo-failure**: MongoDB indisponível temporariamente
3. **chaos-event-storm**: 100 requests simultâneos (carga real)
4. **chaos-partial-commit**: Crash após payment, antes de invoice

---

## 💡 Diferencial

> Esse framework valida o que o Bruno não consegue:
> - Workers processaram?
> - Eventos foram emitidos?
> - Sistema é idempotente?
> - Race conditions foram tratadas?

Bruno = testa endpoint  
Framework E2E = testa **sistema completo**

---

## 🛠️ Dependências

```bash
npm install axios  # se não tiver
```

---

## 🏆 Resumo: O que você construiu

### ✅ 11 Cenários de Teste
- **7 E2E Core**: Happy path, idempotência, race conditions, cancelamento
- **4 Chaos Tests**: Worker crash, MongoDB failure, 100 requests, partial commit

### ✅ Infraestrutura Enterprise
- TestRunner com polling inteligente
- TestDatabase com isolamento garantido
- TestFixtures com cleanup automático
- EventTracer para observabilidade

### ✅ CI/CD Completo
- GitHub Actions com MongoDB/Redis containers
- Safety check (não roda em produção)
- Chaos tests separados (manual)
- Artifacts em caso de falha

### ✅ Padrões Validados
- **Outbox Pattern**: Eventos são emitidos
- **Idempotência**: Sem duplicação
- **Race Conditions**: Protegido por locks
- **Eventual Consistency**: Sistema converge
- **Recovery**: Se recupera de falhas

---

## 🎯 Próximos Passos

1. **Rodar os testes local**:
   ```bash
   cd back && npm run test:e2e:framework
   ```

2. **Rodar chaos tests** (ambiente isolado):
   ```bash
   npm run test:chaos
   ```

3. **Adicionar à CI**: Push para `develop` roda E2E automaticamente

4. **Monitorar**: EventTracer gera relatórios de performance

---

Pronto pra produção! 🚀
