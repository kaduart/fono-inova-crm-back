# 📋 API Contract V2 - Fono Inova CRM

**Versão:** 2.0.0  
**Status:** Production Ready  
**Last Updated:** 2026-04-12

---

## 🎯 Visão Geral

Todas as APIs V2 seguem o padrão DTO (Data Transfer Object) unificado:

```typescript
// Response padronizado
{
  success: boolean,
  data?: T,           // Presente quando success=true
  error?: {           // Presente quando success=false
    code: string,
    message: string,
    details?: any
  },
  meta: {
    version: "v2",
    correlationId: string,
    timestamp: string
  }
}
```

---

## 🔐 Autenticação

### Login
```http
POST /api/login
Content-Type: application/json

{
  "email": "string",
  "password": "string",
  "role": "admin" | "doctor" | "secretary" | "patient"
}
```

**Response 200:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "string",
    "name": "string",
    "email": "string",
    "role": "string",
    "specialty?": "string" // apenas para doctor
  }
}
```

**Headers para autenticação:**
```http
Authorization: Bearer <token>
```

---

## 📅 Appointments V2

Base URL: `/api/v2/appointments`

### Create Appointment
```http
POST /api/v2/appointments
Authorization: Bearer <token>
Content-Type: application/json

{
  "patientId": "string (required)",
  "doctorId": "string (required)",
  "date": "YYYY-MM-DD (required)",
  "time": "HH:MM (required)",
  "type": "particular" | "convenio" | "liminar",
  "reason?": "string",
  "notes?": "string",
  "packageId?": "string"
}
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "appointmentId": "string",
    "status": "scheduled",
    "operationalStatus": "scheduled",
    "clinicalStatus": "pending",
    "patientId": "string",
    "doctorId": "string",
    "date": "YYYY-MM-DD",
    "time": "HH:MM",
    "correlationId": "string"
  },
  "meta": {
    "version": "v2",
    "message": "Agendamento criado com sucesso",
    "processing": "async",
    "timestamp": "2026-04-12T..."
  }
}
```

**Response 409 (Conflito):**
```json
{
  "success": false,
  "error": {
    "code": "DUPLICATE_APPOINTMENT",
    "message": "O médico já possui um compromisso neste horário",
    "details": {
      "conflict": {
        "appointmentId": "string",
        "patientName": "string"
      }
    }
  },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

---

### Complete Appointment
```http
PATCH /api/v2/appointments/:id/complete
Authorization: Bearer <token>
Content-Type: application/json

{
  "notes?": "string",
  "evolution?": "string"
}
```

**Response 200:**
```json
{
  "success": true,
  "idempotent": false,
  "message": "Sessão completada com sucesso",
  "data": {
    "appointmentId": "string",
    "sessionId": "string",
    "packageId": "string",
    "clinicalStatus": "completed",
    "operationalStatus": "completed",
    "paymentStatus": "unpaid" | "pending_receipt" | "paid",
    "balanceAmount": 150.00,
    "sessionValue": 150.00,
    "isPaid": false,
    "completedAt": "2026-04-12T..."
  },
  "meta": {
    "version": "v2",
    "correlationId": "string",
    "timestamp": "2026-04-12T..."
  }
}
```

**Response 409 (Já completado - Idempotente):**
```json
{
  "success": true,
  "idempotent": true,
  "message": "Sessão já estava completada",
  "data": { /* mesmo formato */ },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

---

### Cancel Appointment
```http
PATCH /api/v2/appointments/:id/cancel
Authorization: Bearer <token>
Content-Type: application/json

{
  "reason": "string (required)"
}
```

**Response 202 (Async):**
```json
{
  "success": true,
  "data": {
    "appointmentId": "string",
    "status": "processing_cancel",
    "message": "Cancelamento em processamento",
    "checkStatusUrl": "/api/v2/appointments/:id/status",
    "estimatedTime": "1-3s"
  },
  "meta": {
    "version": "v2",
    "correlationId": "string",
    "timestamp": "..."
  }
}
```

**Response 409 (Não pode cancelar):**
```json
{
  "success": false,
  "error": {
    "code": "CONFLICT_STATE",
    "message": "Não é possível cancelar uma sessão já completada"
  },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

---

### Get Appointment Status (Polling)
```http
GET /api/v2/appointments/:id/status
Authorization: Bearer <token>
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "appointmentId": "string",
    "operationalStatus": "scheduled" | "completed" | "canceled" | "processing",
    "clinicalStatus": "pending" | "in_progress" | "completed",
    "isProcessing": false,
    "isResolved": true,
    "isCompleted": true,
    "isCanceled": false,
    "statusMessage": "Processamento concluído"
  },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

---

## 📦 Packages V2

Base URL: `/api/v2/packages`

### Create Package - Per Session (Particular)
```http
POST /api/v2/packages
Authorization: Bearer <token>
Content-Type: application/json

{
  "patientId": "string (required)",
  "doctorId": "string (required)",
  "specialty": "string (required)",
  "name": "string (required)",
  "type": "package",
  "model": "per_session" | "prepaid",
  "billingType": "particular",
  "totalSessions": 10,
  "sessionValue": 150.00,
  "modality": "presencial" | "online"
}
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "packageId": "string",
    "patientId": "string",
    "status": "active",
    "type": "package",
    "model": "per_session",
    "billingType": "particular",
    "totalSessions": 10,
    "sessionsDone": 0,
    "sessionsRemaining": 10,
    "balance": 0,
    "sessionValue": 150.00
  },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

---

### Create Package - Liminar
```http
POST /api/v2/packages
Authorization: Bearer <token>
Content-Type: application/json

{
  "patientId": "string (required)",
  "doctorId": "string (required)",
  "specialty": "string (required)",
  "name": "string (required)",
  "type": "liminar",
  "billingType": "liminar",
  "liminarProcessNumber": "string (required)",
  "totalSessions": 20,
  "modality": "presencial"
}
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "packageId": "string",
    "status": "active",
    "type": "liminar",
    "billingType": "liminar",
    "liminarProcessNumber": "string",
    "totalSessions": 20,
    "sessionsDone": 0,
    "credit": 0,  // Crédito disponível
    "sessionValue": 0  // Gratuito para paciente
  },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

**Response 400 (Faltando dados):**
```json
{
  "success": false,
  "error": {
    "code": "LIMINAR_DATA_REQUIRED",
    "message": "liminarProcessNumber obrigatório para liminar"
  },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

---

### Create Package - Convênio
```http
POST /api/v2/packages
Authorization: Bearer <token>
Content-Type: application/json

{
  "patientId": "string (required)",
  "doctorId": "string (required)",
  "specialty": "string (required)",
  "name": "string (required)",
  "type": "convenio",
  "billingType": "convenio",
  "insuranceGuideId": "string (required)",
  "totalSessions": 12,
  "sessionValue": 80.00,
  "modality": "presencial"
}
```

**Response 400 (Faltando guia):**
```json
{
  "success": false,
  "error": {
    "code": "INSURANCE_GUIDE_REQUIRED",
    "message": "insuranceGuideId obrigatório para convênio"
  },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

---

### Get Package Details
```http
GET /api/v2/packages/:id
Authorization: Bearer <token>
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "patientId": "string",
    "status": "active" | "finished" | "canceled",
    "type": "package" | "liminar" | "convenio",
    "billingType": "particular" | "liminar" | "convenio",
    "totalSessions": 10,
    "sessionsDone": 3,
    "sessionsRemaining": 7,
    "balance": 450.00,  // Dívida do paciente (particular)
    "credit": 0,        // Crédito disponível (liminar)
    "sessionValue": 150.00,
    "sessions": [
      {
        "sessionId": "string",
        "date": "YYYY-MM-DD",
        "status": "completed" | "pending",
        "paymentStatus": "unpaid" | "paid"
      }
    ]
  },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

---

## 💰 Financial V2

Base URL: `/api/v2/balance`

### Create Debit (Débito)
```http
POST /api/v2/balance/:patientId/debit
Authorization: Bearer <token>
Content-Type: application/json

{
  "amount": 300.00,
  "description": "string",
  "referenceType": "appointment" | "package",
  "referenceId": "string"
}
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "transactionId": "string",
    "patientId": "string",
    "type": "debit",
    "amount": 300.00,
    "balance": 300.00,
    "description": "string"
  },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

---

### Get Balance
```http
GET /api/v2/balance/:patientId
Authorization: Bearer <token>
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "patientId": "string",
    "balance": 300.00,      // Saldo devedor atual
    "totalDebit": 450.00,   // Total debitado
    "totalCredit": 150.00,  // Total pago
    "transactions": [
      {
        "transactionId": "string",
        "type": "debit" | "credit",
        "amount": 150.00,
        "date": "2026-04-12T...",
        "description": "string"
      }
    ]
  },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

---

## 🏥 Patients V2

Base URL: `/api/v2/patients`

### Create Patient (Async)
```http
POST /api/v2/patients
Authorization: Bearer <token>
Content-Type: application/json

{
  "fullName": "string (required)",
  "dateOfBirth": "YYYY-MM-DD (required)",
  "email?": "string",
  "phone?": "string",
  "cpf?": "string",
  "gender?": "M" | "F",
  "address?": "object"
}
```

**Response 202 (Async):**
```json
{
  "success": true,
  "data": {
    "patientId": "string",
    "eventId": "string",
    "status": "pending",
    "checkStatusUrl": "/api/v2/patients/status/:eventId",
    "estimatedTime": "1-2s"
  },
  "meta": { "version": "v2", "timestamp": "..." }
}
```

---

## ⚠️ Códigos de Erro Comuns

| Código | HTTP | Descrição | Quando Ocorre |
|--------|------|-----------|---------------|
| `UNAUTHORIZED` | 401 | Token inválido ou expirado | Autenticação falhou |
| `FORBIDDEN` | 403 | Sem permissão | Role não autorizado |
| `NOT_FOUND` | 404 | Recurso não encontrado | ID inválido |
| `DUPLICATE_APPOINTMENT` | 409 | Conflito de horário | Mesmo doctor/time/date |
| `CONFLICT_STATE` | 409 | Estado inválido | Cancelar completed |
| `MISSING_REQUIRED_FIELDS` | 400 | Campos obrigatórios faltando | Validação de payload |
| `LIMINAR_DATA_REQUIRED` | 400 | Dados de liminar incompletos | Criar package liminar |
| `INSURANCE_GUIDE_REQUIRED` | 400 | Guia de convênio obrigatória | Criar package convênio |
| `MODEL_REQUIRED` | 400 | Modelo de package obrigatório | Criar package per_session |
| `IDEMPOTENT_RETRY` | 200 | Operação já realizada | Retry de complete |

---

## 🔄 Fluxos Assíncronos (Polling)

### Pattern de Polling
```typescript
async function pollStatus(
  appointmentId: string,
  maxAttempts = 10,
  interval = 1000
): Promise<StatusResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(interval);
    
    const response = await fetch(`/api/v2/appointments/${appointmentId}/status`);
    const dto = await response.json();
    
    if (!dto.success) throw new Error(dto.error?.message);
    
    const status = dto.data;
    
    // Sucesso
    if (status.isResolved || status.isCompleted) {
      return { success: true, status: status.operationalStatus };
    }
    
    // Erro
    if (status.operationalStatus === 'failed' || status.operationalStatus === 'error') {
      return { success: false, error: status.statusMessage };
    }
    
    // Continue polling...
  }
  
  return { success: false, error: 'Timeout' };
}
```

---

## 📊 Rate Limits

| Endpoint | Limite | Janela |
|----------|--------|--------|
| Login | 5 requests | 1 minuto |
| Create Appointment | 10 requests | 1 minuto |
| Complete/Cancel | 20 requests | 1 minuto |
| List/Get | 100 requests | 1 minuto |

**Headers de resposta:**
```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1712930400
```

---

## 🧪 Exemplo Completo: Fluxo de Agendamento

```typescript
// 1. Login
const login = await fetch('/api/login', {
  method: 'POST',
  body: JSON.stringify({ email, password, role })
});
const { token } = await login.json();

// 2. Criar paciente (async)
const patientRes = await fetch('/api/v2/patients', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: JSON.stringify({ fullName, dateOfBirth })
});
const patientDto = await patientRes.json();
const patientId = patientDto.data.patientId;

// 3. Criar agendamento
const apptRes = await fetch('/api/v2/appointments', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: JSON.stringify({ patientId, doctorId, date, time, type })
});
const apptDto = await apptRes.json();
const appointmentId = apptDto.data.appointmentId;

// 4. Completar agendamento
const completeRes = await fetch(`/api/v2/appointments/${appointmentId}/complete`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}` },
  body: JSON.stringify({ notes: 'Sessão realizada' })
});
const completeDto = await completeRes.json();

// 5. Validar DTO V2
if (completeDto.success && completeDto.meta.version === 'v2') {
  console.log('Status:', completeDto.data.operationalStatus); // completed
  console.log('Balance:', completeDto.data.balanceAmount);     // valor da sessão
}
```

---

## 📞 Suporte

**Equipe Backend:** backend@fonoinova.com  
**Documentação:** https://docs.fonoinova.com/api/v2  
**Status Page:** https://status.fonoinova.com

---

**© 2026 Fono Inova - Todos os direitos reservados**