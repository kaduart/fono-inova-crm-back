# ⚠️ GAPS IDENTIFICADOS - Análise Pós-Implementação

## GAPS P0 (Críticos - Falta Implementar)

### 1. Fora de Horário → Salvar Estado (P12)
**Status:** ❌ NÃO IMPLEMENTADO
**Onde:** WhatsAppOrchestrator.js
**Problema:** Quando lead envia msg às 22h, Amanda responde "horário comercial". Na manhã seguinte, reinicia com "Como posso ajudar?" em vez de retomar a conversa.
**Solução:** Salvar `pendingQuestion` no contextMemory e retomar às 8h.

### 2. Limite de Ofertas de Agendamento (REGRA 6)
**Status:** ❌ NÃO IMPLEMENTADO
**Onde:** DecisionEngine.js
**Problema:** Amanda oferece agendamento múltiplas vezes na mesma conversa (parece "vendedora chata").
**Solução:** Rastrear `bookingOffersCount` no chatContext. Máximo 1 por conversa.

### 3. Micro Follow-up 50min (P3)
**Status:** ❌ NÃO IMPLEMENTADO
**Onde:** Novo scheduler ou smartFollowup.js
**Problema:** Viviane manda msg após 50min sem resposta. Amanda não faz nada.
**Solução:** Job BullMQ com delay 50min para leads ativos.

## GAPS P1 (Importantes - Falta Implementar)

### 4. Convite Físico à Clínica (P1)
**Status:** ⚠️ PARCIAL (só mencionado no smartFollowup.js)
**Onde:** DecisionEngine.js → smartResponse()
**Problema:** Amanda nunca convida lead para conhecer o espaço fisicamente.
**Solução:** Oferecer visita presencial quando lead demonstrar interesse mas hesitar no preço.

### 5. Follow-up Pós-Avaliação 7 dias (REGRA 8)
**Status:** ❌ NÃO IMPLEMENTADO
**Onde:** Novo worker ou followup.cron.js
**Problema:** Lead faz avaliação mas não retorna. Amanda não faz follow-up.
**Solução:** Detectar avaliação realizada sem continuidade → follow-up 7 dias.

### 6. Desconto Multi-Criança Automático (P5)
**Status:** ❌ NÃO IMPLEMENTADO
**Onde:** DecisionEngine.js ou BookingHandler.js
**Problema:** Amanda não detecta múltiplas crianças e oferece desconto.
**Solução:** Regex para detectar "dois filhos", "irmãos", etc. + oferta automática.

## GAPS P2 (Melhorias)

### 7. Flexibilidade de Horário com Empatia (P6)
**Status:** ⚠️ PARCIAL
**Onde:** BookingHandler.js
**Problema:** Amanda oferece horários sem contextualizar por que é bom para o lead.
**Solução:** Adicionar justificativa: "07h é pensado para não atrapalhar trabalho".

### 8. Reagendamento com Carinho (P7)
**Status:** ⚠️ PARCIAL
**Onde:** Existente mas genérico
**Problema:** Resposta protocolar quando lead cancela.
**Solução:** Mensagem mais acolhedora: "Sem problemas, rotina é corrida mesmo!".

## ✅ O QUE JÁ FOI IMPLEMENTADO (Correto)

- ✅ Warm Lead Detection ("vou pensar")
- ✅ Value-before-price (F2)
- ✅ Insurance Bridge (F3)
- ✅ Urgency Prioritization (F7)
- ✅ Seamless Handover (F4)
- ✅ Smart Repetition (F5)
- ✅ Emotional Support (F6)
- ✅ Contextual Memory (F1)
- ✅ Encerramento sem "Disponha"
- ✅ Tracking/Analytics
- ✅ Testes E2E

## 📊 PRIORIDADE DE IMPLEMENTAÇÃO

1. **P0:** Fora de horário + Limite ofertas (impacto alto, esforço médio)
2. **P0:** Micro follow-up 50min (impacto médio, esforço baixo)
3. **P1:** Follow-up pós-avaliação (impacto alto, esforço médio)
4. **P1:** Convite físico + Multi-criança (impacto médio, esforço baixo)
