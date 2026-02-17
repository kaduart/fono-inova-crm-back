# 🔄 Sincronização Bidirecional: Amanda ↔ Agenda Externa

## 🎯 Objetivo

Garantir que **nenhum horário seja agendado duas vezes**, independente da origem (Amanda ou Agenda Externa).

---

## 🏗️ Como Funciona

### ✅ Cenário 1: Secretária Agenda → Amanda Respeita

```
1️⃣ Secretária cria pré-agendamento na agenda externa
   → POST /import-from-agenda/criar-e-confirmar
   → Cria PreAgendamento
   → Cria Appointment com operationalStatus: 'pre-scheduled'

2️⃣ Horário BLOQUEADO no CRM
   → Doctor + Date + Time ocupado

3️⃣ Amanda conversa com outro paciente
   → Lead: "Quero agendar"
   → Amanda busca slots disponíveis via findAvailableSlots()
   → Middleware checkAppointmentConflicts detecta conflito
   → 14h NÃO aparece na lista ✅

4️⃣ Amanda oferece outros horários
   → "Temos 15h ou 16h disponível"
   → SEM CONFLITO! ✅
```

---

### ✅ Cenário 2: Amanda Agenda → Secretária Vê Como Pendente

```
1️⃣ Amanda agenda paciente via WhatsApp
   → autoBookAppointment() chamado
   → Cria Appointment com:
      - operationalStatus: 'scheduled'
      - metadata.origin.source: 'amandaAI'

2️⃣ Horário BLOQUEADO no CRM
   → Doctor + Date + Time ocupado

3️⃣ Agenda externa busca appointments pendentes
   → GET /import-from-agenda/appointments-amanda
   → Retorna: [{
        externalId: 'AMANDA-675abc...',
        status: 'pendente_confirmacao',
        date: '2026-02-20',
        time: '14:00',
        source: 'amanda_ai',
        isPending: true
      }]

4️⃣ Secretária VÊ na agenda externa
   → Badge: "⚠️ AGENDADO POR AMANDA - PENDENTE CONFIRMAÇÃO"
   → Opções: [Confirmar] [Cancelar] [Editar]

5️⃣ Secretária tenta agendar outro paciente no mesmo horário
   → Sistema mostra: "❌ Horário ocupado (Amanda - João Silva)"
   → SEM CONFLITO! ✅
```

---

## 📊 Diagrama de Fluxo

```
┌─────────────────────────────────────────────────────────────────┐
│                    BANCO DE DADOS (CRM)                          │
│                                                                  │
│  Appointments Collection:                                        │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ { doctor: "Dra. Maria", date: "2026-02-20", time:      │    │
│  │   "14:00", operationalStatus: "pre-scheduled",         │    │
│  │   metadata.origin.source: "agenda_externa" }           │ ◄──┼── Secretária
│  └────────────────────────────────────────────────────────┘    │    agenda
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ { doctor: "Dra. Maria", date: "2026-02-20", time:      │    │
│  │   "15:00", operationalStatus: "scheduled",             │    │
│  │   metadata.origin.source: "amandaAI" }                 │ ◄──┼── Amanda
│  └────────────────────────────────────────────────────────┘    │    agenda
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                   │                              │
                   ▼                              ▼
        ┌──────────────────┐          ┌──────────────────┐
        │  Amanda busca    │          │ Agenda Externa   │
        │  slots           │          │ busca pendentes  │
        │                  │          │                  │
        │ - 14h: ❌ ocupado│          │ - 14h: ocupado   │
        │ - 15h: ❌ ocupado│          │ - 15h: AMANDA ⚠️ │
        │ - 16h: ✅ livre  │          │ - 16h: ✅ livre  │
        └──────────────────┘          └──────────────────┘
```

---

## 🔧 Endpoints

### 1. `GET /api/import-from-agenda/appointments-amanda`

**Função**: Retorna appointments agendados pela Amanda

**Query Params**:
```
?date=2026-02-20          (opcional - filtrar por data)
&doctorId=675abc...       (opcional - filtrar por profissional)
&status=scheduled         (opcional - filtrar por status)
```

**Response**:
```json
{
  "success": true,
  "count": 2,
  "appointments": [
    {
      "appointmentId": "675abc123...",
      "externalId": "AMANDA-675abc123...",
      "status": "pendente_confirmacao",
      "date": "2026-02-20",
      "time": "14:00",
      "professionalName": "Dra. Maria Silva",
      "professionalId": "674def...",
      "specialty": "fonoaudiologia",
      "patientInfo": {
        "fullName": "João Silva",
        "phone": "62999999999",
        "birthDate": "01/01/2010"
      },
      "sessionType": "avaliacao",
      "notes": "[AGENDADO AUTOMATICAMENTE VIA AMANDA/WHATSAPP]",
      "createdAt": "2026-02-16T10:30:00Z",
      "source": "amanda_ai",
      "isPending": true,
      "canConfirm": true,
      "canCancel": true
    }
  ]
}
```

---

### 2. Como a Agenda Externa Deve Usar

#### Ao carregar a agenda do dia:

```javascript
// 1. Buscar appointments da agenda externa (seus próprios)
const external = await fetch('/api/appointments?date=2026-02-20');

// 2. Buscar appointments da Amanda
const amanda = await fetch('/api/import-from-agenda/appointments-amanda?date=2026-02-20');

// 3. Combinar e mostrar na interface
const allAppointments = [
  ...external.data.map(a => ({ ...a, origin: 'externa' })),
  ...amanda.data.appointments.map(a => ({ ...a, origin: 'amanda' }))
];

// 4. Renderizar com badges diferentes
allAppointments.forEach(appt => {
  if (appt.origin === 'amanda') {
    renderWithBadge(appt, '⚠️ AMANDA - PENDENTE', 'warning');
  } else if (appt.status === 'pre-scheduled') {
    renderWithBadge(appt, '🟡 PRÉ-AGENDADO', 'info');
  } else {
    renderWithBadge(appt, '🟢 CONFIRMADO', 'success');
  }
});
```

---

## 🎨 Visualização Sugerida na Agenda Externa

```
┌─────────────────────────────────────────────────────────────────┐
│ 📅 Agenda - 20/02/2026 - Dra. Maria                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ 08:00 ┌────────────────────────────────────────────────┐        │
│       │ ✅ Ana Costa - Avaliação                        │        │
│       │ 🟢 CONFIRMADO                                   │        │
│       └────────────────────────────────────────────────┘        │
│                                                                  │
│ 09:00 [Disponível]                                              │
│                                                                  │
│ 10:00 ┌────────────────────────────────────────────────┐        │
│       │ Pedro Santos - Terapia                          │        │
│       │ 🟡 PRÉ-AGENDADO (Importado da agenda externa)  │        │
│       │ [Confirmar] [Cancelar]                          │        │
│       └────────────────────────────────────────────────┘        │
│                                                                  │
│ 11:00 [Disponível]                                              │
│                                                                  │
│ 14:00 ┌────────────────────────────────────────────────┐        │
│       │ ⚠️ João Silva - Avaliação                       │        │
│       │ 🤖 AGENDADO POR AMANDA - PENDENTE               │        │
│       │ WhatsApp: 62999999999                           │        │
│       │ [Confirmar] [Cancelar] [Editar]                 │        │
│       └────────────────────────────────────────────────┘        │
│                                                                  │
│ 15:00 ┌────────────────────────────────────────────────┐        │
│       │ ⚠️ Maria Souza - Terapia                        │        │
│       │ 🤖 AGENDADO POR AMANDA - PENDENTE               │        │
│       │ [Confirmar] [Cancelar]                          │        │
│       └────────────────────────────────────────────────┘        │
│                                                                  │
│ 16:00 [Disponível]                                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔒 Garantias de Segurança

### ✅ Bloqueio de Horário

Ambos os tipos de appointment **BLOQUEIAM** o horário:

| Origem | Status | Bloqueia? | Visível para Amanda? | Visível para Secretária? |
|--------|--------|-----------|---------------------|--------------------------|
| Agenda Externa | `pre-scheduled` | ✅ SIM | ❌ Não (ocupado) | ✅ Sim (pré-agendado) |
| Agenda Externa | `scheduled` | ✅ SIM | ❌ Não (ocupado) | ✅ Sim (confirmado) |
| Amanda | `scheduled` | ✅ SIM | ❌ Não oferece de novo | ✅ Sim (pendente Amanda) |

### ✅ Middleware de Conflito

O `checkAppointmentConflicts` verifica **TODOS** os appointments:

```javascript
// middleware/conflictDetection.js
const doctorConflict = await Appointment.findOne({
  doctor: doctorId,
  date: date,
  time: time,
  operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES }
  // 'pre-scheduled' NÃO está em NON_BLOCKING
  // 'scheduled' (Amanda) NÃO está em NON_BLOCKING
  // → AMBOS BLOQUEIAM! ✅
});
```

---

## 🧪 Testes

### Teste 1: Secretária → Amanda

```bash
# 1. Secretária agenda
curl -X POST http://localhost:5000/api/import-from-agenda/criar-e-confirmar \
  -d '{ "date": "2026-02-25", "time": "14:00", ... }'
# Response: appointment criado com pre-scheduled

# 2. Simular Amanda buscando slots
curl http://localhost:5000/api/appointments/available-slots?doctorId=XXX&date=2026-02-25
# Response: 14h NÃO aparece ✅
```

### Teste 2: Amanda → Secretária

```bash
# 1. Amanda agenda (via autoBookAppointment)
# Appointment criado com source: 'amandaAI'

# 2. Agenda externa busca pendentes
curl -X GET http://localhost:5000/api/import-from-agenda/appointments-amanda?date=2026-02-25 \
  -H "Authorization: Bearer $AGENDA_TOKEN"

# Response:
# {
#   "appointments": [{
#     "externalId": "AMANDA-675abc...",
#     "status": "pendente_confirmacao",
#     "time": "14:00",
#     "isPending": true
#   }]
# } ✅
```

---

## 📝 Checklist de Implementação

### Backend ✅
- [x] Campo `metadata.origin.source` já existe
- [x] Amanda já usa `source: 'amandaAI'`
- [x] Endpoint `/appointments-amanda` criado
- [x] Status `pre-scheduled` bloqueia horário
- [x] Middleware de conflito funciona para ambos

### Frontend (Agenda Externa) ⏳
- [ ] Integrar chamada ao endpoint `/appointments-amanda`
- [ ] Renderizar badges diferenciados ("AMANDA", "PRÉ-AGENDADO", "CONFIRMADO")
- [ ] Bloquear tentativa de agendar em horário ocupado
- [ ] Permitir secretária confirmar/cancelar appointments da Amanda

---

## 🎯 Benefícios

### Antes:
- ❌ Amanda e secretária podiam agendar mesmo horário
- ❌ Conflito 409 descoberto tarde
- ❌ Secretária não via o que Amanda agendou

### Agora:
- ✅ Bloqueio em tempo real
- ✅ Nenhum conflito possível
- ✅ Secretária vê appointments da Amanda como "pendentes"
- ✅ Rastreabilidade total (source field)

---

**Autor**: Claude (Anthropic)
**Data**: 2026-02-16
**Versão**: 1.0
