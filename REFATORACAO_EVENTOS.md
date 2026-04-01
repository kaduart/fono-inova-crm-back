# 🔧 Refatoração: Adicionar Eventos nos Services

> Guia passo a passo para fechar os 146 gaps de eventos

---

## 📋 ARQUIVOS CRÍTICOS (prioridade)

1. `domains/clinical/services/appointmentService.js` - 34 issues
2. `domains/clinical/services/patientService.js` - já tem, verificar gaps
3. `controllers/` - vários creates/updates
4. `domains/billing/services/paymentService.js` - pagamentos

---

## 🎯 PADRÃO DE REFATORAÇÃO

### ANTES (sem evento):
```javascript
async createAppointment(data) {
  const appointment = await Appointment.create(data);
  return appointment;
}
```

### DEPOIS (com evento):
```javascript
import { withAppointmentEvent } from './withDomainEvent.js';

async createAppointment(data) {
  return withAppointmentEvent('APPOINTMENT_CREATED', async () => {
    const appointment = await Appointment.create(data);
    return appointment;
  });
}
```

---

## 📝 LOCAIS EXATOS (copy/paste)

### 1. appointmentService.js

#### Linha ~58: createAppointment
```javascript
// ADICIONAR NO TOPO DO ARQUIVO:
import { withAppointmentEvent } from './withDomainEvent.js';

// SUBSTITUIR a função createAppointment:
async createAppointment(data) {
  return withAppointmentEvent('APPOINTMENT_CREATED', async () => {
    const appointment = await Appointment.create(data);
    
    // Popula para retornar dados completos
    await appointment.populate('patient doctor');
    
    return appointment;
  });
}
```

#### Linha ~128: updateAppointment (completar)
```javascript
// SUBSTITUIR:
async completeAppointment(id, data) {
  return withAppointmentEvent('APPOINTMENT_COMPLETED', async () => {
    const appointment = await Appointment.findByIdAndUpdate(
      id,
      { 
        operationalStatus: 'completed',
        clinicalStatus: 'completed',
        completedAt: new Date(),
        ...data
      },
      { new: true }
    ).populate('patient doctor');
    
    return appointment;
  }, {
    additionalPayload: {
      completedAt: new Date().toISOString()
    }
  });
}
```

#### Linha ~194: cancelAppointment
```javascript
// SUBSTITUIR:
async cancelAppointment(id, reason) {
  return withAppointmentEvent('APPOINTMENT_CANCELLED', async () => {
    const appointment = await Appointment.findByIdAndUpdate(
      id,
      { 
        operationalStatus: 'canceled',
        cancelledAt: new Date(),
        cancelReason: reason
      },
      { new: true }
    ).populate('patient doctor');
    
    return appointment;
  }, {
    additionalPayload: {
      cancelledAt: new Date().toISOString(),
      reason
    }
  });
}
```

#### Linha ~266: rescheduleAppointment
```javascript
// SUBSTITUIR:
async rescheduleAppointment(id, newDate, newTime) {
  return withAppointmentEvent('APPOINTMENT_RESCHEDULED', async () => {
    const old = await Appointment.findById(id);
    
    const appointment = await Appointment.findByIdAndUpdate(
      id,
      { date: newDate, time: newTime },
      { new: true }
    ).populate('patient doctor');
    
    return {
      ...appointment.toObject(),
      previousDate: old.date,
      previousTime: old.time
    };
  }, {
    getPayload: (result) => ({
      appointmentId: result._id.toString(),
      patientId: result.patient?._id?.toString() || result.patient,
      previousDate: result.previousDate,
      newDate: result.date,
      rescheduledAt: new Date().toISOString()
    })
  });
}
```

---

### 2. patientService.js (verificar gaps)

Já temos `patientWorker.js` que emite eventos, mas verificar se `patientService.js` direto também emite:

```javascript
// ADICIONAR NO TOPO:
import { withPatientEvent } from './withDomainEvent.js';

// Verificar função create - se existir, substituir:
async createPatient(data) {
  return withPatientEvent('PATIENT_CREATED', async () => {
    const patient = new Patient(data);
    await patient.save();
    return patient;
  });
}

// Verificar função update - se existir, substituir:
async updatePatient(id, data) {
  return withPatientEvent('PATIENT_UPDATED', async () => {
    const patient = await Patient.findByIdAndUpdate(
      id,
      data,
      { new: true }
    );
    
    return {
      ...patient.toObject(),
      updatedFields: Object.keys(data)
    };
  }, {
    getPayload: (result) => ({
      patientId: result._id.toString(),
      updatedFields: result.updatedFields,
      updatedAt: new Date().toISOString()
    })
  });
}
```

---

### 3. paymentService.js (billing)

```javascript
// ADICIONAR NO TOPO:
import { withPaymentEvent } from '../../clinical/services/withDomainEvent.js';

// Encontrar função createPayment ou similar:
async createPayment(data) {
  return withPaymentEvent('PAYMENT_RECEIVED', async () => {
    const payment = await Payment.create({
      ...data,
      status: 'completed',
      paidAt: new Date()
    });
    
    await payment.populate('patient appointment');
    
    return payment;
  });
}
```

---

### 4. Controllers (pontos de entrada legados)

#### controllers/patient.js - create
```javascript
// Se chama patientService.create, já está OK
// Se faz Patient.create direto, MIGRAR para usar service

// ❌ ERRADO:
const patient = await Patient.create(req.body);

// ✅ CERTO:
const patient = await patientService.create(req.body);
// ou
const patient = await patientWorker.processJob(...);
```

---

## 🧪 VALIDAÇÃO APÓS REFATORAÇÃO

### 1. Rodar audit novamente
```bash
node scripts/auditEventCoverage.js
```

Meta: **> 95%**

### 2. Testar fluxos manuais
```bash
node tests/patientV2.consistency.test.js
```

### 3. Validar consistência
```bash
SAMPLE_SIZE=100 node scripts/validateConsistency.js
```

---

## 📊 MÉTRICAS DE SUCESSO

| Antes | Depois |
|-------|--------|
| 1.4% cobertura | > 95% cobertura |
| 146 issues | 0-5 issues |
| PatientsView inconsistente | PatientsView 100% consistente |

---

## ⚠️ CUIDADOS

1. **NÃO** mude a lógica de negócio, só adicione eventos
2. **SEMPRE** popule o documento antes de retornar (para ter dados completos no evento)
3. **TESTE** cada função após refatorar
4. **COMMIT** a cada arquivo refatorado

---

## 🚀 PRÓXIMOS PASSOS

1. Refatorar `appointmentService.js` (maior impacto)
2. Refatorar `paymentService.js`
3. Rodar audit
4. Testar
5. Só depois → migrar outros domínios

---

**Mão na massa!** 💪
