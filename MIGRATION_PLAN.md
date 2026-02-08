# Plano de Migração - Consolidando a Amanda

## 🎯 Objetivo
Migrar para o WhatsAppOrchestrator V5 como único ponto de processamento, eliminando código legado sem quebrar a aplicação.

---

## 📊 Status Atual das Dependências

### ✅ ARQUIVOS QUE PODEM SER DELETADOS (sem impacto)
- `DecisionEngine.js` / `DecisionEngine42.js` - Só usado em testes
- `amandaPipeline.js` - Fluxo antigo não usado no V5
- `handlers/index.js` (antigo) - Exporta handlers não usados
- Scripts de teste obsoletos em `/scripts`

### ⚠️ ARQUIVOS QUE PRECISAM DE AJUSTE ANTES DE DELETAR
1. **aiAmandaService.js** - Usado em muitos lugares!
   - `whatsappController.js` (describeWaImage, transcribeWaAudio)
   - `followupController.js` (generateFollowupMessage)
   - `routes/aiAmanda.js` (generateAmandaReply)
   - `routes/webhookHandler.js` (generateAmandaReply)
   - Handlers antigos

2. **handlers/*.js** - TherapyHandler, ProductHandler, etc
   - Importados por handlers/index.js
   - DecisionEngine referencia eles

3. **bookingProductMapper.js**
   - Usado em whatsappController.js
   - Usado em amandaOrchestrator.js

---

## 🚀 PLANO DE EXECUÇÃO

### **PASSO 1: Preparar aiAmandaService.js** ✅ SEGURO
Modificar `aiAmandaService.js` para:
- Usar `WhatsAppOrchestrator` como principal
- Manter `generateFollowupMessage` (ainda útil)
- Manter `describeWaImage` e `transcribeWaAudio` (usados)
- Remover `generateAmandaReply` antigo (delegar para V5)

**Arquivos a modificar:**
- `services/aiAmandaService.js` - Adaptar para usar V5
- `orchestrators/WhatsAppOrchestrator.js` - Adicionar métodos auxiliares se necessário

### **PASSO 2: Migrar funções úteis para o V5**
Do `utils/amandaOrchestrator.js` antigo:
- `safeLeadUpdate` - Helper útil
- `buildTriageSchedulingMessage` - Mensagens de triagem
- `mapComplaintToTherapyArea` - Mapeamento

Do `utils/responseBuilder.js`:
- `buildTherapyResponse` - Respostas com valor
- `buildMultiTherapyResponse` - Múltiplas terapias

Do `services/intelligence/naturalResponseBuilder.js`:
- `buildResponse` - Templates de acolhimento
- `QUESTION_TEMPLATES` - Variações de perguntas

### **PASSO 3: Criar compatibilidade para Handlers**
Criar stubs simples para handlers antigos que:
- Logam que foram chamados
- Delegam para WhatsAppOrchestrator
- Não quebram imports existentes

### **PASSO 4: Deletar arquivos mortos**
Depois de confirmar que nada quebra:
- `DecisionEngine.js`
- `DecisionEngine42.js`
- `amandaPipeline.js`
- `handlers/ProductHandler.js`
- `handlers/TherapyHandler.js`
- `handlers/FallbackHandler.js`
- `handlers/LeadQualificationHandler.js`
- Scripts de teste antigos
- Arquivos duplicados

### **PASSO 5: Limpar imports e testar**
- Verificar todos os imports
- Rodar testes
- Testar fluxo completo

---

## 📝 CHECKLIST DE SEGURANÇA

Antes de cada passo:
- [ ] Fazer backup do arquivo
- [ ] Verificar todos os imports que usam o arquivo
- [ ] Testar localmente
- [ ] Verificar logs por erros

Depois de cada passo:
- [ ] Testar fluxo de conversa
- [ ] Testar agendamento
- [ ] Testar followup
- [ ] Verificar se não há erros no console

---

## 🎲 ROLLBACK
Se algo quebrar:
1. Reverter último commit
2. Restaurar arquivos de backup
3. Verificar logs de erro
4. Ajustar e tentar novamente
