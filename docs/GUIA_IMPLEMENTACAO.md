# 🛠️ Guia de Implementação - Humanização da Amanda

Este guia descreve como implementar as melhorias de humanização na Amanda.

---

## 📁 Arquivos Criados

1. **`utils/greetingEngine.js`** - Motor de saudações inteligentes
2. **`middleware/humanizationMiddleware.js`** - Middleware de humanização
3. **`utils/emotionalDetector.js`** - Detector avançado de emoções
4. **`docs/EXEMPLOS_MENSAGENS_HUMANIZADAS.md`** - Exemplos para treinamento

---

## 🚀 Passo 1: Integrar o Greeting Engine

### Arquivo: `utils/amandaOrchestrator.js`

#### 1.1 Adicionar import
```javascript
// No topo do arquivo, após os imports existentes
import { 
    generateSmartGreeting, 
    generateOpeningQuestion,
    determineInteractionType,
    extractFirstName 
} from './greetingEngine.js';
```

#### 1.2 Substituir a função `tryManualResponse` para saudações

Localize a função `tryManualResponse` (aproximadamente linha 2455) e substitua o bloco de saudação:

```javascript
// 👋 SAUDAÇÃO PURA - VERSÃO HUMANIZADA
if (PURE_GREETING_REGEX.test(normalizedText)) {
    const context = {
        isFirstContact: context.isFirstContact,
        hoursSinceLastMessage: context.hoursSinceLastMessage || 0,
        messageCount: context.messageCount || 0,
        userName: extractFirstName(lead?.name),
        userText: text,
        hourOfDay: new Date().getHours(),
    };
    
    // Usar o novo greeting engine
    return generateSmartGreeting(context);
}
```

---

## 🚀 Passo 2: Integrar o Detector Emocional

### Arquivo: `utils/amandaOrchestrator.js`

#### 2.1 Adicionar import
```javascript
import { analyzeEmotionalState } from './emotionalDetector.js';
```

#### 2.2 No início de `getOptimizedAmandaResponse`, adicionar:

```javascript
export async function getOptimizedAmandaResponse({
    content,
    userText,
    lead = {},
    context = {},
    messageId = null,
}) {
    const text = userText || content || "";
    
    // 🎭 ANÁLISE EMOCIONAL - Nova camada de humanização
    const emotionalAnalysis = analyzeEmotionalState(text);
    
    // Adicionar ao contexto enriquecido
    context.emotionalState = emotionalAnalysis.primary;
    context.emotionalAnalysis = emotionalAnalysis;
    
    // Se for crise, priorizar atendimento humano
    if (emotionalAnalysis.isCrisis) {
        return ensureSingleHeart(
            "Você não está sozinho. Estou chamando nossa equipe URGENTE. " +
            "Se estiver em risco agora, ligue 192 imediatamente, tá? 🤗"
        );
    }
    
    // ... resto do código
}
```

---

## 🚀 Passo 3: Integrar o Middleware de Humanização

### Arquivo: `utils/amandaOrchestrator.js`

#### 3.1 Adicionar import
```javascript
import { humanizeResponse } from '../middleware/humanizationMiddleware.js';
```

#### 3.2 No final da função `getOptimizedAmandaResponse`, antes dos returns:

```javascript
// 🎭 HUMANIZAÇÃO FINAL - Aplicar antes de retornar
const applyHumanization = (response) => {
    if (!response || typeof response !== 'string') return response;
    
    const humanized = humanizeResponse(response, {
        emotionalState: context.emotionalState || 'calmo',
    });
    
    return humanized;
};
```

#### 3.3 Modificar todos os `return ensureSingleHeart(...)` para:

```javascript
// Antes:
return ensureSingleHeart("Resposta aqui...");

// Depois:
return applyHumanization(ensureSingleHeart("Resposta aqui..."));
```

---

## 🚀 Passo 4: Atualizar o AmandaPrompt

### Arquivo: `utils/amandaPrompt.js`

#### 4.1 Modificar `MANUAL_AMANDA.saudacao`:

```javascript
"saudacao": "Oi! Sou a Amanda da Fono Inova. 😊",
```

**Nota:** A saudação completa agora é gerada pelo `greetingEngine.js`

#### 4.2 Simplificar o `SYSTEM_PROMPT_AMANDA`:

Localize e substitua:
```javascript
// ❌ DE:
"Você NÃO é recepcionista. Você é uma PRÉ-CONSULTORA ESTRATÉGICA."

// ✅ PARA:
"Você é a Amanda, recepcionista da Fono Inova. Fale como uma pessoa real, não como assistente."
```

#### 4.3 Adicionar instrução de humanização:

```javascript
REGRAS DE HUMANIZAÇÃO:
- NUNCA diga "pré-consultora estratégica"
- NUNCA termine com "aguardo retorno"
- Use "me conta", "deve estar difícil", "respira"
- Máximo 2 blocos curtos (estilo WhatsApp)
- 1 pergunta por vez
- Varie os emojis, não use sempre 💚
```

---

## 🚀 Passo 5: Configurar Variáveis de Ambiente

### Arquivo: `.env`

```bash
# Ativar modo de desenvolvimento para logs de humanização
NODE_ENV=development

# Ativar/desativar humanização
ENABLE_HUMANIZATION=true

# Ativar logs de emotional detection
LOG_EMOTIONAL_STATE=true
```

---

## 🧪 Testes

### Teste 1: Saudação por horário
```bash
curl -X POST http://localhost:3000/api/amanda/reply \
  -H "Content-Type: application/json" \
  -d '{
    "userText": "oi",
    "lead": {"name": "Maria"},
    "context": {"isFirstContact": true, "messageCount": 1}
  }'
```

**Esperado:** Saudação "Bom dia!", "Boa tarde!" ou "Boa noite!" conforme horário

### Teste 2: Detecção de emoção
```bash
curl -X POST http://localhost:3000/api/amanda/reply \
  -H "Content-Type: application/json" \
  -d '{
    "userText": "Meu filho não fala e eu tô desesperada",
    "lead": {"name": "Ana"},
    "context": {"isFirstContact": true}
  }'
```

**Esperado:** Resposta começando com "Respira comigo..." ou similar

### Teste 3: Continuação de conversa
```bash
curl -X POST http://localhost:3000/api/amanda/reply \
  -H "Content-Type: application/json" \
  -d '{
    "userText": "Ele entende sim",
    "lead": {"name": "Ana"},
    "context": {"isFirstContact": false, "hoursSinceLastMessage": 2}
  }'
```

**Esperado:** Sem saudação "Oi!", continuação fluída

---

## 📊 Monitoramento

### Métricas a acompanhar:

1. **Taxa de saudação genérica** → Deve diminuir de 100% para < 20%
2. **Respostas > 140 caracteres** → Deve diminuir
3. **Tempo médio de resposta** → Deve se manter ou melhorar
4. **Taxa de conversão** → Meta: +10%
5. **Satisfação do usuário (NPS)** → Meta: +20 pontos

### Logs a observar:

```javascript
// No console deve aparecer:
[EmotionalDetector] Estado: ansioso | Score: 8
[GreetingEngine] Tipo: first_contact | Emoção: ansioso
[Humanization] Resposta validada: true
```

---

## 🔧 Troubleshooting

### Problema: Saída ainda robótica

**Causa provável:** O `SYSTEM_PROMPT_AMANDA` ainda tem instruções corporativas

**Solução:** Revisar e simplificar o prompt conforme Passo 4

---

### Problema: Emojis não variam

**Causa provável:** `ensureSingleHeart` está sendo chamado depois de `humanizeResponse`

**Solução:** Ordem correta:
```javascript
const humanized = humanizeResponse(response, context);
return ensureSingleHeart(humanized); // Se necessário
```

---

### Problema: Detecção emocional não funciona

**Causa provável:** Texto não corresponde aos padrões

**Solução:** Adicionar mais padrões em `emotionalDetector.js`:
```javascript
ansioso: {
    patterns: [
        // Adicionar novos padrões aqui
        /novo padrão/i,
    ]
}
```

---

## 📅 Cronograma Sugerido

| Semana | Tarefa | Responsável |
|--------|--------|-------------|
| 1 | Integrar `greetingEngine.js` | Dev Backend |
| 1 | Testar saudações por horário | QA |
| 2 | Integrar `emotionalDetector.js` | Dev Backend |
| 2 | Testar detecção de emoções | QA |
| 3 | Integrar `humanizationMiddleware.js` | Dev Backend |
| 3 | Testar remoção de padrões robóticos | QA |
| 4 | Simplificar `SYSTEM_PROMPT_AMANDA` | Dev Backend |
| 4 | Testes finais e ajustes | QA |
| 5 | Deploy em produção | DevOps |
| 6 | Coletar métricas e feedback | Produto |

---

## ✅ Checklist de Deploy

- [ ] Todos os imports adicionados
- [ ] Nenhum erro de sintaxe
- [ ] Testes unitários passando
- [ ] Testes de integração passando
- [ ] Logs configurados
- [ ] Métricas configuradas
- [ ] Rollback planejado
- [ ] Time de suporte notificado

---

**Documento criado em:** 2026-02-01  
**Versão:** 1.0  
**Status:** Pronto para implementação
