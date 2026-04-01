# 🔄 Sistema AUTO-COLLECT + DEPENDÊNCIAS - Bruno Collection

Este sistema:
1. **Verifica dependências** antes de executar (pre-request scripts)
2. **Salva automaticamente** variáveis no environment (post-response scripts)
3. **Sugere o próximo passo** no console

---

## 🗺️ Mapa de Dependências

```
┌─────────────────────────────────────────────────────────────────┐
│                    FLUXO PRINCIPAL                               │
└─────────────────────────────────────────────────────────────────┘

CREATE PARTICULAR / CREATE PACKAGE SESSION
        ↓ (auto-salva: appointmentId, correlationId)
        ↓
CHECK STATUS ←──┐ (polling até sair de processing_*)
        ↓       │ (auto-salva: canComplete, hasSession)
        └───────┘
        ↓
GET APPOINTMENT FULL
        ↓ (auto-salva: sessionId, paymentId, packageId)
        ↓
┌─────────────────┬─────────────────┬─────────────────┐
│                 │                 │                 │
↓                 ↓                 ↓                 ↓
GET SESSION    GET PAYMENT    CANCEL         COMPLETE
                              APPOINTMENT    SESSION
│                 │                 │                 │
└─────────────────┴─────────────────┴─────────────────┘
```

---

## ⚠️ Verificação de Dependências (Pre-Request)

Cada endpoint verifica se tem o que precisa **antes** de executar:

### Get Appointment Full, Check Status, Cancel, Complete
```javascript
// Verifica: {{appointmentId}}
❌ ERRO: appointmentId não encontrado!
   Execute primeiro: POST Create Particular
```

### Get Session
```javascript
// Verifica: {{sessionId}}
❌ ERRO: sessionId não encontrado!
   DEPENDÊNCIA 1: Execute 'Get Appointment Full'

💡 DICA: Você tem appointmentId: 67e6a1b2...
   Execute 'Get Appointment Full' para obter o sessionId
```

### Get Payment
```javascript
// Verifica: {{paymentId}}
❌ ERRO: paymentId não encontrado!
   DEPENDÊNCIA 1: Execute 'Get Appointment Full'
```

### Complete Session
```javascript
// Verifica: {{appointmentId}} + {{canComplete}}
⚠️ AVISO: canComplete = false
   Execute 'Check Status' primeiro para verificar
```

### Complete with Balance
```javascript
// Verifica: {{appointmentId}} + {{lastSessionValue}}
⚠️ lastSessionValue não encontrado
   Usando valor default de 200
   Execute 'Get Appointment Full' para obter o valor real
```

---

## 📋 Variáveis Auto-Salvas

### Criação de Agendamentos
| Endpoint | Variável | Descrição |
|----------|----------|-----------|
| Create Particular | `appointmentId` | ID do agendamento |
| Create Particular | `correlationId` | Para rastreamento |
| Create Particular | `idempotencyKey` | Idempotência |
| Create Particular | `lastEventId` | ID do evento |
| Create Package Session | `lastPackageSession` | Flag: "true" |

### Consulta
| Endpoint | Variável | Descrição |
|----------|----------|-----------|
| Get Appointment Full | `sessionId` | ID da sessão |
| Get Appointment Full | `paymentId` | ID do pagamento |
| Get Appointment Full | `packageId` | ID do pacote |
| Get Appointment Full | `insuranceGuideId` | ID da guia |
| Get Appointment Full | `patientId` | ID do paciente |
| Get Appointment Full | `doctorId` | ID do profissional |
| Get Appointment Full | `lastSessionValue` | Valor da sessão |

### Status
| Endpoint | Variável | Descrição |
|----------|----------|-----------|
| Check Status | `lastOperationalStatus` | Status atual |
| Check Status | `hasSession` | Tem sessão? |
| Check Status | `hasPackage` | Tem pacote? |
| Check Status | `canCancel` | Pode cancelar? |
| Check Status | `canComplete` | Pode completar? |

### Sessão
| Endpoint | Variável | Descrição |
|----------|----------|-----------|
| Get Session | `sessionAppointmentId` | Appointment |
| Get Session | `sessionPackageId` | Package |
| Get Session | `sessionIsPaid` | Está paga? |
| Get Session | `sessionOriginalAmount` | Valor preservado |
| Get Session | `lastSessionStatus` | Status atual |

### Pagamento
| Endpoint | Variável | Descrição |
|----------|----------|-----------|
| Get Payment | `paymentAppointmentId` | Appointment |
| Get Payment | `paymentSessionId` | Session |
| Get Payment | `paymentStatus` | Status |
| Get Payment | `paymentKind` | Tipo |
| Get Payment | `paymentValue` | Valor |

### Operações
| Endpoint | Variável | Descrição |
|----------|----------|-----------|
| Cancel | `lastCancelStatus` | Status do cancel |
| Complete | `lastCompleteStatus` | Status do complete |
| Complete Balance | `lastBalanceComplete` | Usou balance? |
| List | `lastListedAppointmentId` | Primeiro da lista |

---

## 🚀 Fluxos de Teste Completos

### Fluxo 1: Agendamento Particular Completo
```bash
# 1. Cria agendamento particular
POST Create Particular
→ Console: ✅ APPOINTMENT CRIADO: ID: 67e6a1b2...

# 2. Polling até processar (execute várias vezes se necessário)
GET Check Status
→ Console: 📊 operationalStatus: processing_create
→ Console: ⏳ Ainda processando... retry em 2s

# (aguarde 2-3s)

GET Check Status  
→ Console: ✅ Processamento concluído!
→ Console: 📊 operationalStatus: scheduled
→ Console: 🎯 PRÓXIMO PASSO: Execute 'Complete Session'

# 3. Verifica dados completos
GET Get Appointment Full
→ Console: ✅ sessionId salvo: ...
→ Console: ✅ paymentId salvo: ...
→ Console: 📋 RESUMO: Sessão: ✅ Criada, Pagamento: ✅ Criado

# 4. Consulta detalhes da sessão
GET Get Session
→ Console: 💰 isPaid: false
→ Console: 📊 Session status: scheduled

# 5. Completa a sessão
PATCH Complete Session
→ Console: ✅ Completando appointment: 67e6a1b2...
→ Console: ⏳ Complete em processamento...

# 6. Verifica se completou
GET Check Status
→ Console: ✅ Processamento concluído!
→ Console: 📊 operationalStatus: confirmed
```

### Fluxo 2: Cancelamento
```bash
# (Após criar agendamento)

# 1. Cancela
PATCH Cancel Appointment
→ Console: 🚫 Cancelando appointment: 67e6a1b2...
→ Console: ⏳ Cancel em processamento...

# 2. Verifica
GET Check Status
→ Console: 📊 operationalStatus: canceled

# 3. Verifica sessão preservada
GET Get Session
→ Console: 📊 Session status: canceled
→ Console: 💾 Valor original preservado: 200
→ Console: ⚠️  Sessão CANCELADA - pode ser reaproveitada
```

### Fluxo 3: Complete com Balance (Fiado)
```bash
# 1. Cria agendamento particular
POST Create Particular

# 2. Aguarda processar
GET Check Status (até scheduled)

# 3. Obtém valor da sessão
GET Get Appointment Full
→ Console: 💰 Valor salvo: 200

# 4. Completa com fiado
PATCH Complete with Balance
→ Console: 💰 Completando com BALANCE (fiado)
→ Console: 💵 Valor da sessão: 200
→ Console: ⏳ Complete com balance em processamento...
→ Console:    O valor será adicionado ao fiado do paciente
```

---

## 📊 Variáveis para Uso nos Endpoints

### Obrigatórias (configurar no environment)
```
{{baseUrl}}     → http://localhost:5000
{{token}}       → JWT token
{{patientId}}   → ID paciente teste
{{doctorId}}    → ID profissional teste
{{packageId}}   → ID pacote teste (opcional)
```

### Auto-preenchidas (não precisa configurar)
```
{{appointmentId}}           → Último agendamento criado
{{sessionId}}               → Sessão do último agendamento
{{paymentId}}               → Pagamento do último agendamento
{{correlationId}}           → Rastreamento
{{lastOperationalStatus}}   → Status atual
{{canComplete}}             → Se pode completar
{{lastSessionValue}}        → Valor da sessão
```

---

## 🔍 Exemplo de Saída no Console

```
# CREATE PARTICULAR
✅ APPOINTMENT CRIADO:
   ID: 67e6a1b2c3d4e5f6a7b8c9d0
   Status: processing_create
   Correlation: 67e6a1b2...
📋 Próximo: Execute 'Check Status' ou 'Get Appointment Full'

# CHECK STATUS
🔍 Verificando status do appointment: 67e6a1b2...
📊 operationalStatus: scheduled
✅ Processamento concluído!
   Status: scheduled
   Pode Cancelar: true
   Pode Completar: true
🎯 PRÓXIMO PASSO: Execute 'Complete Session'

# GET APPOINTMENT FULL
✅ Usando appointmentId: 67e6a1b2...
✅ sessionId salvo: 67e6a1b2c3d4e5f6a7b8c9d1
✅ paymentId salvo: 67e6a1b2c3d4e5f6a7b8c9d2
✅ patientId salvo: 67e6a1b2...
✅ doctorId salvo: 67e6a1b2...
📊 operationalStatus: scheduled

📋 RESUMO DO AGENDAMENTO:
   ID: 67e6a1b2c3d4e5f6a7b8c9d0
   Status: scheduled
   Sessão: ✅ Criada
   Pagamento: ✅ Criado

# COMPLETE SESSION
✅ Completando appointment: 67e6a1b2...
✅ Pode completar: true
⏳ Complete em processamento...
   Execute 'Check Status' para acompanhar

# ERRO - DEPENDÊNCIA FALTANDO
❌ ERRO: appointmentId não encontrado!
   Execute primeiro: POST Create Particular
   Ou defina manualmente no environment
```

---

## 💡 Dicas

1. **Sempre execute Check Status** antes de Cancel ou Complete para verificar se pode
2. **Aguarde o processamento** - veja o status sair de `processing_*` antes de próxima ação
3. **Use Get Appointment Full** para obter todos os IDs de uma vez (session, payment, etc)
4. **Complete with Balance** precisa do valor - execute Get Appointment Full primeiro
5. **Session cancelada** pode ser reaproveitada - use Create Package Session
