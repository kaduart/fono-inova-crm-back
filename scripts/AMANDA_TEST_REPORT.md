# 🧪 Relatório de Teste - Amanda Orquestrador

## Data: 2026-02-03
## Status: ⛔ NÃO APROVADO PARA PRODUÇÃO

---

## ✅ Comportamentos que FUNCIONAM

| Teste | Status | Observação |
|-------|--------|------------|
| Acolhimento no primeiro contato | ✅ PASSOU | Sempre diz "Oi! Que bom..." |
| Não repetir idade depois de saber | ✅ PASSOU | Contexto está sendo preservado |
| Responder sobre convênio | ✅ PASSOU | Detecta e responde "particular" |
| Contexto preservado em conversa longa | ✅ PASSOU | Não perde dados entre mensagens |

---

## ❌ Comportamentos que ESTÃO QUEBRADOS

### 1. 🔥 FLUXO DE QUALIFICAÇÃO (GRAVE)
**Problema:** Após receber a queixa, Amanda não avança para perguntar idade

**Cenário de teste:**
```
Cliente: "Quero agendar para meu filho"
Amanda:  ✅ "Oi! ... Me conta qual a situação?"

Cliente: "Ele tem dificuldade na fala"  
Amanda:  ❌ "Oi! ... Me conta qual a situação?" (REPETIU!)
         Deveria: "Entendi! Qual a idade?"
```

**Causa provável:**
- `calculateMissing` não está vendo a queixa extraída
- Ou `extractInferredData` não está extraindo a queixa do texto
- Ou `continueCollection` sempre pergunta "situação" sem verificar se já tem

---

### 2. 🔥 RESPOSTA DIRETA - ENDEREÇO (GRAVE)
**Problema:** Quando pergunta endereço, não responde diretamente

**Cenário de teste:**
```
Cliente: "Onde fica a clínica?"
Amanda:  ❌ "Oi! ... Me conta qual a situação?"
         Deveria: "Ficamos na Av. Minas Gerais, 405..."
```

**Causa provável:**
- DecisionEngine não está detectando `asksAddress` como prioridade P2
- Ou `detectDirectQuestion` não retorna 'address'
- Ou flags.asksAddress não está sendo setado

---

### 3. 🔥 DETECÇÃO DE MÚLTIPLAS TERAPIAS (MÉDIO)
**Problema:** Quando lead menciona "fono e psico", não pergunta qual

**Cenário de teste:**
```
Cliente: "Quero agendar fono e psico"
Amanda:  ❌ "Oi! ... Me conta qual a situação?"
         Deveria: "Entendi! É pra qual especialidade: Fono ou Psico?"
```

**Causa provável:**
- `detectAllTherapies` detecta ambas mas Amanda não reage
- `hasMultipleTherapies` não está sendo verificado no DecisionEngine

---

## 🔧 ARQUIVOS QUE PRECISAM DE CORREÇÃO

1. **DecisionEngine.js**
   - `detectDirectQuestion()` - Adicionar mais padrões de endereço
   - `smartResponse()` - Melhorar detecção de flags
   
2. **WhatsAppOrchestrator.js**
   - `calculateMissing()` - Verificar se está vendo dados extraídos
   - `extractInferredData()` - Verificar extração de queixa
   
3. **flagsDetector.js** (se existir)
   - Adicionar `asksAddress` com mais padrões
   
4. **therapyDetector.js**
   - Verificar se `hasMultipleTherapies` está funcionando

---

## 🎯 PRÓXIMOS PASSOS

1. ✅ Corrigir detecção de endereço (PRIORIDADE MÁXIMA)
2. ✅ Corrigir fluxo: queixa → idade → período (PRIORIDADE MÁXIMA)
3. ✅ Corrigir múltiplas terapias (PRIORIDADE MÉDIA)
4. 🧪 Rodar teste novamente
5. 🚀 Subir para produção

---

## 📝 COMANDOS ÚTEIS

```bash
# Rodar teste crítico
cd backend && node scripts/testAmandaCriticalFlows.js

# Ver logs detalhados
cd backend && node scripts/testAmandaCriticalFlows.js 2>&1 | grep -E "(👤|🤖|✅|❌)"
```

---

**Responsável:** Equipe Dev
**Revisão:** Pendente
