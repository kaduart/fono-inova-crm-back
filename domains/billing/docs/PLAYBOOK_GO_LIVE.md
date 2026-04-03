# PLAYBOOK GO-LIVE V2 - 15 MINUTOS

> ⚠️ Execute na ordem. Não pule etapas.

---

## PRÉ-REQUISITOS (Antes de começar)

```bash
# 1. Backup (2 min)
mongodump --uri="$MONGO_URI" --out="/backup/billing-$(date +%Y%m%d-%H%M%S)"

# 2. Verificar variáveis de ambiente
echo $REDIS_HOST
echo $REDIS_PORT
# Devem estar configurados

# 3. Status atual das flags
node -e "
const ff = require('./config/FeatureFlags.js').default;
ff.getAllStatus().then(s => console.log(JSON.stringify(s, null, 2)));
"
# Todas devem estar: false
```

---

## FASE 1: WORKER (3 min)

### 1.1 Subir Worker
```bash
# Deploy do código
npm run deploy:billing-worker

# Ou manual:
node -e "
const { startBillingConsumerWorker } = require('./workers/billingConsumerWorker.js');
startBillingConsumerWorker();
"
```

### 1.2 Verificar
```bash
# Check 1: Worker rodando
curl http://localhost:3000/health/billing-worker
# Deve retornar: { "status": "running", "queue": "billing-orchestrator" }

# Check 2: Redis conectado
redis-cli ping
# Deve retornar: PONG

# Check 3: Fila vazia (inicialmente)
redis-cli LLEN bull:billing-orchestrator:wait
# Deve retornar: (integer) 0
```

### 1.3 Ativar Flag
```javascript
// Execute no mongo shell ou via script
use('crm');
db.featureflags.updateOne(
  { key: 'USE_V2_WORKER' },
  { $set: { enabled: true, updatedAt: new Date(), updatedBy: 'deploy' } },
  { upsert: true }
);
```

**✅ Sucesso:** Worker rodando + flag ativa  
**❌ Rollback:** `db.featureflags.updateOne({ key: 'USE_V2_WORKER' }, { $set: { enabled: false } })`

---

## FASE 2: CREATE (5 min)

### 2.1 Teste de segurança
```javascript
// Crie 1 sessão de TESTE (não use dados reais ainda)
// Verifique se evento foi publicado na fila

redis-cli LRANGE bull:billing-orchestrator:wait 0 -1
// Deve mostrar o job na fila
```

### 2.2 Ativar CREATE
```javascript
use('crm');
db.featureflags.updateOne(
  { key: 'USE_V2_BILLING_CREATE' },
  { $set: { enabled: true, updatedAt: new Date(), updatedBy: 'deploy' } },
  { upsert: true }
);
```

### 2.3 Validar (CRÍTICO)
```javascript
// Query 1: Verificar se criou Appointment
const sessionTeste = db.sessions.findOne({ 
  /* sua query de teste */ 
});

const appointment = db.appointments.findOne({ 
  'source.sessionId': sessionTeste._id 
});

if (!appointment) {
  print("❌ FALHA: Appointment não criado");
  // ROLLBACK IMEDIATO
} else {
  print("✅ Appointment criado:", appointment._id);
}

// Query 2: Verificar Payment
const payment = db.payments.findOne({ session: sessionTeste._id });
if (!payment) {
  print("❌ FALHA: Payment não criado");
} else {
  print("✅ Payment criado:", payment._id);
}

// Query 3: Verificar DUPLICATA (MANDATÓRIO)
const count = db.appointments.countDocuments({ 
  'source.sessionId': sessionTeste._id 
});

if (count > 1) {
  print("❌ DUPLICATA DETECTADA! Count:", count);
  // ROLLBACK IMEDIATO
} else {
  print("✅ Sem duplicata");
}
```

### 2.4 Check de integridade
```bash
# Rodar script de validação
node scripts/validate-billing-v2.js

# Deve retornar:
# ✅ Sessions sem Payment: 0
# ✅ Payments duplicados: 0
# ✅ Guias inconsistentes: 0
```

**✅ Sucesso:** 1 teste ok + sem duplicata  
**❌ Rollback:** Desativar flag + investigar

---

## FASE 3: BILLED (3 min)

### 3.1 Ativar BILLED
```javascript
use('crm');
db.featureflags.updateOne(
  { key: 'USE_V2_BILLING_BILLED' },
  { $set: { enabled: true, updatedAt: new Date(), updatedBy: 'deploy' } },
  { upsert: true }
);
```

### 3.2 Testar faturamento
```javascript
// Publique evento de teste
node -e "
const { publishEvent } = require('./infrastructure/events/eventPublisher.js');
publishEvent('SESSION_BILLED', {
  sessionId: 'ID_DA_SESSION_TESTE',
  billedAmount: 150.00,
  billedAt: new Date(),
  invoiceNumber: 'TEST-001'
});
"

// Aguarde 5 segundos

// Verifique
const payment = db.payments.findOne({ 
  session: ObjectId('ID_DA_SESSION_TESTE') 
});

if (payment.status === 'billed') {
  print("✅ Billed processado");
} else {
  print("❌ Falha no billed. Status:", payment.status);
}
```

**✅ Sucesso:** Status = 'billed'  
**❌ Rollback:** Desativar flag BILLED

---

## FASE 4: RECEIVED (2 min)

### 4.1 Ativar RECEIVED
```javascript
use('crm');
db.featureflags.updateOne(
  { key: 'USE_V2_BILLING_RECEIVED' },
  { $set: { enabled: true, updatedAt: new Date(), updatedBy: 'deploy' } },
  { upsert: true }
);
```

### 4.2 Testar recebimento
```javascript
node -e "
const { publishEvent } = require('./infrastructure/events/eventPublisher.js');
publishEvent('SESSION_RECEIVED', {
  sessionId: 'ID_DA_SESSION_TESTE',
  receivedAmount: 150.00,
  receivedAt: new Date(),
  receiptNumber: 'REC-001'
});
"

// Verifique
const payment = db.payments.findOne({ session: ObjectId('ID_DA_SESSION_TESTE') });
const session = db.sessions.findOne({ _id: ObjectId('ID_DA_SESSION_TESTE') });

if (payment.status === 'paid' && session.isPaid) {
  print("✅ Ciclo completo: paid");
} else {
  print("❌ Falha no received");
}
```

**✅ Sucesso:** Payment='paid' + Session.isPaid=true  
**❌ Rollback:** Desativar flag RECEIVED

---

## PÓS-DEPLOY (Monitoramento)

### Primeiras 2 horas
```bash
# A cada 10 minutos, rode:
node scripts/monitor-billing-v2.js

# Saída esperada:
# ✅ Taxa de sucesso: 100%
# ✅ Duplicatas: 0
# ✅ DLQ: 0
# ⚠️  Processando: X eventos/hora
```

### DLQ (Dead Letter Queue)
```bash
# Se DLQ tiver itens, investigue imediatamente
redis-cli LLEN bull:billing-dlq:wait

# Para ver detalhes:
redis-cli LRANGE bull:billing-dlq:wait 0 0
```

### Rollback de Emergência (1 comando)
```javascript
// EM CASO DE PROBLEMA - EXECUTE IMEDIATAMENTE:

use('crm');
db.featureflags.updateMany(
  { key: { $in: [
    'USE_V2_BILLING_CREATE',
    'USE_V2_BILLING_BILLED', 
    'USE_V2_BILLING_RECEIVED'
  ]}},
  { $set: { enabled: false, updatedAt: new Date(), updatedBy: 'emergency_rollback' }}
);

print("🚨 ROLLBACK EXECUTADO - V2 desativado");
```

---

## CHECKLIST FINAL

- [ ] Backup feito
- [ ] Worker rodando
- [ ] CREATE ativo + testado
- [ ] BILLED ativo + testado  
- [ ] RECEIVED ativo + testado
- [ ] Sem duplicatas
- [ ] DLQ vazia
- [ ] Rollback testado
- [ ] Equipe notificada

---

## COMANDOS RÁPIDOS

```bash
# Status das flags
node -e "const ff=require('./config/FeatureFlags.js').default;ff.getAllStatus().then(s=>console.log(s))"

# Ver filas
redis-cli --scan --pattern 'bull:billing*'

# Matar worker (se necessário)
pkill -f "billingConsumerWorker"

# Limpar fila (emergência)
redis-cli DEL bull:billing-orchestrator:wait
```

---

## CONTATO EMERGÊNCIA

Se der errado:
1. Execute rollback (código acima)
2. Verifique se legado assumiu
3. Chame: [seu-contato]
