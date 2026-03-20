# ⚖️ Implementação do Tipo de Pacote "Liminar"

## Resumo

Foi implementado o suporte ao tipo de pacote **"liminar"** no sistema Medi-Track, permitindo o gerenciamento de pacotes judiciais com reconhecimento de receita diferida por sessão.

---

## 🎯 Funcionalidades

### 1. **Tipo de Pacote Liminar**
- Novo tipo `liminar` adicionado ao enum `type` do modelo Package
- Modo de operação: `hybrid` (receita diferida, reconhecida por sessão)

### 2. **Campos Específicos**

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `liminarProcessNumber` | String | Número do processo judicial |
| `liminarCourt` | String | Vara ou cartório responsável |
| `liminarExpirationDate` | Date | Data de validade da liminar (opcional) |
| `liminarMode` | String | `deferred`, `immediate` ou `hybrid` |
| `liminarAuthorized` | Boolean | Se a liminar está autorizada |
| `liminarCreditBalance` | Number | Saldo de crédito disponível |
| `liminarTotalCredit` | Number | Valor total do crédito |
| `recognizedRevenue` | Number | Valor da receita já reconhecida |

### 3. **Reconhecimento de Receita por Sessão**

Quando uma sessão de pacote liminar é **completada**:
1. O valor da sessão é subtraído do `liminarCreditBalance`
2. O valor é adicionado ao `recognizedRevenue`
3. Um registro de `Payment` com `kind: 'revenue_recognition'` é criado
4. O `totalPaid` do pacote é incrementado

Quando uma sessão é **descompletada** (volta de completed para outro status):
1. O valor é restaurado ao `liminarCreditBalance`
2. O `recognizedRevenue` é decrementado
3. O registro de `Payment` é removido
4. O `totalPaid` do pacote é decrementado

---

## 📋 Modelos Alterados

### Package.js
```javascript
type: {
  type: String,
  enum: ['therapy', 'convenio', 'liminar'],  // ← Adicionado 'liminar'
  default: 'therapy'
}

// Novos campos específicos para liminar
liminarProcessNumber: String
liminarCourt: String
liminarExpirationDate: Date
liminarMode: { enum: ['deferred', 'immediate', 'hybrid'] }
liminarAuthorized: Boolean
liminarCreditBalance: Number
liminarTotalCredit: Number
recognizedRevenue: Number
```

### Session.js
```javascript
paymentMethod: {
  enum: ['dinheiro', 'pix', 'cartão', 'convenio', 'liminar_credit']  // ← Adicionado
}

paymentStatus: {
  enum: ['paid', 'partial', 'pending', 'pending_receipt', 'recognized']  // ← Adicionado
}
```

### Payment.js
```javascript
kind: {
  enum: ['package_receipt', 'session_payment', 'manual', 'auto', 'session_completion', 'revenue_recognition']  // ← Adicionado
}

paymentMethod: {
  enum: [..., 'liminar_credit']  // ← Adicionado
}

status: {
  enum: [..., 'recognized']  // ← Adicionado
}
```

---

## 🔌 API - Exemplos de Uso

### Criar Pacote Liminar

**POST** `/api/packages`

```json
{
  "type": "liminar",
  "date": "2026-03-20",
  "patientId": "...",
  "doctorId": "...",
  "specialty": "fonoaudiologia",
  "sessionType": "fonoaudiologia",
  "sessionValue": 125.00,
  "totalSessions": 48,
  "selectedSlots": [
    { "date": "2026-03-20", "time": "09:00" },
    { "date": "2026-03-21", "time": "09:00" }
  ],
  "liminarProcessNumber": "1234567-89.2026.8.01.0000",
  "liminarCourt": "1ª Vara Cível de Anápolis",
  "liminarExpirationDate": "2026-09-20",
  "liminarMode": "hybrid",
  "liminarAuthorized": true
}
```

**Nota:** Todos os campos `liminar*` são **opcionais**. Você pode criar um pacote liminar mínimo:

```json
{
  "type": "liminar",
  "date": "2026-03-20",
  "patientId": "...",
  "doctorId": "...",
  "specialty": "fonoaudiologia",
  "sessionType": "fonoaudiologia",
  "sessionValue": 125.00,
  "totalSessions": 48,
  "selectedSlots": [...]
}
```

### Completar Sessão (Reconhece Receita)

**PUT** `/api/packages/:id/sessions/:sessionId`

```json
{
  "date": "2026-03-20",
  "time": "09:00",
  "status": "completed"
}
```

**Resposta:**
```json
{
  "success": true,
  "session": {
    "status": "completed",
    "isPaid": true,
    "paymentStatus": "recognized",
    "visualFlag": "ok"
  },
  "package": {
    "liminarCreditBalance": 5875.00,  // ← Reduzido em 125.00
    "recognizedRevenue": 125.00,       // ← Incrementado
    "totalPaid": 125.00
  }
}
```

---

## 💰 Fluxo Financeiro

```
┌─────────────────────────────────────────────────────────────┐
│  CRIAÇÃO DO PACOTE                                          │
│  ─────────────────                                          │
│  • liminarTotalCredit = R$ 6.000,00                         │
│  • liminarCreditBalance = R$ 6.000,00                       │
│  • recognizedRevenue = R$ 0,00                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  SESSÃO COMPLETADA                                          │
│  ─────────────────                                          │
│  • liminarCreditBalance -= R$ 125,00  → R$ 5.875,00        │
│  • recognizedRevenue += R$ 125,00     → R$ 125,00          │
│  • Cria Payment: kind='revenue_recognition'                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  SESSÃO DESCOMPLETADA                                       │
│  ─────────────────────                                      │
│  • liminarCreditBalance += R$ 125,00  → R$ 6.000,00        │
│  • recognizedRevenue -= R$ 125,00     → R$ 0,00            │
│  • Remove Payment: kind='revenue_recognition'               │
└─────────────────────────────────────────────────────────────┘
```

---

## 💡 Dica Importante: Reversão de Crédito

**Não é necessário cancelar a sessão para recuperar o crédito!**

Basta alterar o status da sessão de `completed` para qualquer outro (`scheduled`, `pending`, etc.) e o sistema automaticamente:
1. Restaura o valor ao `liminarCreditBalance`
2. Reduz o `recognizedRevenue`
3. Remove o registro de reconhecimento de receita

Isso permite corrigir erros sem perder o histórico da sessão.

---

## 📊 Dashboard e Relatórios

Os seguintes dados estão disponíveis para relatórios:

- **Crédito Total:** `liminarTotalCredit`
- **Crédito Disponível:** `liminarCreditBalance`
- **Receita Reconhecida:** `recognizedRevenue`
- **Número do Processo:** `liminarProcessNumber`
- **Vara:** `liminarCourt`

### Query de Exemplo (MongoDB)

```javascript
// Listar todos os pacotes liminar ativos
Package.find({
  type: 'liminar',
  status: 'active'
});

// Total de receita reconhecida por vara
Package.aggregate([
  { $match: { type: 'liminar' } },
  { $group: {
    _id: '$liminarCourt',
    totalRevenue: { $sum: '$recognizedRevenue' },
    totalCredit: { $sum: '$liminarTotalCredit' }
  }}
]);
```

---

## 🚨 Validações e Comportamentos

### Campos Opcionais
Todos os campos de liminar são **OPCIONAIS**:
- `liminarProcessNumber` - pode ser nulo
- `liminarCourt` - pode ser nulo
- `liminarExpirationDate` - pode ser nulo

### Comportamentos Automáticos
1. **Reconhecimento de Receita:** Ao marcar sessão como `completed`, o crédito é consumido automaticamente
2. **Reversão de Crédito:** Ao alterar status de `completed` para outro (ex: `scheduled`), o crédito **VOLTA** automaticamente
   - 💡 **Não é necessário cancelar a sessão!** Só alterar o status.
3. Sessões canceladas não reconhecem receita
4. Saldo de crédito nunca fica negativo

---

## ✅ Testes Recomendados

1. Criar pacote liminar com dados completos
2. Completar sessão e verificar reconhecimento de receita
3. Descompletar sessão e verificar reversão
4. Verificar que convênio e particular não são afetados
5. Verificar relatórios de receita reconhecida

---

## 📝 Notas Técnicas

- As alterações são **retrocompatíveis** (não quebram pacotes existentes)
- Pacotes `therapy` e `convenio` continuam funcionando normalmente
- O campo `type` tem default `'therapy'`, então pacotes existentes não precisam de migração
- A lógica de reconhecimento de receita só é acionada quando `type === 'liminar'`
