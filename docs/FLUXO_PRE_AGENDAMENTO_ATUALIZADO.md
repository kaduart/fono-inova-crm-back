# 📋 Fluxo de Pré-Agendamento → Agendamento Confirmado

## 🎯 Problema Resolvido

**Antes**: Sistema tentava criar **appointment duplicado** quando agenda externa enviava o mesmo registro múltiplas vezes, resultando em **erro 409 "Horário não está mais disponível"**.

**Agora**: PreAgendamento cria **um único Appointment** com status `pre-scheduled`, e confirmações posteriores apenas **atualizam** o status para `scheduled`.

---

## 🏗️ Nova Arquitetura

### Estados do Appointment

```
┌──────────────────┐
│  PRE-SCHEDULED   │  ← Importado da agenda externa mas NÃO confirmado
└──────────────────┘
        │
        │ POST /confirmar-agendamento
        ▼
┌──────────────────┐
│    SCHEDULED     │  ← Confirmado e pronto para acontecer
└──────────────────┘
```

### Estados do PreAgendamento

```
┌──────────┐
│   NOVO   │  ← Criado pela agenda externa
└──────────┘
     │
     │ POST /confirmar-por-external-id
     │ (cria Appointment com status pre-scheduled)
     ▼
┌──────────┐
│IMPORTADO │  ← Tem appointmentId mas ainda pre-scheduled
└──────────┘
```

---

## 📊 Fluxos Completos

### Fluxo 1: Criar → Importar → Confirmar (3 Passos)

```
1️⃣ POST /import-from-agenda
   Body: { externalId, patientInfo, date, time, ... }
   ↓
   Cria PreAgendamento com status='novo'
   Retorna: { preAgendamentoId }

2️⃣ POST /import-from-agenda/confirmar-por-external-id
   Body: { externalId }
   ↓
   Cria Appointment com operationalStatus='pre-scheduled'
   PreAgendamento.status = 'importado'
   PreAgendamento.importedToAppointment = appointmentId
   Retorna: { appointmentId, status: 'pre-scheduled' }

3️⃣ POST /import-from-agenda/confirmar-agendamento
   Body: { externalId }
   ↓
   Atualiza Appointment.operationalStatus = 'scheduled'
   Retorna: { appointmentId, status: 'confirmed' }
```

---

### Fluxo 2: Criar e Importar Imediatamente (2 Passos)

```
1️⃣ POST /import-from-agenda/criar-e-confirmar
   Body: { externalId, patientInfo, date, time, ... }
   ↓
   Cria PreAgendamento com status='importado'
   Cria Appointment com operationalStatus='pre-scheduled'
   PreAgendamento.importedToAppointment = appointmentId
   Retorna: { preAgendamentoId, appointmentId, status: 'pre-scheduled' }

2️⃣ POST /import-from-agenda/confirmar-agendamento
   Body: { externalId }
   ↓
   Atualiza Appointment.operationalStatus = 'scheduled'
   Retorna: { appointmentId, status: 'confirmed' }
```

---

### Fluxo 3: Retry/Duplicata Detectada ✅

```
1️⃣ POST /import-from-agenda/criar-e-confirmar
   Body: { externalId: "ABC123", ... }
   ↓
   Cria Appointment com pre-scheduled

2️⃣ POST /import-from-agenda/criar-e-confirmar (DE NOVO!)
   Body: { externalId: "ABC123", ... }
   ↓
   ✅ Detecta que já existe PreAgendamento com externalId="ABC123"
   ✅ Verifica que já tem appointment (status pre-scheduled)
   ✅ NÃO cria duplicata
   ✅ Retorna: { success: true, appointmentId: <existente> }

3️⃣ POST /import-from-agenda/confirmar-agendamento
   Body: { externalId: "ABC123" }
   ↓
   Atualiza existente para 'scheduled'
   Retorna: { success: true, status: 'confirmed' }
```

---

## 🔧 Endpoints

### 1. `POST /api/import-from-agenda`

**Função**: Cria apenas o PreAgendamento (não cria Appointment)

**Body**:
```json
{
  "externalId": "ABC123",
  "professionalName": "Dra. Maria",
  "date": "2026-02-20",
  "time": "14:00",
  "specialty": "fonoaudiologia",
  "patientInfo": {
    "fullName": "João Silva",
    "phone": "62999999999",
    "birthDate": "01/01/2010"
  }
}
```

**Response**:
```json
{
  "success": true,
  "preAgendamentoId": "...",
  "status": "novo",
  "nextStep": "Aguardando confirmação..."
}
```

---

### 2. `POST /api/import-from-agenda/confirmar-por-external-id`

**Função**: Cria Appointment com `pre-scheduled` (não confirmado)

**Body**:
```json
{
  "externalId": "ABC123"
}
```

**Response**:
```json
{
  "success": true,
  "appointmentId": "...",
  "preAgendamentoId": "...",
  "status": "pre-scheduled"
}
```

**Se já foi importado**:
```json
{
  "success": true,
  "message": "Já foi importado anteriormente",
  "appointmentId": "...",
  "warning": "..."
}
```

---

### 3. `POST /api/import-from-agenda/criar-e-confirmar`

**Função**: Cria PreAgendamento + Appointment de uma vez (ainda `pre-scheduled`)

**Body**:
```json
{
  "externalId": "ABC123",
  "professionalName": "Dra. Maria",
  "date": "2026-02-20",
  "time": "14:00",
  "patientInfo": { ... },
  "crm": {
    "serviceType": "evaluation",
    "paymentAmount": 200
  }
}
```

**Response**:
```json
{
  "success": true,
  "preAgendamentoId": "...",
  "appointmentId": "...",
  "status": "pre-scheduled"
}
```

**Se já existe PreAgendamento com mesmo externalId**:

- **Se já foi importado E está `pre-scheduled`**: Confirma automaticamente → retorna `status: 'confirmed'`
- **Se já foi importado E está `scheduled`**: Retorna `status: 'already_confirmed'`
- **Se ainda não foi importado**: Importa normalmente

---

### 4. `POST /api/import-from-agenda/confirmar-agendamento` 🆕

**Função**: Confirma um pré-agendamento (`pre-scheduled` → `scheduled`)

**Body**:
```json
{
  "externalId": "ABC123"
}
```

**OU**:
```json
{
  "preAgendamentoId": "675abc..."
}
```

**Response**:
```json
{
  "success": true,
  "message": "Pré-agendamento confirmado com sucesso!",
  "appointmentId": "...",
  "preAgendamentoId": "...",
  "status": "confirmed"
}
```

**Se já estava confirmado**:
```json
{
  "success": true,
  "message": "Agendamento já estava confirmado",
  "status": "already_confirmed"
}
```

**Erros Possíveis**:
- `400`: Pré-agendamento ainda não foi importado
- `404`: PreAgendamento ou Appointment não encontrado

---

## 🔒 Status `pre-scheduled` no conflictDetection

O status `pre-scheduled` **BLOQUEIA** o horário (não está em `NON_BLOCKING_OPERATIONAL_STATUSES`):

```javascript
// constants/appointmentStatus.js
export const NON_BLOCKING_OPERATIONAL_STATUSES = [
  'canceled',
  'cancelado',
  'cancelada',
  // 'pre-scheduled' NÃO está aqui - DEVE bloquear horário
];
```

**Isso significa**:
- ✅ Appointment com `pre-scheduled` **BLOQUEIA** o horário
- ❌ Outro appointment **NÃO pode** ser criado no mesmo horário/doctor
- ✅ Evita conflitos: secretária agenda horário X, Amanda não oferece horário X para outro paciente
- ✅ Quando confirmar para `scheduled`, continua bloqueando (é só uma confirmação)

**Exemplo de conflito evitado**:
```
❌ ANTES (se não bloqueasse):
- Secretária agenda João para 14h com Dra. Maria (pre-scheduled)
- Amanda oferece 14h com Dra. Maria para Maria (disponível!)
- Ambos confirmam → CONFLITO 409

✅ AGORA (bloqueando):
- Secretária agenda João para 14h com Dra. Maria (pre-scheduled)
- Amanda busca slots → 14h NÃO aparece (já bloqueado)
- Maria recebe outro horário → SEM conflito
```

---

## 🎨 Visualização no Front-end

### Sugestão de cores/badges:

```
┌─────────────────────────────────────┐
│ 📅 Agendamento - 20/02 14:00        │
│                                     │
│ 🟡 PRÉ-AGENDADO                     │  ← Badge amarelo
│ (Importado mas não confirmado)      │
│                                     │
│ [Confirmar Agendamento]             │  ← Botão
└─────────────────────────────────────┘

       ↓ Após confirmar

┌─────────────────────────────────────┐
│ 📅 Agendamento - 20/02 14:00        │
│                                     │
│ 🟢 CONFIRMADO                        │  ← Badge verde
│                                     │
└─────────────────────────────────────┘
```

---

## 🧪 Testando o Fluxo

### Teste 1: Criar e Confirmar

```bash
# 1. Criar + Importar
curl -X POST http://localhost:5000/api/import-from-agenda/criar-e-confirmar \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "TEST123",
    "professionalName": "Dra. Maria",
    "date": "2026-02-25",
    "time": "14:00",
    "patientInfo": {
      "fullName": "João Teste",
      "phone": "62999999999",
      "birthDate": "01/01/2010"
    },
    "crm": { "paymentAmount": 200 }
  }'

# Response: { appointmentId: "...", status: "pre-scheduled" }

# 2. Confirmar
curl -X POST http://localhost:5000/api/import-from-agenda/confirmar-agendamento \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "externalId": "TEST123" }'

# Response: { status: "confirmed" }
```

### Teste 2: Retry/Duplicata

```bash
# 1. Criar
curl -X POST ... (mesmo do teste 1)
# Response: { appointmentId: "ABC", status: "pre-scheduled" }

# 2. Criar DE NOVO (retry)
curl -X POST ... (exatamente igual)
# Response: { appointmentId: "ABC", status: "confirmed" } ✅ CONFIRMA automaticamente

# 3. Criar TERCEIRA VEZ
curl -X POST ... (exatamente igual)
# Response: { status: "already_confirmed" } ✅ Já confirmado
```

---

## 📝 Mudanças no Código

### Arquivos Modificados:

1. **`/constants/appointmentStatus.js`**
   - Adicionado `'pre-scheduled'` ao array `NON_BLOCKING_OPERATIONAL_STATUSES`

2. **`/routes/importFromAgenda.js`**
   - `/confirmar-por-external-id`: Cria com `status: 'pre-scheduled'`
   - `/criar-e-confirmar`: Verifica duplicatas e confirma se já existe
   - `/confirmar-agendamento`: **Novo endpoint** para confirmar

### Backward Compatibility:

✅ **100% compatível** com código antigo:
- PreAgendamento continua funcionando igual
- Endpoints antigos continuam funcionando
- Apenas adicionamos novo status e novo endpoint

---

## 🎯 Benefícios

### Antes:
- ❌ Retry causava erro 409
- ❌ Appointments duplicados
- ❌ Risco de conflitos entre secretária e Amanda

### Agora:
- ✅ Retry não causa erro (detecta duplicata)
- ✅ Um PreAgendamento = Um Appointment (nunca duplica)
- ✅ Horário bloqueado desde `pre-scheduled` (evita conflitos)
- ✅ Rastreabilidade completa (history no appointment)
- ✅ Socket events para sync em tempo real
- ✅ Secretária e Amanda nunca oferecem mesmo horário

---

## 🔮 Próximos Passos (Opcional)

1. **Dashboard** para visualizar pré-agendados vs confirmados
2. **Auto-confirmação** após X tempo (ex: 24h)
3. **Notificações** quando pré-agendamento está pendente de confirmação
4. **Relatórios** de taxa de confirmação

---

**Autor**: Claude (Anthropic)
**Data**: 2026-02-16
**Versão**: 2.0
