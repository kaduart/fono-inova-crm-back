# 📋 Schema de Eventos - CRM Event-Driven 4.0

> **Versão:** 1.0  
> **Data:** 29/03/2026  
> **Status:** Draft

---

## 🎯 Convenção de Nomenclatura

### Padrão: `{ENTITY}_{ACTION}_{TIMING}`

| Timing | Significado | Exemplo |
|--------|-------------|---------|
| `REQUESTED` | Intenção/Solicitação | `APPOINTMENT_CREATE_REQUESTED` |
| `CREATED` | Concluído com sucesso | `APPOINTMENT_CREATED` |
| `UPDATED` | Alteração concluída | `APPOINTMENT_UPDATED` |
| `COMPLETED` | Ação finalizada | `APPOINTMENT_COMPLETED` |
| `CANCELED` | Cancelamento | `APPOINTMENT_CANCELED` |
| `FAILED` | Erro/Falha | `PAYMENT_FAILED` |
| `SENT` | Envio confirmado | `NOTIFICATION_SENT` |

---

## 📦 Estrutura Base do Evento

```json
{
  "eventId": "uuid_v7_ou_similar",
  "eventType": "ENTITY_ACTION_TIMING",
  "version": 1,
  "timestamp": "2026-03-29T20:00:00.000Z",
  "correlationId": "uuid_trace",
  "idempotencyKey": "hash_unico",
  "payload": {
    // Dados específicos do evento
  },
  "metadata": {
    "source": "nome_do_servico",
    "userId": "id_do_usuario",
    "ip": "ip_origem",
    "userAgent": "browser_info"
  }
}
```

---

## 🏥 Appointment Events

### APPOINTMENT_CREATE_REQUESTED
**Quando:** Usuário solicita criação de agendamento

```json
{
  "eventType": "APPOINTMENT_CREATE_REQUESTED",
  "payload": {
    "patientId": "string",
    "doctorId": "string",
    "date": "2026-03-30T10:00:00Z",
    "specialty": "fonoaudiologia",
    "billingType": "particular|convenio|liminar",
    "packageId": "string|null",
    "insuranceGuideId": "string|null",
    "notes": "string"
  }
}
```

### APPOINTMENT_CREATED
**Quando:** Agendamento criado com sucesso

```json
{
  "eventType": "APPOINTMENT_CREATED",
  "payload": {
    "appointmentId": "string",
    "patientId": "string",
    "doctorId": "string",
    "status": "scheduled",
    "createdAt": "2026-03-29T20:00:00Z"
  }
}
```

### APPOINTMENT_UPDATE_REQUESTED ⭐ NOVO
**Quando:** Solicita alteração em agendamento existente

```json
{
  "eventType": "APPOINTMENT_UPDATE_REQUESTED",
  "payload": {
    "entityType": "appointment",
    "entityId": "string",
    "changes": {
      "date": "2026-03-31T10:00:00Z",
      "doctor": "novo_doutor_id",
      "notes": "nova observação"
    },
    "reason": "Paciente solicitou remarcação",
    "userId": "id_do_secretario"
  }
}
```

### APPOINTMENT_UPDATED ⭐ NOVO
**Quando:** Alteração aplicada com sucesso

```json
{
  "eventType": "APPOINTMENT_UPDATED",
  "payload": {
    "entityType": "appointment",
    "entityId": "string",
    "changes": {
      "date": "2026-03-31T10:00:00Z"
    },
    "previousValues": {
      "date": "2026-03-30T10:00:00Z"
    },
    "updatedBy": "id_do_secretario",
    "updatedAt": "2026-03-29T20:00:00Z"
  }
}
```

### APPOINTMENT_COMPLETE_REQUESTED
**Quando:** Solicitação de completar sessão

```json
{
  "eventType": "APPOINTMENT_COMPLETE_REQUESTED",
  "payload": {
    "appointmentId": "string",
    "addToBalance": false,
    "balanceAmount": 0
  }
}
```

### APPOINTMENT_COMPLETED
**Quando:** Sessão completada com sucesso

```json
{
  "eventType": "APPOINTMENT_COMPLETED",
  "payload": {
    "appointmentId": "string",
    "clinicalStatus": "completed",
    "paymentOrigin": "auto_per_session",
    "perSessionPaymentId": "string"
  }
}
```

### APPOINTMENT_CANCEL_REQUESTED
**Quando:** Solicitação de cancelamento

```json
{
  "eventType": "APPOINTMENT_CANCEL_REQUESTED",
  "payload": {
    "appointmentId": "string",
    "reason": "Paciente desistiu",
    "forceCancel": false
  }
}
```

### APPOINTMENT_CANCELED
**Quando:** Cancelamento concluído

```json
{
  "eventType": "APPOINTMENT_CANCELED",
  "payload": {
    "appointmentId": "string",
    "operationalStatus": "canceled",
    "sessionPreserved": true,
    "restoredPackage": true
  }
}
```

---

## 👤 Lead Events

### LEAD_CREATED
**Quando:** Novo lead criado

```json
{
  "eventType": "LEAD_CREATED",
  "payload": {
    "leadId": "string",
    "name": "João Silva",
    "phone": "5561999999999",
    "origin": "Meta Ads",
    "conversionScore": 65
  }
}
```

### LEAD_UPDATE_REQUESTED ⭐ NOVO
**Quando:** Solicita alteração em lead

```json
{
  "eventType": "LEAD_UPDATE_REQUESTED",
  "payload": {
    "entityType": "lead",
    "entityId": "string",
    "changes": {
      "status": "qualified",
      "conversionScore": 80,
      "notes": "Interessado em avaliação"
    },
    "reason": "Qualificação atualizada após conversa"
  }
}
```

### LEAD_UPDATED ⭐ NOVO
**Quando:** Lead alterado com sucesso

```json
{
  "eventType": "LEAD_UPDATED",
  "payload": {
    "entityType": "lead",
    "entityId": "string",
    "changes": {
      "status": "qualified"
    },
    "previousValues": {
      "status": "new"
    }
  }
}
```

### LEAD_CONVERTED
**Quando:** Lead vira paciente

```json
{
  "eventType": "LEAD_CONVERTED",
  "payload": {
    "leadId": "string",
    "patientId": "string",
    "convertedAt": "2026-03-29T20:00:00Z"
  }
}
```

---

## 📞 Followup Events

### FOLLOWUP_REQUESTED
**Quando:** Solicitação de envio de followup

```json
{
  "eventType": "FOLLOWUP_REQUESTED",
  "payload": {
    "followupId": "string",
    "leadId": "string",
    "scheduledAt": "2026-03-30T14:00:00Z",
    "stage": "primeiro_contato",
    "attempt": 1
  }
}
```

### FOLLOWUP_SENT
**Quando:** Followup enviado

```json
{
  "eventType": "FOLLOWUP_SENT",
  "payload": {
    "followupId": "string",
    "leadId": "string",
    "messageLength": 150,
    "sentAt": "2026-03-29T20:00:00Z"
  }
}
```

### FOLLOWUP_FAILED
**Quando:** Falha no envio

```json
{
  "eventType": "FOLLOWUP_FAILED",
  "payload": {
    "followupId": "string",
    "leadId": "string",
    "error": "Lead sem telefone válido"
  }
}
```

---

## 💰 Payment Events

### PAYMENT_PROCESS_REQUESTED
**Quando:** Solicita processamento de pagamento

```json
{
  "eventType": "PAYMENT_PROCESS_REQUESTED",
  "payload": {
    "appointmentId": "string",
    "amount": 200,
    "method": "pix"
  }
}
```

### PAYMENT_COMPLETED
**Quando:** Pagamento confirmado

```json
{
  "eventType": "PAYMENT_COMPLETED",
  "payload": {
    "paymentId": "string",
    "appointmentId": "string",
    "amount": 200,
    "method": "pix",
    "paidAt": "2026-03-29T20:00:00Z"
  }
}
```

### PAYMENT_FAILED
**Quando:** Falha no pagamento

```json
{
  "eventType": "PAYMENT_FAILED",
  "payload": {
    "appointmentId": "string",
    "amount": 200,
    "error": "Saldo insuficiente"
  }
}
```

---

## 📄 Invoice Events

### INVOICE_PER_SESSION_CREATE
**Quando:** Solicita criação de fatura per-session

```json
{
  "eventType": "INVOICE_PER_SESSION_CREATE",
  "payload": {
    "patientId": "string",
    "appointmentId": "string",
    "sessionValue": 200
  }
}
```

### INVOICE_CREATED
**Quando:** Fatura criada

```json
{
  "eventType": "INVOICE_CREATED",
  "payload": {
    "invoiceId": "string",
    "invoiceNumber": "FAT-202603-0001",
    "patientId": "string",
    "total": 200,
    "status": "open"
  }
}
```

### INVOICE_PAID
**Quando:** Fatura paga

```json
{
  "eventType": "INVOICE_PAID",
  "payload": {
    "invoiceId": "string",
    "paidAmount": 200,
    "paidAt": "2026-03-29T20:00:00Z",
    "paymentId": "string"
  }
}
```

### INVOICE_OVERDUE
**Quando:** Fatura vencida

```json
{
  "eventType": "INVOICE_OVERDUE",
  "payload": {
    "invoiceId": "string",
    "dueDate": "2026-03-20T00:00:00Z",
    "daysOverdue": 9
  }
}
```

---

## 📋 Insurance Batch Events

### INSURANCE_BATCH_SENT
**Quando:** Lote enviado para convênio

```json
{
  "eventType": "INSURANCE_BATCH_SENT",
  "payload": {
    "batchId": "string",
    "batchNumber": "UNI-202603-0001",
    "insuranceProvider": "Unimed",
    "totalSessions": 50,
    "totalGross": 10000
  }
}
```

### INSURANCE_BATCH_RECEIVED
**Quando:** Retorno do convênio processado

```json
{
  "eventType": "INSURANCE_BATCH_RECEIVED",
  "payload": {
    "batchId": "string",
    "totalReceived": 8500,
    "totalGlosa": 1500,
    "processedAt": "2026-03-29T20:00:00Z"
  }
}
```

---

## 🔔 Notification Events

### NOTIFICATION_REQUESTED
**Quando:** Solicita envio de notificação

```json
{
  "eventType": "NOTIFICATION_REQUESTED",
  "payload": {
    "type": "whatsapp|email|sms|push",
    "to": "5561999999999",
    "content": "mensagem",
    "leadId": "string",
    "template": null
  }
}
```

### NOTIFICATION_SENT
**Quando:** Notificação enviada

```json
{
  "eventType": "NOTIFICATION_SENT",
  "payload": {
    "notificationId": "string",
    "type": "whatsapp",
    "sentAt": "2026-03-29T20:00:00Z"
  }
}
```

### NOTIFICATION_FAILED
**Quando:** Falha no envio

```json
{
  "eventType": "NOTIFICATION_FAILED",
  "payload": {
    "type": "email",
    "error": "Mailbox unavailable"
  }
}
```

---

## 🔒 Regras de Validação

### 1. Idempotência
- Todo evento DEVE ter `idempotencyKey` único
- Worker DEVE verificar se já processou

### 2. Correlation ID
- Todo fluxo DEVE ter `correlationId` único
- Deve ser propagado por todos os eventos

### 3. Versionamento
- Schema versão 1 (atual)
- Mudanças breaking → nova versão

### 4. Timestamps
- Sempre em ISO 8601 UTC
- Formato: `2026-03-29T20:00:00.000Z`

---

## 🚀 Exemplo de Fluxo Completo

### Criar → Atualizar → Completar Agendamento

```
1. Cliente chama API
   ↓
2. Controller publica:
   APPOINTMENT_CREATE_REQUESTED
   ↓
3. createAppointmentWorker processa
   ↓
4. Publica:
   APPOINTMENT_CREATED
   ↓
5. Cliente solicita alteração
   ↓
6. Controller publica:
   APPOINTMENT_UPDATE_REQUESTED
   ↓
7. updateOrchestratorWorker processa
   ↓
8. Publica:
   APPOINTMENT_UPDATED
   ↓
9. Cliente solicita completar
   ↓
10. Controller publica:
    APPOINTMENT_COMPLETE_REQUESTED
    ↓
11. completeOrchestratorWorker processa
    ↓
12. Publica:
    APPOINTMENT_COMPLETED
    PAYMENT_COMPLETED (se per-session)
    INVOICE_PER_SESSION_CREATE
    ↓
13. invoiceWorker processa
    ↓
14. Publica:
    INVOICE_CREATED
    NOTIFICATION_REQUESTED (WhatsApp paciente)
    ↓
15. notificationWorker envia WhatsApp
```

---

## 📚 Versões

| Versão | Data | Mudanças |
|--------|------|----------|
| 1.0 | 2026-03-29 | Versão inicial com UPDATE events |

---

## ✅ Checklist de Implementação

- [x] CREATE events
- [x] UPDATE events ⭐ NOVO
- [ ] DELETE events (soft delete)
- [ ] Event store persistente
- [ ] Schema validation (Joi/Zod)
- [ ] Dead Letter Queue (DLQ)
- [ ] Event replay capability
