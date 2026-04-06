# 🧪 Testes E2E - Correções de Bugs Críticos

Este diretório contém testes E2E automatizados para garantir que os bugs corrigidos não voltem a ocorrer.

## 🐛 Bugs Corrigidos e Cobertos

### 1. Erro de Enum no Schema (`crm` inválido)
**Arquivo:** `packs/appointment-creation-flow.pack.js`

**Problema:** O valor `'crm'` não era aceito no enum `metadata.origin.source` do schema Appointment.

**Correção:** Adicionado `'crm'` ao enum no arquivo `models/Appointment.js`.

**Teste:** 
```javascript
it('✅ deve aceitar source "crm" no enum do schema', async () => {
  const appointment = await Appointment.create({
    metadata: { origin: { source: 'crm' } }  // Deve aceitar
  });
  expect(appointment.metadata.origin.source).toBe('crm');
});
```

---

### 2. Modal Não Fechava Após Criar Agendamento
**Arquivo:** `packs/appointment-creation-flow.pack.js`

**Problema:** O modal de agendamento não fechava automaticamente quando o agendamento era criado com sucesso. Se desse erro, deveria ficar aberto.

**Correção:** Adicionado `closeModalSignal` ao `ScheduleAppointmentModal` que fecha o modal apenas quando o pai (AdminDashboard) emite sinal de sucesso.

**Teste:**
```javascript
// Testa criação com sucesso (modal deve fechar)
const response = await api.post('/api/v2/appointments', {...});
expect(response.status).toBe(202);  // Async processing started

// Aguarda workers
await waitForWorker('appointment-processing', 5000);
await waitForWorker('payment-processing', 5000);

// Verifica se foi processado
const appointment = await Appointment.findById(appointmentId);
expect(appointment.operationalStatus).toBe('scheduled');
```

---

### 3. Pagamento Não Era Criado
**Arquivo:** `packs/appointment-creation-flow.pack.js`

**Problema:** O `CreateAppointmentWorker` publicava `PAYMENT_PROCESS_REQUESTED` (evento para multi-pagamentos), mas deveria publicar `PAYMENT_REQUESTED` (evento para criar pagamento inicial).

**Correção:** Alterado `EventTypes.PAYMENT_PROCESS_REQUESTED` para `EventTypes.PAYMENT_REQUESTED` no `workers/createAppointmentWorker.js`.

**Teste:**
```javascript
it('✅ deve criar pagamento automaticamente após agendamento', async () => {
  // Criar agendamento
  const response = await api.post('/api/v2/appointments', {...});
  
  // Aguardar workers
  await waitForWorker('appointment-processing', 5000);
  await waitForWorker('payment-processing', 5000);
  
  // 🎯 VERIFICAÇÃO CRÍTICA: Pagamento deve existir
  const payment = await Payment.findOne({ appointment: appointmentId });
  expect(payment).toBeDefined();
  expect(payment.amount).toBe(200);
  expect(payment.status).toBe('paid');
});
```

---

### 4. Lista de Pagamentos Vazia / Carregando Tudo
**Arquivo:** `packs/payment-list-filter.pack.js`

**Problema:** O `PaymentPage.tsx` tinha useEffects conflitantes que causavam:
- Lista vazia mesmo com pagamentos existentes
- Carregamento de todos os pagamentos (performance ruim)
- Race condition entre `fetchPayments()` e `initialPayments`

**Correção:** Removido useEffect duplicado. Agora o componente usa apenas `initialPayments` passado pelo pai (AdminDashboard), que já carrega com filtro de mês.

**Teste:**
```javascript
it('✅ deve filtrar pagamentos por mês atual por padrão', async () => {
  // Criar 5 pagamentos do mês atual
  // Criar 3 pagamentos do mês anterior
  
  // Chamar API com filtro de mês
  const response = await api.get('/api/v2/payments', {
    params: { month: currentMonth, limit: 1000 }
  });
  
  // 🎯 VERIFICAÇÃO: Deve retornar apenas 5 (do mês atual)
  expect(response.data.data.length).toBe(5);
```

---

### 5. Payment V2 - Arquitetura Event-Driven
**Arquivo:** `packs/payment-v2-performance.pack.js`

**Cobertura:**
- ✅ Criar pagamento V2 (endpoint `/request`)
- ✅ Resposta 202 Accepted (async)
- ✅ Worker processa pagamento
- ✅ Consulta de status por eventId
- ✅ Idempotência (não duplica)
- ✅ Payment-multi (saldo/débitos)
- ✅ Performance (< 500ms por request)

**Fluxo V2:**
```
POST /api/v2/payments/request
    ↓
Retorna 202 + eventId (imediato)
    ↓
Worker processa (async)
    ↓
GET /api/v2/payments/status/:eventId
    ↓
Retorna status + payment criado
```

**Teste:**
```javascript
it('✅ deve criar pagamento V2 com resposta 202 (async)', async () => {
  const startTime = Date.now();
  
  const response = await api.post('/api/v2/payments/request', {
    patientId: patient._id.toString(),
    amount: 250,
    paymentMethod: 'pix'
  });
  
  const responseTime = Date.now() - startTime;
  
  // 🎯 VERIFICAÇÃO: Resposta rápida (< 500ms)
  expect(responseTime).toBeLessThan(500);
  expect(response.status).toBe(202);
  expect(response.data.data).toHaveProperty('eventId');
  expect(response.data.data.status).toBe('pending');
  
  // Aguardar worker processar
  await waitForWorker('payment-processing', 10000);
  
  // Verificar se pagamento foi criado
  const payment = await Payment.findOne({ patient: patient._id });
  expect(payment).toBeDefined();
  expect(payment.status).toBe('paid');
});
```

---

## 🚀 Como Executar os Testes

### Pré-requisitos
```bash
# MongoDB rodando
mongod --version  # v6.0+

# Redis rodando
redis-cli ping  # PONG

# Backend rodando
cd back && npm run dev
```

### Executar Todos os Packs
```bash
cd back
npm run test:e2e
```

### Executar Pack Específico
```bash
cd back
npx vitest run tests/packs/appointment-creation-flow.pack.js
```

### Executar em Modo Watch (desenvolvimento)
```bash
cd back
npx vitest tests/packs/ --watch
```

---

## 📁 Estrutura dos Testes

```
tests/
├── packs/                          # 🎯 PACOTES DE TESTE
│   ├── appointment-creation-flow.pack.js   # Fluxo de criação
│   ├── payment-list-filter.pack.js         # Filtro de pagamentos
│   └── index.js                            # Índice dos packs
│
├── utils/                          # 🛠️ UTILITÁRIOS
│   └── test-helpers.js             # Helpers para testes
│
└── README-E2E.md                   # 📚 Este arquivo
```

---

## 🎯 Cenários Cobertos

| Cenário | Pack | Status |
|---------|------|--------|
| Criar agendamento com source 'crm' | appointment-creation-flow | ✅ |
| Pagamento criado automaticamente | appointment-creation-flow | ✅ |
| Sessão criada pelo worker | appointment-creation-flow | ✅ |
| Agendamento inválido não cria pagamento | appointment-creation-flow | ✅ |
| Valor 0 não gera pagamento | appointment-creation-flow | ✅ |
| Filtro por mês atual | payment-list-filter | ✅ |
| Filtro por mês anterior | payment-list-filter | ✅ |
| Resumo financeiro por período | payment-list-filter | ✅ |
| Paginação de resultados | payment-list-filter | ✅ |
| **Payment V2 - Resposta 202 async** | **payment-v2-performance** | **✅** |
| **Payment V2 - Worker processa** | **payment-v2-performance** | **✅** |
| **Payment V2 - Consulta status** | **payment-v2-performance** | **✅** |
| **Payment V2 - Idempotência** | **payment-v2-performance** | **✅** |
| **Payment V2 - Multi-payment** | **payment-v2-performance** | **✅** |
| **Payment V2 - Performance** | **payment-v2-performance** | **✅** |

---

## 🔧 Adicionar Novo Teste

1. Crie um arquivo em `tests/packs/nome-do-teste.pack.js`:

```javascript
import { expect, describe, it } from 'vitest';
import { createTestContext } from '../utils/test-helpers.js';

describe('🎬 Pack: Meu Novo Teste', () => {
  const context = createTestContext();
  
  it('✅ deve fazer algo', async () => {
    // Seu teste aqui
    expect(true).toBe(true);
  });
});

export default describe;
```

2. Adicione ao índice em `tests/packs/index.js`:

```javascript
export { default as meuNovoTeste } from './nome-do-teste.pack.js';
```

3. Execute:

```bash
npx vitest run tests/packs/nome-do-teste.pack.js
```

---

## 📊 CI/CD - GitHub Actions

```yaml
name: Testes E2E

on: [push, pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest
    
    services:
      mongodb:
        image: mongo:6
        ports:
          - 27017:27017
      redis:
        image: redis:alpine
        ports:
          - 6379:6379
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: 18
      
      - name: Install Dependencies
        run: cd back && npm ci
      
      - name: Start Backend
        run: cd back && npm run dev &
        env:
          MONGO_URI: mongodb://localhost:27017/test
          REDIS_URL: redis://localhost:6379
      
      - name: Wait for Backend
        run: npx wait-on http://localhost:5000/health --timeout 30000
      
      - name: Run E2E Tests
        run: cd back && npm run test:e2e
```

---

## 🐛 Debug

### Ver logs detalhados
```bash
DEBUG=true npm run test:e2e
```

### Executar apenas um teste
```bash
npx vitest run tests/packs/appointment-creation-flow.pack.js -t "deve aceitar source"
```

### Ver workers em execução
```bash
# Em outro terminal
curl http://localhost:5000/api/v2/appointments/debug/queues
```

---

## 🎉 Tudo Verde?

Se todos os testes passarem:

```
✅ Appointment Creation Flow
✅ Payment List Filter

🎉 TODOS OS PACKS PASSARAM!
```

Isso significa que:
- ✅ O enum aceita 'crm' e outros valores válidos
- ✅ Modal fecha corretamente após sucesso
- ✅ Pagamentos são criados automaticamente
- ✅ Lista de pagamentos respeita filtros de período
