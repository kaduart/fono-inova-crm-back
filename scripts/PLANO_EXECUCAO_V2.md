# 📋 Plano de Execução V2 - Session como Fonte de Verdade

## 🎯 Objetivo
Migrar a fonte de verdade financeira de `Appointment` para `Session`, corrigindo todos os valores zerados.

---

## 🏗️ Nova Arquitetura

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   CALENDÁRIO    │────▶│    SESSION      │────▶│    PAYMENT      │
│  (Appointment)  │     │  (Verdade Real) │     │  (Dinheiro)     │
│                 │     │                 │     │                 │
│ • Agenda        │     │ • Status real   │     │ • Valor pago    │
│ • Ações user    │     │ • Value real    │     │ • Método        │
│ • Projeção      │     │ • Evolução      │     │ • Data          │
└─────────────────┘     └─────────────────┘     └─────────────────┘
           │                       │                       │
           └───────────────────────┼───────────────────────┘
                                   ▼
                    ┌─────────────────────────┐
                    │    FECHAMENTO DIÁRIO    │
                    │        (Novo)           │
                    │                         │
                    │ Usa: Session + Payment  │
                    │ Ignora: Appointment     │
                    └─────────────────────────┘
```

---

## 📁 Scripts Criados

### 1️⃣ `01-fix-session-value.js`
**O que faz:** Preenche `session.value` com base nas fontes corretas

**Prioridade:**
1. Package.sessionValue (se pacote)
2. Payment.amount (se pago)
3. Appointment.sessionValue (fallback)
4. Default (evaluation=200, session=150)

**Comando:**
```bash
cd back && node scripts/01-fix-session-value.js         # DRY RUN
cd back && DRY_RUN=false node scripts/01-fix-session-value.js  # Executar
```

---

### 2️⃣ `02-sync-appointment-from-session.js`
**O que faz:** Sincroniza `appointment` com base na `session`

**Regra:** Session manda, Appointment segue
- `appointment.operationalStatus` ← `session.status`
- `appointment.sessionValue` ← `session.value`

**Comando:**
```bash
cd back && node scripts/02-sync-appointment-from-session.js
cd back && DRY_RUN=false node scripts/02-sync-appointment-from-session.js
```

---

### 3️⃣ `dailyClosingV2.js` (Endpoint)
**O que faz:** Novo endpoint de fechamento usando Session como fonte

**URL:** `GET /api/v2/daily-closing-v2?date=2026-04-09`

**Diferenças do V1:**
- Usa `session.value` em vez de `appointment.sessionValue`
- Usa `session.status` em vez de `appointment.operationalStatus`
- Ignora valores zerados/lixo
- Produção separada de Previsão

---

## 🚀 Ordem de Execução

### PASSO 1: Limpar Lixo (já feito)
```bash
cd back && node scripts/cleanup-test-data.js
```

### PASSO 2: Corrigir Status (já feito)
```bash
cd back && node scripts/corrigir-operationalStatus-real.js
```

### PASSO 3: Corrigir Session (NOVO - DRY RUN primeiro)
```bash
cd back && node scripts/01-fix-session-value.js
```
Verificar o preview, depois:
```bash
cd back && DRY_RUN=false node scripts/01-fix-session-value.js
```

### PASSO 4: Sincronizar Appointment (NOVO)
```bash
cd back && DRY_RUN=false node scripts/02-sync-appointment-from-session.js
```

### PASSO 5: Instalar Endpoint V2 (NOVO)
Adicionar no `server.js` ou `app.js`:
```javascript
import dailyClosingV2 from './routes/dailyClosingV2.js';
app.use('/api/v2', dailyClosingV2);
```

### PASSO 6: Testar Endpoint
```bash
curl 'http://localhost:5000/api/v2/daily-closing-v2?date=2026-04-09' \
  -H 'Authorization: Bearer SEU_TOKEN'
```

---

## 📊 Validação

### Antes (ERRADO):
```json
{
  "expectedValue": 350.12,
  "appointments": [
    { "sessionValue": 0 },
    { "sessionValue": 0.02 },
    { "sessionValue": 0 }
  ]
}
```

### Depois (CORRETO):
```json
{
  "summary": {
    "production": { "value": 500, "count": 5 },
    "expected": { "value": 800, "count": 8 },
    "received": { "value": 350, "count": 3 }
  },
  "timeline": {
    "sessions": [
      { "status": "completed", "value": 100 },
      { "status": "scheduled", "value": 80 }
    ]
  }
}
```

---

## ⚠️ Cuidados

1. **Sempre rode DRY RUN primeiro**
2. **Verifique divergências** (Package vs Payment)
3. **Backup do banco** antes de executar
4. **Teste em dev** antes de prod

---

## 🔄 Rollback

Se precisar reverter:
```javascript
// Remover value das sessions
await Session.updateMany({}, { $unset: { value: 1, valueSource: 1 }});

// Ou restaurar do histórico (salvo nos scripts)
```

---

## ✅ Checklist Final

- [ ] Script 1 executado (session.value preenchido)
- [ ] Script 2 executado (appointment sincronizado)
- [ ] Endpoint V2 instalado
- [ ] Frontend usando novo endpoint
- [ ] Validação feita com dados reais
- [ ] Endpoint antigo deprecado
