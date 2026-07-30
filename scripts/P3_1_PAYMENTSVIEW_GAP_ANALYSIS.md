# P3.1 — Gap Analysis: PaymentsView vs GET /api/v2/payments

> Data: 2026-07-30  
> Objetivo: validar se `PaymentsView` contém todos os campos usados pelo endpoint antes de ligar a projeção.

---

## 1. Campos usados pelo endpoint `GET /api/v2/payments`

Arquivo: `back/routes/payments.v2.js:127-155`

```js
const formatted = payments.map(p => ({
    _id: p.paymentId,                 // → PaymentsView.paymentId
    viewId: p._id,                    // → PaymentsView._id
    date: p.paymentDate,              // → PaymentsView.paymentDate
    patient: {
        _id: p.patient?.id,           // → PaymentsView.patient.id
        fullName: p.patient?.name,    // → PaymentsView.patient.name
        phone: p.patient?.phone       // → PaymentsView.patient.phone
    },
    doctor: {
        _id: p.doctor?.id,            // → PaymentsView.doctor.id
        fullName: p.doctor?.name,     // → PaymentsView.doctor.name
        specialty: p.doctor?.specialty // → PaymentsView.doctor.specialty
    },
    serviceType: p.service?.type,      // ⚠️ NÃO EXISTE na PaymentsView
    serviceLabel: p.service?.label,  // ⚠️ NÃO EXISTE na PaymentsView
    specialty: p.specialty,           // → PaymentsView.specialty
    amount: p.amount,                  // → PaymentsView.amount
    receivedAmount: p.receivedAmount || 0, // → PaymentsView.receivedAmount
    remaining: p.amount - (p.receivedAmount || 0),
    paymentMethod: p.method,          // → PaymentsView.method
    paymentMethodLabel: p.methodLabel, // → PaymentsView.methodLabel
    status: p.status,                  // → PaymentsView.status
    category: p.category,            // → PaymentsView.category
    notes: p.notes,                    // → PaymentsView.notes
    createdAt: p.createdAt,            // → PaymentsView.createdAt
    appointment: p.appointmentId ? { _id: p.appointmentId } : null, // → PaymentsView.appointmentId
    package: p.packageId ? { _id: p.packageId } : null             // → PaymentsView.packageId
}));
```

---

## 2. Campos disponíveis na PaymentsView

Arquivo: `back/models/PaymentsView.js`

| Campo na view | Tipo | Usado pelo endpoint? |
|---|---|---|
| `paymentId` | ObjectId | ✅ `_id` |
| `_id` | ObjectId | ✅ `viewId` |
| `patient.id` | ObjectId | ✅ `patient._id` |
| `patient.name` | String | ✅ `patient.fullName` |
| `patient.phone` | String | ✅ `patient.phone` |
| `doctor.id` | ObjectId | ✅ `doctor._id` |
| `doctor.name` | String | ✅ `doctor.fullName` |
| `doctor.specialty` | String | ✅ `doctor.specialty` |
| `serviceType` | String | ⚠️ Não usado (endpoint lê `service.type`) |
| `serviceLabel` | String | ⚠️ Não usado (endpoint lê `service.label`) |
| `specialty` | String | ✅ `specialty` |
| `amount` | Number | ✅ `amount` |
| `receivedAmount` | Number | ✅ `receivedAmount` |
| `method` | String | ✅ `paymentMethod` |
| `methodLabel` | String | ✅ `paymentMethodLabel` |
| `status` | String | ✅ `status` |
| `type` | String | ❌ Não usado |
| `category` | String | ✅ `category` |
| `paymentDate` | String | ✅ `date` |
| `paymentMonth` | String | ❌ Usado só no filtro |
| `createdAt` | Date | ✅ `createdAt` |
| `updatedAt` | Date | ❌ Não usado |
| `appointmentId` | ObjectId | ✅ `appointment._id` |
| `packageId` | ObjectId | ✅ `package._id` |
| `sessionId` | ObjectId | ❌ Não usado |
| `notes` | String | ✅ `notes` |
| `clinicId` | String | ❌ Usado só no filtro |
| `isDeleted` | Boolean | ❌ Usado só no filtro |

---

## 3. 🐛 Bug encontrado

O endpoint tenta ler:

```js
serviceType: p.service?.type,
serviceLabel: p.service?.label,
```

Mas `PaymentsView` **não tem** o campo `service`. Ela tem:

```js
serviceType: String,
serviceLabel: String,
```

**Resultado:** ao ler da `PaymentsView`, `serviceType` e `serviceLabel` sempre vão retornar `undefined`.

### Correção necessária no endpoint

Trocar:
```js
serviceType: p.service?.type,
serviceLabel: p.service?.label,
```

Por:
```js
serviceType: p.serviceType,
serviceLabel: p.serviceLabel,
```

---

## 4. Outras observações

### 4.1 `receivedAmount` pode vir inconsistente

A projeção armazena `receivedAmount` diretamente do `Payment`.  
O endpoint calcula `remaining = amount - receivedAmount`.  
Isso é consistente com a semântica V2 de "produced vs received".

### 4.2 `status === 'completed' ? 'paid'`

Na projeção:
```js
status: status === 'completed' ? 'paid' : status || 'pending',
```

Isso é defensivo para dados antigos. Hoje o schema Payment não deveria ter `completed`, então está OK.

### 4.3 `category` pode estar incompleta

A lógica da projeção:
```js
if (paymentMethod inclui 'convenio'/'plano') → insurance
else if (serviceType === 'package_session' || pkg) → package
else → particular
```

Isso pode falhar para:
- Pagamentos de convênio onde `paymentMethod` não contém "convenio" (ex: `convenio_receivable`).
- Pagamentos de liminar.
- Pagamentos de avaliação.

**Recomendação:** usar `billingType` do Payment para determinar `category`.

### 4.4 Filtro por `category` e `method`

O endpoint aceita:
- `category`: particular | package | insurance | expense
- `method`: pix | cash | card | insurance

A projeção tem índices para ambos, mas o mapeamento de `method` precisa ser revisado para garantir que todos os métodos de payment caiam nas categorias corretas.

---

## 5. Veredito

| Aspecto | Status |
|---|---|
| Projeção completa para leitura | ⚠️ Quase — precisa corrigir bug do endpoint |
| Campos obrigatórios presentes | ✅ Sim |
| Campos faltantes na view | ❌ `service` aninhado (endpoint usa errado) |
| Correção fácil | ✅ Sim — 2 linhas no endpoint |
| Risco de ligar projeção agora | 🟡 Médio — corrigir endpoint primeiro |

---

## 6. Próximo passo

Antes de rodar o rebuild em produção, corrigir o endpoint `GET /api/v2/payments`:

```js
serviceType: p.serviceType,
serviceLabel: p.serviceLabel,
```

Depois rodar o rebuild e validar que os 2.158 pagamentos geram 2.158 views.
