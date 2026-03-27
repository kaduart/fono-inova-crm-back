# 🧪 Guia de Testes - Arquitetura Financeira v4.0

## 📋 Índice

1. [Testes Automatizados](#testes-automatizados)
2. [Testes Manuais](#testes-manuais)
3. [Verificação no Banco](#verificação-no-banco)
4. [Cenários de Teste](#cenários-de-teste)

---

## 🚀 Testes Automatizados

### Executar todos os testes v4.0

```bash
cd /home/user/projetos/crm/back

# Testes unitários
npm test -- tests/unit/paymentArchitecture.v4.test.js

# Testes de integração
npm test -- tests/integration/appointment-complete.v4.test.js

# Todos os testes
npm test
```

### O que é testado?

| Componente | Cobertura |
|------------|-----------|
| PaymentResolver | ✅ 5 cenários de pagamento |
| Payment State Machine | ✅ pending → paid/cancelled |
| FinancialEvent | ✅ Audit trail |
| Compensation | ✅ Saga pattern |
| Correlation ID | ✅ Rastreabilidade |

---

## 🔧 Testes Manuais

### 1. Script Automatizado

```bash
# Dar permissão
chmod +x /home/user/projetos/crm/back/tests/scripts/test-v4-manual.sh

# Executar (sem autenticação - para testes locais)
./tests/scripts/test-v4-manual.sh http://localhost:3000

# Com token de autenticação
./tests/scripts/test-v4-manual.sh http://localhost:3000 SEU_TOKEN_JWT
```

### 2. Testes via curl

#### Cenário 1: Sessão Particular Avulsa
```bash
# Criar agendamento
curl -X POST http://localhost:3000/api/appointments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-correlation-id: test_particular_$(date +%s)" \
  -d '{
    "patient": "ID_PACIENTE",
    "doctor": "ID_MEDICO", 
    "date": "2024-03-27",
    "time": "10:00",
    "duration": 50,
    "reason": "Teste v4.0",
    "sessionValue": 150
  }'

# Completar
curl -X PATCH http://localhost:3000/api/appointments/ID_AGENDAMENTO/complete \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-correlation-id: test_particular_$(date +%s)"
```

#### Cenário 2: Saldo Devedor (Fiado)
```bash
curl -X PATCH http://localhost:3000/api/appointments/ID_AGENDAMENTO/complete \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-correlation-id: test_fiado_$(date +%s)" \
  -d '{
    "addToBalance": true,
    "balanceAmount": 200,
    "balanceDescription": "Pagamento pendente"
  }'
```

#### Cenário 3: Pacote Per-Session
```bash
# Criar pacote primeiro
curl -X POST http://localhost:3000/api/packages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "patient": "ID_PACIENTE",
    "doctor": "ID_MEDICO",
    "type": "particular",
    "paymentType": "per-session",
    "totalSessions": 10,
    "sessionValue": 150
  }'

# Criar agendamento vinculado ao pacote
curl -X POST http://localhost:3000/api/appointments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "patient": "ID_PACIENTE",
    "doctor": "ID_MEDICO",
    "package": "ID_PACOTE",
    "date": "2024-03-27",
    "time": "10:00"
  }'

# Completar
curl -X PATCH http://localhost:3000/api/appointments/ID_AGENDAMENTO/complete \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-correlation-id: test_persession_$(date +%s)"
```

---

## 🗄️ Verificação no Banco

### MongoDB Queries

```javascript
// 1. Verificar Payments criados com v4.0
db.payments.find({
  paymentOrigin: { $exists: true }
}, {
  _id: 1,
  status: 1,
  paymentOrigin: 1,
  correlationId: 1,
  confirmedAt: 1,
  canceledAt: 1
}).sort({ createdAt: -1 })

// 2. Verificar Sessions com rastreabilidade
db.sessions.find({
  correlationId: { $exists: true }
}, {
  _id: 1,
  status: 1,
  paymentOrigin: 1,
  correlationId: 1
})

// 3. Verificar FinancialEvents (audit trail)
db.financialevents.find().sort({ timestamp: -1 }).limit(10)

// 4. Buscar todos os eventos de uma transação específica
db.financialevents.find({
  correlationId: "SEU_CORRELATION_ID"
})

// 5. Verificar payments compensados (cancelados)
db.payments.find({
  status: 'canceled',
  cancellationReason: 'transaction_rollback'
})

// 6. Estatísticas por origem de pagamento
db.payments.aggregate([
  { $match: { paymentOrigin: { $exists: true } } },
  { $group: {
    _id: "$paymentOrigin",
    count: { $sum: 1 },
    totalAmount: { $sum: "$amount" }
  }}
])
```

---

## 🎯 Cenários de Teste

### ✅ Cenário 1: Fluxo Feliz - Particular Avulso

**Passos:**
1. Criar agendamento particular
2. Chamar `/complete`

**Verificações:**
- [ ] Payment criado com `status: 'pending'` inicialmente
- [ ] Payment atualizado para `status: 'paid'` após commit
- [ ] `confirmedAt` preenchido
- [ ] `paymentOrigin: 'auto_per_session'`
- [ ] `correlationId` presente em Payment e Session
- [ ] FinancialEvent criado

### ✅ Cenário 2: Saldo Devedor

**Passos:**
1. Criar agendamento
2. Chamar `/complete` com `addToBalance: true`

**Verificações:**
- [ ] Nenhum Payment criado
- [ ] PatientBalance atualizado
- [ ] `paymentOrigin: 'manual_balance'` na Session
- [ ] FinancialEvent com `addToBalance: true`

### ✅ Cenário 3: Pacote Per-Session

**Passos:**
1. Criar pacote com `paymentType: 'per-session'`
2. Criar agendamento vinculado
3. Chamar `/complete`

**Verificações:**
- [ ] Payment criado vinculado ao pacote
- [ ] Package.sessionsDone incrementado
- [ ] Package.totalPaid atualizado
- [ ] `paymentOrigin: 'auto_per_session'`

### ✅ Cenário 4: Compensação (Falha Simulada)

**Passos:**
1. Criar agendamento
2. Simular erro no código (temporariamente)
3. Chamar `/complete`

**Verificações:**
- [ ] Payment criado
- [ ] Payment **não deletado**
- [ ] Payment atualizado para `status: 'canceled'`
- [ ] `cancellationReason: 'transaction_rollback'`
- [ ] `canceledAt` preenchido

### ✅ Cenário 5: Idempotência

**Passos:**
1. Chamar `/complete` no mesmo agendamento 2x

**Verificações:**
- [ ] Segunda chamada retorna sucesso (não erro)
- [ ] Apenas 1 Payment criado
- [ ] Sem duplicação de FinancialEvent

---

## 📊 Verificação de Performance

```bash
# Teste de carga simples (10 requisições)
for i in {1..10}; do
  time curl -X PATCH http://localhost:3000/api/appointments/ID/complete \
    -H "Authorization: Bearer $TOKEN" \
    -o /dev/null -s -w "%{http_code}\n"
done

# Todas devem retornar 200 em menos de 500ms
```

**Métricas Esperadas:**
- P95 < 400ms (local)
- P95 < 600ms (produção com MongoDB Atlas)

---

## 🔍 Debug

### Logs a observar no backend:

```
# Sucesso
[complete] Iniciando - addToBalance: false, correlationId: corr_xxx
[complete] ✅ PER-SESSION: Payment criado: 65f...
[complete] ✅ Transação commitada
[complete] ✅ Payment confirmado (fora da transação)
[complete] ✅ FinancialEvent criado

# Compensação
[complete] 🔄 Compensação: Cancelando payment 65f...
[complete] ✅ Payment cancelado (compensação)
```

### Erros críticos:

```
🚨 PAYMENT CONFIRMATION FAILED - correlationId: corr_xxx
🚨 AUDIT LOG FAILED - correlationId: corr_xxx
```

---

## ✅ Checklist Final

Antes de deployar em produção:

- [ ] Todos os testes unitários passando
- [ ] Testes de integração passando
- [ ] Testes manuais executados
- [ ] Payments com `paymentOrigin` preenchido
- [ ] FinancialEvents sendo criados
- [ ] Correlation ID fluindo front → back
- [ ] Compensação testada (simular erro)
- [ ] Performance dentro do esperado
- [ ] Queries MongoDB validadas

---

## 🆘 Troubleshooting

### Payment fica em `pending` para sempre

**Causa provável:** Erro na confirmação após commit
**Verificação:**
```javascript
db.payments.find({ 
  status: 'pending',
  createdAt: { $lt: new Date(Date.now() - 60000) }
})
```

### FinancialEvent não criado

**Causa provável:** Erro silencioso (fire-and-forget)
**Verificação:** Verificar logs por `🚨 AUDIT LOG FAILED`

### Correlation ID não presente

**Causa provável:** Front não enviando header
**Verificação:** Verificar se `x-correlation-id` está nos headers das requisições
