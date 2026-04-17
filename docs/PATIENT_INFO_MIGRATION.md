# 🔥 Migração: Unificação do Patient DTO V2

## Status: EM ROLLOUT

---

## 1. Problema

Existiam **3 fontes concorrentes** para o nome/telefone do paciente no mesmo response:

```json
{
  "patient": { "_id": "...", "fullName": "Kleldson Ravi..." },
  "patientName": "Kleldson Ravi...",
  "patientInfo": { "fullName": "", "phone": "" }   // ← quebrado
}
```

Isso fazia o nome **sumir magicamente** quando o `operationalStatus` mudava de
`scheduled` → `pre_agendado`, porque o endpoint de pré-agendamentos não populava
`patient`, forçando a UI a ler de `patientInfo` vazio.

---

## 2. Solução Arquitetural

### Princípio Absoluto

> **`patient` populado é a única fonte de verdade.**  
> A UI nunca mais deve tratar `pre_agendado` diferente de `scheduled`.

### Entregáveis

1. **Mapper DTO único** (`utils/appointmentDto.js`)
2. **Todos os endpoints V2** usam o mesmo DTO
3. **Compat layer**: `patientInfo` ainda é preenchido no DTO para não quebrar consumidores antigos
4. **Backfill script**: corrige registros históricos no MongoDB
5. **Cleanup progressivo**: remover dependências de `patientInfo` no frontend

---

## 3. Arquivos Alterados

### Backend

| Arquivo | Mudança |
|---------|---------|
| `utils/appointmentDto.js` | **NOVO** — mapper único |
| `routes/appointment.v2.js` | GET / e PUT /:id retornam `mapAppointmentDTO()` |
| `routes/preAgendamento.engine.js` | GET / e GET /:id retornam `mapAppointmentDTO()` + `.populate('patient')` |
| `routes/preAgendamento.js` | GET / e GET /:id retornam `mapAppointmentDTO()` + `.populate('patient')` |

### Frontend

| Arquivo | Mudança |
|---------|---------|
| `services/appointmentsRepo.js` | `resolvePatientName` e `mapV2Appointment` leem só de `patient` |
| `App.jsx` | `mappedPreAppointments` usa `pre.patient?.fullName` |
| `components/AppointmentModal.jsx` | `resolvePatientData` unificado sem depender de `patientInfo` |
| `api/v2/agendaV2Client.js` | `updateAppointment` envia nome corretamente sem depender de `patientInfo` |
| `components/AppointmentRow.jsx` | Remove leitura de `appointment.patientInfo?.phone` |

---

## 4. Rollout Step-by-Step

### Passo 1 — Deploy Backend

```bash
cd /home/user/projetos/crm/back
git add .
git commit -m "feat(v2): unified AppointmentDTO with patient populate guarantee"
# deploy
```

### Passo 2 — Verificar Endpoints

```bash
# Testar GET de scheduled
curl /api/v2/appointments?startDate=...&endDate=...

# Testar GET de pre_agendado
curl /api/v2/pre-appointments

# Verificar que ambos retornam:
#   patient: { _id, fullName, phone, email, birthDate }
#   patientName: "..."
#   patientInfo: { fullName: "...", phone: "..." }  # compat layer
```

### Passo 3 — Rodar Backfill (DRY-RUN)

```bash
cd /home/user/projetos/crm/back
node scripts/migrations/backfill-patient-info.js
```

> Saída esperada: `"DRY-RUN: nenhuma alteração será aplicada"`

### Passo 4 — Rodar Backfill (COMMIT)

```bash
node scripts/migrations/backfill-patient-info.js --commit
```

### Passo 5 — Deploy Frontend

```bash
cd /home/user/projetos/agenda-clinica-web
npm run build
# deploy dist/
```

### Passo 6 — Teste de Regressão

1. Abrir agenda
2. Editar um agendamento `scheduled`
3. Mudar status para `Pré-Agendado`
4. **Verificar**: nome do paciente continua visível na lista
5. Voltar para `scheduled`
6. **Verificar**: nome continua visível

---

## 5. Rollback Strategy

### Se algo quebrar no Backend

O mapper DTO é **aditivo**: ele só *padroniza* o formato de saída, não remove
campos. Consumidores antigos que liam `patientInfo` continuam funcionando porque
o DTO ainda inclui `patientInfo` preenchido a partir de `patient`.

**Rollback imediato:**
- Reverter o commit do backend
- Redeploy da versão anterior

> ⚠️ Nenhum dado foi alterado no banco ainda (o backfill é separado).

### Se algo quebrar no Frontend

O frontend novo só *deixou de ler* `patientInfo`. Se precisar voltar:
- Reverter o commit do frontend
- Redeploy

### Se o Backfill causar problema

O script usa `bulkWrite` com filtro por `_id` exato. Para reverter:

```js
// Restaurar de backup se necessário
// Ou, se souber quais foram alterados, limpar patientInfo:
db.appointments.updateMany(
  { /* criteria */ },
  { $unset: { patientInfo: 1 } }
)
```

**Recomendação:** rode o backfill em horário de baixo movimento.

---

## 6. Cleanup Progressivo (pós-estabilização)

Após 7-14 dias sem incidentes:

### Fase A — Remover `patientInfo` do schema de leitura

- Atualizar todos os frontend clients para não lerem `patientInfo`
- Remover o campo `patientInfo` do `mapAppointmentDTO` (só quando 100% dos clients estiverem atualizados)

### Fase B — Schema cleanup

- Criar índice secundário em `patient` se necessário
- Avaliar se `patientInfo` ainda precisa existir no schema MongoDB
- Se não houver queries diretas em `patientInfo.fullName`, pode ser removido do schema

---

## 7. Checklist de Validação

- [ ] `GET /api/v2/appointments` retorna `patient` populado
- [ ] `GET /api/v2/pre-appointments` retorna `patient` populado
- [ ] `PUT /api/v2/appointments/:id` retorna `patient` populado
- [ ] Frontend não usa mais `appointment.patientInfo?.fullName`
- [ ] Backfill rodou sem erros
- [ ] Teste manual: scheduled → pre_agendado mantém o nome
- [ ] Nenhum erro no build do frontend (`npm run build`)
- [ ] Nenhum erro nos logs do backend por 24h

---

## 8. Contato / Responsável

- **Autor do patch:** Kimi Code CLI
- **Data:** 2026-04-16
- **Issue raiz:** Model duplication (`patient` vs `patientInfo` vs `patientName`)
