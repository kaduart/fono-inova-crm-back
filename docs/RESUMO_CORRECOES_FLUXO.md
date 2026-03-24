# 📝 Resumo das Correções - Fluxo Amanda V8

## Problemas Corrigidos

### 1. ✅ Schema Leads.js - Enums Faltando
**Problema:** Erros de validação `metaTracking.source: 'website' is not valid` e `status: 'new' is not valid`

**Arquivo:** `models/Leads.js`

**Correção:**
```javascript
// interactionSchema.status - adicionado 'new'
status: { enum: ['sent', 'received', 'failed', 'read', 'completed', 'new'] }

// leadSchema.status - adicionado 'new'  
status: { enum: ['novo', 'new', 'engajado', ...] }

// metaTracking.source - adicionado 'website'
source: { enum: ['meta_ads', 'google_ads', 'organic', 'indication', 'instagram', 'facebook', 'website', ''] }
```

---

### 2. ✅ Mapeamento therapyArea - Busca de Slots Falhando
**Problema:** A busca de slots retornava vazia porque `therapyArea` vinha como `'fono'` ou `'speech'` mas a busca no MongoDB usava esse valor diretamente, e os médicos têm `specialty: 'fonoaudiologia'` (em português).

**Resultado:** Amanda dizia "não encontrei horários" e transferia desnecessariamente.

**Arquivos corrigidos:**
- `services/messageContextBuilder.js` (linha 85-130)
- `orchestrators/WhatsAppOrchestrator.js` (linha 1212-1240)

**Mapeamentos adicionados:**
| Entrada | Saída |
|---------|-------|
| `fono` | `fonoaudiologia` |
| `speech` | `fonoaudiologia` |
| `psico` | `psicologia` |
| `psychology` | `psicologia` |
| `fisio` | `fisioterapia` |
| `physiotherapy` | `fisioterapia` |
| `to` | `terapia_ocupacional` |
| `occupational` | `terapia_ocupacional` |
| `neuro` | `neuropsicologia` |
| `psicoped` | `psicopedagogia` |
| `music` | `musicoterapia` |

---

## 🔄 Fluxo Completo - Ponta a Ponta

### Passo 1: Lead Envia Mensagem
```
Lead: "Oi! Vi o site da Clínica Fono Inova 💚 É para meu filho, pode me orientar?"
```

**O que acontece:**
- Webhook recebe mensagem
- `whatsappController` identifica lead por telefone
- Mensagem salva no banco
- `handleAutoReply` é chamado

---

### Passo 2: Orquestrador Processa (WhatsAppOrchestrator.js)
```javascript
// Linha 128
const ctx = await buildMessageContext(text, freshLead, currentState, stateData, insights);
```

**O que acontece:**
- Detecta intenções, flags, terapias
- Carrega dados do lead (nome, idade, terapia já salva)
- Determina estado atual do FSM

---

### Passo 3: Detecta Terapia (messageContextBuilder.js)
```javascript
// Linha 85-130
// Se lead disser "dificuldade para falar" → detecta 'fono'
// Se lead disser "fono" → detecta 'fono'

const areaMap = {
    "fono": "fonoaudiologia",  // ← CORREÇÃO APLICADA
    "speech": "fonoaudiologia",
    // ...
};

// Retorna leadData.therapy = "fonoaudiologia" (sempre em português)
```

**Importante:** O mapeamento garante que mesmo que o detector retorne `'fono'`, o `leadData.therapy` será `'fonoaudiologia'`.

---

### Passo 4: Transição de Estados
```
IDLE → COLLECT_THERAPY → COLLECT_COMPLAINT → COLLECT_BIRTH → COLLECT_NAME → SHOW_SLOTS
```

**Fluxo:**
1. **IDLE** → Amanda cumprimenta, pergunta especialidade
2. **COLLECT_THERAPY** → Lead menciona fonoaudiologia → Amanda salva `therapyArea: 'fonoaudiologia'`
3. **COLLECT_COMPLAINT** → Lead descreve dificuldade → Amanda extrai idade
4. **COLLECT_BIRTH** → Confirma data nascimento
5. **COLLECT_NAME** → Pede nome do paciente
6. **SHOW_SLOTS** → Chama `_handleOfferBooking()`

---

### Passo 5: Busca de Slots (_handleOfferBooking)
```javascript
// Linha 1212-1240
const rawTherapy = ctx?.leadData?.therapy;  // "fonoaudiologia" (já normalizado)
const areaMap = { /* ... */ };
const therapyArea = areaMap[rawTherapy] || rawTherapy;  // "fonoaudiologia"

// Busca médicos
const doctorFilter = {
    active: true,
    specialty: therapyArea,  // "fonoaudiologia" ✓
};
const doctors = await Doctor.find(doctorFilter);
```

**O que acontece:**
1. Normaliza therapyArea (garante português)
2. Busca médicos ativos com aquela especialidade
3. Para cada médico, busca slots disponíveis nas próximas datas
4. Filtra por período (manhã/tarde) se especificado
5. Retorna até 3 opções

---

### Passo 6: Retorna Opções ao Lead
```
Amanda: "Encontrei essas opções para você 💚

A) Quarta, 26/03 às 14:00 - Dra. Maria
B) Quinta, 27/03 às 15:30 - Dr. João  
C) Sexta, 28/03 às 14:30 - Dra. Ana

Qual funciona melhor? (A, B, C...)"
```

---

### Passo 7: Lead Escolhe Slot
```
Lead: "B"
```

**O que acontece:**
- Amanda identifica a opção B
- Chama `autoBookAppointment()`
- Cria pré-agendamento no banco
- Envia confirmação com data/hora

---

## 📊 Logs Importantes para Monitorar

### Log de Sucesso na Busca
```
V8_SLOT_SEARCH_START { 
    therapyArea: 'fonoaudiologia',  // ← Deve estar em português
    period: 'tarde',
    patientName: 'Davi Lucas...'
}

V8_SLOTS_FOUND { 
    totalSlots: 3, 
    primaryDoctor: 'Dra. Maria',
    primaryDate: '2026-03-26'
}
```

### Log de Falha (antes da correção)
```
V8_SLOT_SEARCH_START { 
    therapyArea: 'fono',  // ← ERRADO! Deveria ser 'fonoaudiologia'
    period: 'tarde'
}

V8_NO_SLOTS_FOUND_COMPLETE  // ← Falha silenciosa
```

---

## 🧪 Testes Criados

**Arquivo:** `tests/unit/therapyAreaMapping.test.js`

Testa 22 casos de mapeamento:
- Abreviações: `fono`, `psico`, `fisio`, `to`, `neuro`, `psicoped`
- IDs em inglês: `speech`, `psychology`, `physiotherapy`
- Nomes em português: `fonoaudiologia`, `psicologia`, etc.
- Casos especiais: `tongue_tie`, `neuropsychopedagogy`

**Rodar:**
```bash
cd back && node tests/unit/therapyAreaMapping.test.js
```

---

## ✅ Checklist para Validação

- [ ] Lead menciona "fono" → therapyArea é "fonoaudiologia"
- [ ] Lead menciona "psico" → therapyArea é "psicologia"
- [ ] Busca de slots encontra médicos corretamente
- [ ] Amanda mostra opções de horário (não transfere)
- [ ] Schema não dá erro de validação para 'new' ou 'website'

---

## 📁 Arquivos Modificados

1. `models/Leads.js` - Adiciona enums 'new' e 'website'
2. `services/messageContextBuilder.js` - Mapeamento therapyArea
3. `orchestrators/WhatsAppOrchestrator.js` - Normalização therapyArea
4. `tests/unit/therapyAreaMapping.test.js` - Testes unitários (novo)

**Commits:**
- `38e764c` - fix: adiciona 'new' e 'website' aos enums
- `b829594` - fix: corrige mapeamento therapy ID para nome em português  
- `cc34f53` - fix: adiciona mapeamentos de abreviações
