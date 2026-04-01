# Fluxo Completo - Agendamento + Pagamento

## Diagrama

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant DB
    participant Outbox
    participant AppointmentWorker
    participant PaymentWorker
    participant NotificationWorker

    %% Fluxo de Sucesso
    rect rgb(200, 255, 200)
    Note over Client,NotificationWorker: FLUXO DE SUCESSO
    
    Client->>API: POST /appointments
    API->>DB: CREATE appointment (pending)
    API->>Outbox: SAVE event APPOINTMENT_REQUESTED
    API-->>Client: 202 Accepted (eventId)
    
    Outbox->>AppointmentWorker: PUBLISH event
    AppointmentWorker->>DB: VALIDATE slot
    AppointmentWorker->>DB: UPDATE appointment (validating)
    AppointmentWorker->>Outbox: SAVE event PAYMENT_REQUESTED
    
    Outbox->>PaymentWorker: PUBLISH event
    PaymentWorker->>DB: CREATE payment (pending)
    PaymentWorker->>PaymentWorker: PROCESS payment
    PaymentWorker->>DB: UPDATE payment (paid)
    PaymentWorker->>DB: UPDATE appointment (confirmed)
    PaymentWorker->>Outbox: SAVE event NOTIFICATION_REQUESTED
    
    Outbox->>NotificationWorker: PUBLISH event
    NotificationWorker->>Client: WhatsApp: "Agendamento confirmado!"
    end

    %% Fluxo de Falha
    rect rgb(255, 200, 200)
    Note over Client,NotificationWorker: FLUXO DE FALHA (COMPENSAÇÃO)
    
    Client->>API: POST /appointments
    API->>DB: CREATE appointment (pending)
    API->>Outbox: SAVE event
    API-->>Client: 202 Accepted
    
    Outbox->>AppointmentWorker: PUBLISH event
    AppointmentWorker->>DB: VALIDATE slot
    AppointmentWorker->>Outbox: SAVE event PAYMENT_REQUESTED
    
    Outbox->>PaymentWorker: PUBLISH event
    PaymentWorker->>DB: CREATE payment (pending)
    PaymentWorker->>PaymentWorker: PROCESS payment
    Note right of PaymentWorker: Pagamento RECUSADO
    PaymentWorker->>DB: UPDATE payment (failed)
    PaymentWorker->>DB: UPDATE appointment (rejected)
    Note right of PaymentWorker: COMPENSAÇÃO
    PaymentWorker->>Outbox: SAVE event NOTIFICATION_REQUESTED
    
    Outbox->>NotificationWorker: PUBLISH event
    NotificationWorker->>Client: WhatsApp: "Pagamento recusado. Agendamento cancelado."
    end
```

## Estados do Agendamento

```
pending → validating → scheduled
              ↓              ↓
         rejected      completed
```

## Estados do Pagamento

```
pending → paid
    ↓
failed → (compensação cancela agendamento)
```

## Eventos

| Evento | Produtor | Consumidor | Ação |
|--------|----------|------------|------|
| APPOINTMENT_REQUESTED | API | AppointmentWorker | Valida e confirma |
| PAYMENT_REQUESTED | AppointmentWorker | PaymentWorker | Processa pagamento |
| PAYMENT_CONFIRMED | PaymentWorker | - | Confirma agendamento |
| PAYMENT_FAILED | PaymentWorker | - | Compensa (cancela) |
| NOTIFICATION_REQUESTED | Workers | NotificationWorker | Envia WhatsApp/email |

## Testar Local

```bash
# 1. Iniciar tudo
redis-server
mongod
node workers/index.js
npm run dev

# 2. Criar agendamento (sucesso)
curl -X POST http://localhost:5000/api/appointments \
  -d '{
    "patientId": "...",
    "doctorId": "...",
    "date": "2024-02-01",
    "time": "14:00",
    "amount": 200,
    "paymentMethod": "pix"
  }'

# 3. Verificar status
redis-cli keys "bull:*"
db.outboxes.find().pretty()
db.appointments.find().pretty()

# 4. Simular falha (10% chance no código)
# Rode várias vezes até ver uma compensação
```

## Métricas

```javascript
// Taxa de sucesso
const success = await Appointment.countDocuments({ 
    operationalStatus: 'scheduled' 
});
const failed = await Appointment.countDocuments({ 
    operationalStatus: 'rejected' 
});
const successRate = success / (success + failed);

// Tempo médio de processamento
// (do createdAt ao confirmedAt)
```
