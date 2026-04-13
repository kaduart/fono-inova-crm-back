# 📋 V2 API Contract - RFC Oficial

> **Versão:** 2.0.0  
> **Status:** EM VIGOR  
> **Data:** 2026-04-12  

---

## 🎯 PRINCÍPIOS FUNDAMENTAIS

1. **Hard Cut**: V2 não suporta dados V1
2. **Fonte Única de Verdade**: `package.model` determina comportamento
3. **Identidade Padronizada**: `patientId` é sempre ObjectId
4. **Timezone Explícito**: Sempre `-03:00` (America/Sao_Paulo)

---

## 🔑 1. IDENTIDADE: patientId

### Definição
```typescript
patientId: ObjectId  // Ref: Patient
```

### Regras
- ✅ **Sempre** `patientId` (nunca `patient`, `patient_id`, `userId`)
- ✅ **Sempre** ObjectId com ref: 'Patient'
- ✅ **Nunca** aceitar `_id` de view diretamente (resolver antes)
- ❌ **NUNCA** String solta sem validação

### Uso nas Collections
```javascript
// Package, Appointment, Session, Payment, InsuranceGuide, etc.
patientId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'Patient',
  required: true,
  index: true
}
```

### Resolução de ID (APENAS no controller)
```javascript
// ✅ Correto: Resolver no entrypoint
const patientId = await resolvePatientId(req.body.patientId);

// ❌ Errado: Usar direto
const patientId = req.body.patientId;
```

---

## 📦 2. PACKAGE: Model como Fonte da Verdade

### Definição
```typescript
model: 'prepaid' | 'per_session' | 'convenio' | 'liminar'
```

### Regras
- ✅ Campo `model` é **OBRIGATÓRIO** em todos os pacotes V2
- ✅ **NUNCA** inferir de `paymentType` ou outros campos
- ❌ Pacotes sem `model` = **REJEITADOS** com erro `PACKAGE_V2_INCOMPATIBLE`

### Mapeamento BillingType
```javascript
const MODEL_TO_BILLING = {
  'prepaid': 'prepaid',      // Pago antecipado
  'per_session': 'particular', // Pagar por sessão
  'convenio': 'convenio',    // Plano de saúde
  'liminar': 'liminar'       // Judicial
};
```

### Validação no Controller
```javascript
if (type === 'package' && !model) {
  throw new Error('MODEL_REQUIRED: Informe model=prepaid|per_session');
}
```

---

## 📅 3. DATETIME: Timezone São Paulo (-03:00)

### Definição
```typescript
// Todas as datas criadas pelo sistema
date: Date  // Com offset -03:00 explícito
```

### Regras
- ✅ **SEMPRE** usar `-03:00` (nunca depender do default do servidor)
- ✅ **NUNCA** `new Date(dateString)` sem timezone
- ✅ Usar helpers padronizados

### Helpers Oficiais
```javascript
// utils/datetime.js
export function buildDateTime(date, time) {
  return new Date(`${date}T${time}:00-03:00`);
}

export function buildDayRange(date) {
  return {
    $gte: new Date(`${date}T00:00:00-03:00`),
    $lte: new Date(`${date}T23:59:59-03:00`)
  };
}
```

### Uso em Queries
```javascript
// ✅ Correto
const dateRange = buildDayRange(date);
Appointment.find({ date: dateRange });

// ❌ Errado
Appointment.find({ 
  date: { $gte: new Date(date) }  // Sem timezone!
});
```

---

## 📊 4. SCHEDULE: Array de Slots

### Definição
```typescript
schedule: Array<{
  date: string;  // YYYY-MM-DD
  time: string;  // HH:mm
}>
```

### Regras
- ✅ Enviar `schedule` (nunca `selectedSlots`)
- ✅ Formato: `[{date: '2026-04-12', time: '14:00'}]`
- ✅ Backend converte para Date com timezone
- ❌ Nunca enviar objeto complexo

### Exemplo
```javascript
// Request
{
  "patientId": "69d41ec8...",
  "model": "prepaid",
  "schedule": [
    {"date": "2026-04-12", "time": "08:00"},
    {"date": "2026-04-12", "time": "08:40"}
  ]
}
```

---

## 💰 5. FINANCEIRO: Balance Calculation

### Prepaid
```javascript
// Crédito restante (negativo = usou mais do que tinha)
balance = totalValue - (sessionsDone * sessionValue)
financialStatus = balance > 0 ? 'paid_with_credit' : 'paid'
```

### Per-Session
```javascript
// Dívida (positivo) ou crédito (negativo)
balance = (sessionsDone * sessionValue) - totalPaid
financialStatus = balance > 0 ? 'unpaid' : 'paid'
```

### Regras
- ✅ Recalcular em **TODA** mutação (complete, payment, cancel)
- ✅ Usar `$set` (nunca `$inc` no balance)
- ✅ Precisão: 2 casas decimais

---

## 🚫 6. ERROS PADRONIZADOS

### Códigos de Erro V2
```javascript
// Identidade
'PATIENT_ID_INVALID'          // patientId não é ObjectId válido
'PATIENT_NOT_FOUND'           // Paciente não existe

// Package
'MODEL_REQUIRED'              // Campo model ausente
'PACKAGE_V2_INCOMPATIBLE'     // Pacote V1 tentando usar V2
'PACKAGE_INVALID_MODEL'       // Modelo não existe no enum

// Schedule
'SCHEDULE_EMPTY'              // Array vazio
'SCHEDULE_INVALID_SLOT'       // Slot sem date/time
'SCHEDULE_DUPLICATE'          // Slots duplicados

// Financeiro
'SESSION_ALREADY_PAID'        // Tentativa addToBalance em prepaid
'BALANCE_CALCULATION_ERROR'   // Erro no recálculo

// Data/Timestamp
'INVALID_DATE_FORMAT'         // Data não está em ISO
'TIMEZONE_MISSING'            // Offset não especificado
```

### Formato de Erro
```json
{
  "success": false,
  "errorCode": "MODEL_REQUIRED",
  "message": "Para type=package, informe model=prepaid ou per_session",
  "meta": {
    "version": "v2",
    "correlationId": "abc123",
    "timestamp": "2026-04-12T18:30:00-03:00"
  }
}
```

---

## 🔗 7. ENDPOINTS V2 OFICIAIS

### Base: `/api/v2/`

| Recurso | Endpoints |
|---------|-----------|
| Packages | `POST /packages`, `GET /packages/:id`, `PATCH /packages/:id/cancel` |
| Appointments | `POST /appointments`, `PATCH /appointments/:id/complete`, `PATCH /appointments/:id/cancel` |
| Insurance Guides | `GET /insurance-guides`, `POST /insurance-guides`, `PUT /insurance-guides/:id` |
| Patients | `GET /patients`, `GET /patients/:id/balance/details` |
| Webhooks | `POST /webhooks/pix` |

### Regras
- ❌ **NUNCA** chamar V1 de código novo
- ❌ **NUNCA** aceitar payload V1 no V2
- ✅ Sempre retornar `meta.version: "v2"`

---

## 📝 8. CHECKLIST DE IMPLEMENTAÇÃO

### Novo Endpoint V2
- [ ] Usa `patientId` (ObjectId, ref: 'Patient')
- [ ] Valida `package.model` se aplicável
- [ ] Usa helpers `buildDateTime/buildDayRange`
- [ ] Retorna erro padronizado
- [ ] Inclui `meta.version: "v2"`

### Novo Model Mongoose
- [ ] Campo `patientId: ObjectId` com ref
- [ ] Campo `model` se for Package-like
- [ ] Timestamps: `createdAt`, `updatedAt`
- [ ] Índice em `patientId`

---

## ⚠️ LEGADO (V1)

### Status
- 🚫 **CONGELADO** - Não recebe novas features
- ⚠️ **MANTIDO** - Apenas para dados antigos
- ⏰ **DEPRECAÇÃO** - Será removido em futuro próximo

### Regra de Ouro
> **Se você está editando V1, está fazendo errado.**

---

## 🏁 CONCLUSÃO

Este documento é a **lei** do V2. Qualquer desvio deve ser:
1. Documentado
2. Revisado
3. Aprovado

**Versão atual:** 2.0.0  
**Última atualização:** 2026-04-12  
**Responsável:** Equipe CRM
