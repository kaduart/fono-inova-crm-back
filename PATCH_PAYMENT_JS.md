# 🔧 Patch: Payment.js com Eventos

> Arquivo #1 - Maior impacto no PatientsView

---

## 📋 O que foi adicionado

### 1. Helpers de emissão de eventos (topo do arquivo)

```javascript
// Import do eventPublisher
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

// Helper para emitir eventos de pagamento
async function emitPaymentEvent(eventType, payment, additionalData = {}) {
  await publishEvent(eventType, {
    paymentId: payment._id?.toString(),
    patientId: payment.patient?.toString(),
    amount: payment.amount,
    paymentMethod: payment.paymentMethod,
    ...additionalData
  });
}

// Helper para emitir eventos de appointment
async function emitAppointmentEvent(eventType, appointmentId, additionalData = {}) {
  // Busca appointment e emite evento
}
```

### 2. Eventos em cada operação

| Rota | Evento | Quando |
|------|--------|--------|
| `POST /` | `PAYMENT_RECEIVED` | Após criar pagamento |
| `POST /` | `APPOINTMENT_UPDATED` | Se vinculado a appointment |
| `POST /advance` | `PAYMENT_RECEIVED` | Pagamento adiantado |
| `POST /advance` | `SESSION_CREATED` | Para cada sessão futura |
| `PUT /:id` | `PAYMENT_UPDATED` | Ao atualizar |
| `PUT /:id` | `PAYMENT_RECEIVED` | Se status mudar para paid |
| `DELETE /:id` | `PAYMENT_DELETED` | Antes de deletar |
| `POST /multi` | `PAYMENT_RECEIVED` | Para cada pagamento |

---

## 🚀 Como aplicar

### Opção 1: Substituir arquivo (recomendado)

```bash
# Backup do original
cp back/routes/Payment.js back/routes/Payment.js.backup.$(date +%Y%m%d)

# Substituir
mv back/routes/Payment.patched.js back/routes/Payment.js

# Restartar servidor
pm2 restart server
```

### Opção 2: Merge manual (se tem mudanças locais)

1. Abra `Payment.js` e `Payment.patched.js`
2. Copie os **helpers** (linhas 15-65 do patched)
3. Adicione **import do eventPublisher**
4. Em cada operação CRUD, adicione chamada ao helper

---

## 🧪 Testar após aplicar

```bash
# 1. Criar pagamento simples
curl -X POST http://localhost:5000/api/payments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "patientId": "...",
    "amount": 150.00,
    "paymentMethod": "pix"
  }'

# 2. Verificar se evento foi emitido
# Logs devem mostrar: "[PaymentRoutes] Evento emitido: PAYMENT_RECEIVED"

# 3. Verificar se PatientsView atualizou
node scripts/validateConsistency.js
```

---

## ✅ Checklist de validação

- [ ] Server reiniciou sem erros
- [ ] Criar pagamento → evento no log
- [ ] Atualizar pagamento → evento no log  
- [ ] Deletar pagamento → evento no log
- [ ] PatientsView atualiza corretamente
- [ ] Audit mostra cobertura aumentada

---

## 📊 Resultado esperado

Antes: **14.1%** cobertura  
Depois: **~25%** cobertura (aproximado)

---

## ⚠️ Cuidados

1. **Sempre** emite evento APÓS a operação no banco
2. **Nunca** deixe o evento quebrar a operação (try/catch)
3. **Sempre** inclua `patientId` no payload
4. **Teste** cada rota após aplicar

---

**Pronto para aplicar!** 🚀
