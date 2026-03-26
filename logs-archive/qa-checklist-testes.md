# 📋 Checklist de QA - Testes End-to-End
## Ajustes Implementados (Kimi)

---

## 🔹 Teste 1: Upsert de Lead Único

### Objetivo
Garantir que não há duplicação de leads ou logs.

### Comandos MongoDB
```javascript
// Antes do teste - limpar
use crm;
db.leads.deleteMany({"contact.phone": "+5511999999001"});
db.raw_webhook_logs.deleteMany({"body.entry.changes.value.messages.from": "5511999999001"});

// Durante o teste - monitorar
db.leads.find({"contact.phone": "+5511999999001"}).count()
db.raw_webhook_logs.find({"body.entry.changes.value.messages.from": "5511999999001"}).count()
```

### Procedimento
1. Envie 2 mensagens iguais em < 5s via WhatsApp para o número de teste
2. Mensagem: `"Oi, quero agendar para meu filho"`

### Validação ✅
```javascript
// Deve retornar EXATAMENTE 1
db.leads.find({"contact.phone": "+5511999999001"}).count() // 1

// Deve retornar 1 ou 2 (dependendo se o middleware e controller logam separado)
db.raw_webhook_logs.find({"body.entry.changes.value.messages.from": "5511999999001"}).count() // 1-2
```

### Logs Esperados
```
🛡️ GUARD: Lead capturado +5511999999001   (apenas 1x - no middleware)
```

---

## 🔹 Teste 2: Triagem Pós-Refresh

### Objetivo
`isTriageComplete()` deve usar dados atualizados do banco.

### Setup
```javascript
// Criar lead incompleto
use crm;
db.leads.insertOne({
  contact: { phone: "+5511999999002" },
  therapyArea: "fonoaudiologia",
  patientInfo: {},  // sem nome/idade
  status: "novo",
  createdAt: new Date()
});
```

### Procedimento
1. Envie mensagem: `"Quero agendar amanhã de manhã"`

### Validação via Logs ✅
```
// ORDEM CORRETA (ajuste implementado):
🔄 [REFRESH] Lead atualizado: { therapyArea: "fonoaudiologia", patientInfoName: null, ... }
// <-- ANTI-LOOP vem DEPOIS do refresh

// ORDEM ERRADA (antes do ajuste):
🛡️ [ANTI-LOOP] Triagem completa detectada no início - pulando para slots  
🔄 [REFRESH] Lead atualizado: ...
```

### Resultado Esperado
- **NÃO** deve pular direto para slots
- Amanda deve perguntar: `"Qual o nome e idade do paciente?"`

---

## 🔹 Teste 3: TraceId nos Logs

### Objetivo
Rastreabilidade end-to-end via `wamid` ou `leadId`.

### Procedimento
1. Envie mensagem: `"Quero saber sobre fonoaudiologia"`
2. Anote o `wamid` retornado no webhook

### Validação via Logs ✅
```
// No início do fluxo:
🔄 Processando mensagem: { from: "5511999999003", type: "text", wamid: "wamid.HBgNNTUxMTk5OTk5OTAwMxUCABEYEjE1QkZERjZERjZERjZERjY=", traceId: "wamid.HBgNNTUxMTk5OTk5OTAwMxUCABEYEjE1QkZERjZERjZERjZERjY=" }

// No handleAutoReply:
🤖 [AUTO-REPLY] Iniciando para { from: "5511999999003", to: "...", leadId: "507f1f77bcf86cd799439011", traceId: "507f1f77bcf86cd799439011", content: "Quer..." }

// Durante o processamento:
⏭️ [507f1f77bcf86cd799439011] AI lock ativo; evitando corrida ai:lock:5511999999003
📝 [507f1f77bcf86cd799439011] Mensagem guardada para processar depois: Quero saber...
```

### Validação Redis
```bash
redis-cli KEYS "ai:lock:*"
redis-cli TTL "ai:lock:5511999999003"  # deve retornar ~30
```

---

## 🔹 Teste 4: Tom do Pipeline de Descoberta (Zeus)

### Objetivo
Mensagem com tom acolhedor, sem drama exagerado.

### Setup
```javascript
// Criar lead em estágio de descoberta
use crm;
db.leads.insertOne({
  contact: { phone: "+5511999999004" },
  stage: "descoberta",
  jornadaEstagio: "descoberta",
  origin: "lp_fono",
  status: "novo",
  createdAt: new Date()
});
```

### Procedimento
1. Envie mensagem: `"Meu filho de 3 anos ainda não fala direito, isso é normal?"`

### Validação da Resposta ✅
| Critério | Esperado | Proibido |
|----------|----------|----------|
| Tom | Acolhedor, natural | Alarmista, urgente |
| Cenário | Cotidiano, observacional | Drama, exagerado |
| Abertura | `"Muitos pais se perguntam..."` | `"ALERTA: Seu filho pode ter..."` |
| CTA | Suave, convidativo | Agressivo, forçado |

### Exemplo de Resposta CORRETA ✅
```
Oi! Muitos pais se perguntam sobre isso aos 3 anos 💚

Cada criança tem seu ritmo, mas às vezes uma pequena dificuldade na fala pode ser o sinal de que um empurrãozinho profissional faz toda a diferença.

Me conta: você já notou se ele entende bem o que falam, mas tem dificuldade pra responder?
```

### Exemplo de Resposta ERRADA ❌
```
🚨 URGENTE! Atraso na fala aos 3 anos é muito grave!

Seu filho PODE TER um problema sério que precisa de intervenção IMEDIATA! Não perca tempo!

AGENDE AGORA ou pode ser tarde demais!!!
```

---

## 🔹 Teste 5: Locks e Debounce Consolidado

### Objetivo
Apenas 1 resposta por lote de mensagens rápidas.

### Procedimento
1. Envie 3 mensagens em < 3 segundos:
   - `"Oi"`
   - `"Quero agendar"` 
   - `"Para fonoaudiologia"`

### Validação via Redis ✅
```bash
# Durante o processamento:
redis-cli GET "ai:lock:5511999999005"  # deve retornar "1"
redis-cli TTL "ai:lock:5511999999005"  # ~25-30s

# Mensagens pendentes:
redis-cli GET "ai:pending:5511999999005"  # deve conter as 3 mensagens agregadas
```

### Validação via Logs ✅
```
🤖 [AUTO-REPLY] Iniciando para { from: "5511999999005", ... }
📥 Mensagens pendentes agregadas: 2  // mensagens 2 e 3 acumuladas
🔄 Processando conteúdo agregado: "Oi\nQuero agendar\nPara fonoaudiologia"
```

### Resultado Esperado
- Apenas **1 resposta** da Amanda
- Conteúdo processado: agregação das 3 mensagens
- No MongoDB: apenas 1 mensagem de saída (outbound)

---

## 🔹 Teste 6: Fluxo End-to-End Completo

### Cenário
Lead novo → Triagem completa → Slots → Confirmação

### Passo a Passo

| # | Ação | Mensagem Enviada | Validação |
|---|------|------------------|-----------|
| 1 | Lead envia | `"Oi, quero agendar fonoaudiologia"` | Lead criado, traceId presente |
| 2 | Amanda responde | Pergunta nome/idade | Tom acolhedor |
| 3 | Lead responde | `"João, 5 anos"` | Dados extraídos |
| 4 | Amanda responde | Pergunta queixa | Contexto mantido |
| 5 | Lead responde | `"Ele troca R por L"` | Complaint salva |
| 6 | Amanda responde | Pergunta período | - |
| 7 | Lead responde | `"Manhã"` | pendingPreferredPeriod salvo |
| 8 | Amanda responde | **Slots disponíveis** | Apenas após triagem completa |
| 9 | Lead escolhe | `"A segunda opção"` | Slot confirmado |
| 10 | Amanda confirma | `"Agendado para..."` | Mensagem final |

### Validação Final ✅
```javascript
use crm;
const lead = db.leads.findOne({"contact.phone": "+5511999999006"});

// Campos preenchidos:
lead.therapyArea              // "fonoaudiologia"
lead.patientInfo.fullName     // "João"
lead.patientInfo.age          // 5
lead.complaint                // "troca R por L"
lead.pendingPreferredPeriod   // "manha"
lead.triageStep               // "done"
lead.status                   // "engajado"
```

### Logs de Sucesso
```
🔄 Processando mensagem: { ..., traceId: "wamid.HBg...", wamid: "wamid.HBg..." }
🤖 [AUTO-REPLY] Iniciando para { ..., traceId: "507f..." }
🔄 [REFRESH] Lead atualizado: { therapyArea: "fonoaudiologia", patientInfoName: "João", ... }
// (não deve aparecer ANTI-LOOP aqui ainda - dados incompletos)
...
🛡️ [ANTI-LOOP] Triagem completa detectada - pulando para slots  // apenas no final
```

---

## 🚀 Comandos Rápidos de Teste

### Limpar Ambiente
```bash
# MongoDB
mongo crm --eval 'db.leads.deleteMany({"contact.phone": {$regex: "^\\+5511999999"}})'
mongo crm --eval 'db.messages.deleteMany({"from": {$regex: "^5511999999"}})'
redis-cli --raw KEYS "ai:*5511999999*" | xargs redis-cli DEL
```

### Monitorar em Tempo Real
```bash
# Terminal 1 - Logs da aplicação
pm2 logs crm-api | grep -E "(traceId|REFRESH|ANTI-LOOP|Lead capturado|AUTO-REPLY)"

# Terminal 2 - Redis
redis-cli monitor | grep -E "(ai:lock|ai:pending|ai:debounce)"

# Terminal 3 - MongoDB (novos leads)
mongo crm --eval 'db.leads.watch([{$match: {"fullDocument.contact.phone": {$regex: "^\\+5511999999"}}}]).hasNext()' --shell
```

### Simular Webhook (curl)
```bash
# Substitua URL e token
WEBHOOK_URL="https://sua-api.com/api/whatsapp/webhook"
PHONE="5511999999007"

curl -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "id": "test",
      "changes": [{
        "value": {
          "messaging_product": "whatsapp",
          "metadata": {"display_phone_number": "5562988888888"},
          "messages": [{
            "from": "'"$PHONE"'",
            "id": "wamid.test.'$(date +%s)'",
            "timestamp": "'$(date +%s)'",
            "type": "text",
            "text": {"body": "Oi, quero agendar"}
          }]
        },
        "field": "messages"
      }]
    }]
  }'
```

---

## ✅ Checklist Final

- [ ] Teste 1: Lead não duplicado
- [ ] Teste 2: Refresh antes do isTriageComplete
- [ ] Teste 3: TraceId presente em todos os logs
- [ ] Teste 4: Tom acolhedor na resposta
- [ ] Teste 5: Apenas 1 resposta para mensagens rápidas
- [ ] Teste 6: Fluxo completo funciona end-to-end

**Status:** ___/6 testes passaram

**Data do Teste:** ___/___/___
**Testador:** ________________
