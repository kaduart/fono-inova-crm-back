# 🔥 TOP 20 Pontos Críticos - Adicionar Eventos

> Ordenados por impacto no PatientsView

---

## 🎯 CRITÉRIO DE PRIORIDADE

1. **Afeta PatientsView diretamente** (stats, lastAppointment, etc)
2. **Volume de uso** (quanto é chamado)
3. **Risco de inconsistência**

---

## 🔴 PRIORIDADE 1 (CRÍTICO - afeta PatientsView)

### 1. `workers/completeOrchestratorWorker.js:254`
```javascript
await Appointment.findByIdAndUpdate(
  appointmentId,
  { operationalStatus: 'completed' }
);
```
**Impacto:** Atualiza `lastAppointment`, `totalCompleted`
**Evento:** `APPOINTMENT_COMPLETED`

---

### 2. `workers/cancelOrchestratorWorker.js` (buscar linha similar)
```javascript
await Appointment.findByIdAndUpdate(
  appointmentId,
  { operationalStatus: 'canceled' }
);
```
**Impacto:** Atualiza `totalCanceled`
**Evento:** `APPOINTMENT_CANCELLED`

---

### 3. `routes/appointment.js:609`
```javascript
const appointment = await Appointment.create({...});
```
**Impacto:** Cria appointment → afeta `totalAppointments`, `nextAppointment`
**Evento:** `APPOINTMENT_CREATED`

---

### 4. `routes/appointment.js:1529`
```javascript
const updated = await Appointment.findByIdAndUpdate(appointmentId, {...});
```
**Impacto:** Update geral → pode afetar data/hora
**Evento:** `APPOINTMENT_UPDATED`

---

### 5. `controllers/convenioPackageController.js:527`
```javascript
await Appointment.findByIdAndUpdate(appointmentId, {...});
```
**Impacto:** Atualiza status de convênio
**Evento:** `APPOINTMENT_UPDATED`

---

### 6. `controllers/convenioPackageController.js:863`
```javascript
await newAppointment.save({ session: mongoSession });
```
**Impacto:** Cria appointment de convênio
**Evento:** `APPOINTMENT_CREATED`

---

### 7. `routes/Payment.js:3314`
```javascript
await Appointment.findByIdAndUpdate(appointmentId, {...});
```
**Impacto:** Vincula pagamento ao appointment
**Evento:** `APPOINTMENT_UPDATED`

---

### 8. `routes/Payment.js:593`
```javascript
await newAppointment.save({ session: mongoSession });
```
**Impacto:** Cria appointment ao receber pagamento
**Evento:** `APPOINTMENT_CREATED`

---

### 9. `routes/preAgendamento.js:101`
```javascript
const appointment = await Appointment.create(appointmentData);
```
**Impacto:** Pré-agendamento
**Evento:** `APPOINTMENT_CREATED`

---

### 10. `routes/preAgendamento.js:474`
```javascript
const pre = await Appointment.findByIdAndUpdate(id, {...});
```
**Impacto:** Confirma pré-agendamento
**Evento:** `APPOINTMENT_UPDATED`

---

## 🟡 PRIORIDADE 2 (ALTO - operações frequentes)

### 11. `routes/appointment.js:2790`
```javascript
const appointment = await Appointment.create({...});
```
**Contexto:** Criação em lote
**Evento:** `APPOINTMENT_CREATED`

---

### 12. `routes/importFromAgenda.js:176`
```javascript
const appointment = await Appointment.create(appointmentData);
```
**Contexto:** Importação externa
**Evento:** `APPOINTMENT_CREATED`

---

### 13. `routes/importFromAgenda.js:631`
```javascript
await Appointment.findByIdAndUpdate(id, {...});
```
**Contexto:** Update na importação
**Evento:** `APPOINTMENT_UPDATED`

---

### 14. `controllers/packageSessionController.js:86`
```javascript
await Appointment.findByIdAndUpdate(id, {...});
```
**Contexto:** Vincula pacote à sessão
**Evento:** `APPOINTMENT_UPDATED`

---

### 15. `domain/liminar/recognizeRevenue.js:91`
```javascript
await Appointment.findByIdAndUpdate(appointmentId, {...});
```
**Contexto:** Reconhecimento de receita
**Evento:** `APPOINTMENT_UPDATED`

---

## 🟢 PRIORIDADE 3 (MÉDIO - edge cases)

### 16. `controllers/therapyPackageController.js:237`
```javascript
await Appointment.deleteOne({ _id: appointmentId });
```
**Contexto:** Deleção (raro)
**Evento:** `APPOINTMENT_DELETED`

---

### 17. `controllers/therapyPackageController.js:1823`
```javascript
await newAppointment.save({...});
```
**Contexto:** Conversão de pacote
**Evento:** `APPOINTMENT_CREATED`

---

### 18. `routes/appointment.js:1086`
```javascript
const appointment = await Appointment.findOneAndUpdate(...);
```
**Contexto:** Update com condição
**Evento:** `APPOINTMENT_UPDATED`

---

### 19. `routes/preAgendamento.js:499`
```javascript
const pre = await Appointment.findByIdAndUpdate(id, {...});
```
**Contexto:** Cancelamento de pré-agendamento
**Evento:** `APPOINTMENT_CANCELLED`

---

### 20. `routes/preAgendamento.js:665`
```javascript
const pre = await Appointment.findByIdAndUpdate(id, {...});
```
**Contexto:** Reagendamento
**Evento:** `APPOINTMENT_RESCHEDULED`

---

## 📊 ESTRATÉGIA DE IMPLEMENTAÇÃO

### Fase 1 (Hoje): Prioridade 1 (10 pontos)
→ Impacto imediato no PatientsView

### Fase 2 (Amanhã): Prioridade 2 (5 pontos)
→ Operações frequentes

### Fase 3 (Depois): Prioridade 3 (5 pontos)
→ Edge cases

---

## ✅ CHECKLIST DE IMPLEMENTAÇÃO

- [ ] 1. `completeOrchestratorWorker.js`
- [ ] 2. `cancelOrchestratorWorker.js`
- [ ] 3. `routes/appointment.js:609`
- [ ] 4. `routes/appointment.js:1529`
- [ ] 5. `convenioPackageController.js:527`
- [ ] 6. `convenioPackageController.js:863`
- [ ] 7. `Payment.js:3314`
- [ ] 8. `Payment.js:593`
- [ ] 9. `preAgendamento.js:101`
- [ ] 10. `preAgendamento.js:474`

---

**Meta após Fase 1:** Cobertura de eventos > 60%
