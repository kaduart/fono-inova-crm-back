# 🧠 WhatsApp Orchestrator V7 - Response-First Architecture

## 🎯 Filosofia Central

A arquitetura V7 inverte a lógica tradicional de chatbots de **"slot-first"** para **"response-first"**.

### ❌ Antes (Slot-First):
```
1. Descobrir qual slot está faltando
2. Perguntar esse slot
3. (Se sobrar tempo) Responder o lead
```

**Resultado:** Bot parece formulário falante, ignora perguntas, repete perguntas.

### ✅ Agora (Response-First):
```
1. O que o lead PERGUNTOU?
2. RESPONDE tudo (sempre!)
3. ACOLHE o que ele DEU
4. (Só então) Pergunta 1 coisa
```

**Resultado:** Bot parece secretária experiente, nunca ignora, nunca repete, converte melhor.

---

## 🏗️ Arquitetura

### Fluxo de Processamento

```
┌─────────────────────────────────────────────────────┐
│  📥 Lead: "Quanto custa? Meu filho tem 5 anos"     │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│  1️⃣ DETECÇÃO PARALELA                               │
│     ├─ extractQuestions() → ["quanto custa?"]      │
│     ├─ extractEntities() → { age: 5 }              │
│     └─ detectAllFlags() → { asksPrice: true }      │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│  2️⃣ CONSTRUIR RESPOSTA (ordem importa!)             │
│                                                      │
│  2.1 RESPONDER PERGUNTAS (prioridade máxima)        │
│      → answerQuestions()                            │
│      → usa LLM + Knowledge Base                     │
│      ✅ "A avaliação é R$ 200! ..."                 │
│                                                      │
│  2.2 ACOLHER DADOS NOVOS                            │
│      → acknowledgeData()                            │
│      ✅ "Vi que ele tem 5 aninhos! 🥰"              │
│                                                      │
│  2.3 PERGUNTAR 1 COISA (só se necessário)          │
│      → decideNextQuestion()                         │
│      ✅ "E o nome do pequeno?"                      │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│  📤 Resposta Final:                                 │
│  "A avaliação é R$ 200! 💚                          │
│   Vi que ele tem 5 aninhos! 🥰                      │
│   E o nome do pequeno?"                             │
└─────────────────────────────────────────────────────┘
```

---

## 📚 Componentes Principais

### 1. `extractQuestions(text)`
**Função:** Detecta perguntas na mensagem do lead

**Não tenta mapear todas as perguntas possíveis** - usa **5 categorias amplas**:
- `pricing`: "quanto custa?"
- `insurance`: "aceita plano?"
- `services`: "vocês fazem X?"
- `documentation`: "precisa de laudo?"
- `schedule`: "qual horário?"

**Por quê categorias amplas?**
- Escalável: não precisa cadastrar 100+ intenções
- LLM responde o resto: categorização + knowledge base = resposta precisa

### 2. `answerQuestions(questions, context)`
**Função:** Responde TODAS as perguntas usando LLM + Knowledge Base

**Processo:**
1. Busca conhecimento relevante (`getRelevantKnowledge`)
2. Injeta no prompt do LLM
3. LLM responde naturalmente
4. **NUNCA inventa** - só usa o que está na KB

### 3. `acknowledgeData(newData, entities)`
**Função:** Acolhe dados que o lead forneceu

**Exemplos:**
- Nome → "Que nome lindo, João! 🥰"
- Idade (5 anos) → "5 aninhos é uma fase tão especial!"
- Queixa → "Entendi a situação. Vamos ajudar!"

**Humaniza** a conversa, mostra que está prestando atenção.

### 4. `decideNextQuestion(context, entities, flags)`
**Função:** Decide próxima pergunta (só 1, contextual)

**Priorização inteligente:**
1. Se não sabe o problema → pergunta primeiro
2. Se tem queixa mas não especialidade → **faz triagem**
3. Idade (importante para matching)
4. Nome (menos invasivo)
5. Período (por último)

**Triagem automática:**
- "não fala" → fonoaudiologia
- "hiperativo" → psicologia
- "dor coluna" → fisioterapia

### 5. `performSimpleTriage(complaint, flags)`
**Função:** Triagem multidisciplinar automática

**Mapeia 15+ sintomas principais** para especialidades:
- Fono: atraso fala, troca letras, gagueira
- Psico: ansiedade, TDAH, birra
- Fisio: dor, atraso motor
- TO: coordenação, seletividade alimentar

**Evita** perguntar "qual especialidade?" quando já dá pra inferir.

---

## 🔧 Integração

### Como o V7 é Usado

```javascript
// aiAmandaService.js

export async function generateAmandaReply({ userText, lead, context }) {
    // 1. Tenta LLM primeiro (camada principal)
    try {
        const aiResponse = await callAI({ ... });
        if (aiResponse) return aiResponse;
    } catch (err) {
        // LLM falhou
    }

    // 2. Fallback: V7 Orchestrator (Response-First)
    const result = await orchestratorV7.process({ lead, message, context });
    return result.payload.text;
}
```

**Camadas de fallback:**
1. LLM (camada principal - natural, adaptável)
2. **V7 Orchestrator (Response-First)** ⬅️ NOVO!
3. V6 Orchestrator (legado - slot-first)
4. OpenAI direto
5. Mensagem padrão

---

## 📊 Comparação: V6 vs V7

### Cenário: Lead com Perguntas

**Entrada:**
```
"Quanto custa e aceita plano? Meu filho João tem 5 anos"
```

#### ❌ V6 (Slot-First):
```
1. Detecta: age=5, patientName="João"
2. Missing: therapy, period
3. Resposta:
   "R$ 200! Aceitamos reembolso 💚

    Qual especialidade você procura?"
```

**Problemas:**
- ✅ Respondeu perguntas (ok)
- ❌ Ignorou que já tem nome e idade
- ❌ Perguntou especialidade (óbvio que não sabe ainda)

#### ✅ V7 (Response-First):
```
1. Questions: ["quanto custa?", "aceita plano?"]
2. Entities: { age: 5, patientName: "João" }
3. NewData: ["age", "patientName"]
4. Resposta:
   "A avaliação é R$ 200! E sim, trabalhamos com
    reembolso de todos os planos 💚

    O João tem 5 aninhos, que fase linda! 🥰

    Me conta: o que vocês estão notando com ele?
    É questão de fala, comportamento, ou outra coisa?"
```

**Melhorias:**
- ✅ Respondeu AMBAS perguntas
- ✅ Acolheu nome e idade
- ✅ Pergunta aberta (não "qual especialidade?")
- ✅ Tom natural, não robótico

---

## 🧪 Testando

### Teste Manual Rápido

```bash
# No terminal
cd backend
node
```

```javascript
// No REPL do Node
import { WhatsAppOrchestrator } from './orchestrators/WhatsAppOrchestrator.js';

const orch = new WhatsAppOrchestrator();

const lead = { _id: 'test123' };
const message = { content: 'Quanto custa? Aceita plano?' };
const context = {};

const result = await orch.process({ lead, message, context });
console.log(result.payload.text);
```

### Casos de Teste Importantes

1. **Múltiplas perguntas**
   - Input: "Quanto custa? Aceita plano? Onde fica?"
   - Esperado: Responde as 3, não pergunta nada

2. **Dados + pergunta**
   - Input: "João, 5 anos, quanto custa?"
   - Esperado: Responde preço + acolhe nome/idade

3. **Triagem automática**
   - Input: "Meu filho não fala"
   - Esperado: Sugere fonoaudiologia (não pergunta especialidade)

4. **Evitar repetição**
   - Input 1: "Quanto custa?"
   - Input 2: "E aceita plano?"
   - Esperado: Nunca repete a mesma pergunta

---

## 🔑 Regras de Ouro

1. **NUNCA perguntar antes de responder**
   - Se lead perguntou, SEMPRE responde primeiro

2. **NUNCA repetir pergunta**
   - Se lead não respondeu, varia ou pula

3. **NUNCA parecer formulário**
   - Acolhimento > coleta de dados

4. **SEMPRE usar Knowledge Base**
   - LLM NUNCA inventa - só usa KB

5. **SEMPRE fazer triagem quando possível**
   - Não perguntar "qual especialidade?" se dá pra inferir

---

## 📝 Próximos Passos

### Melhorias Futuras (Opcional)

1. **RAG (Vector Search)**
   - Quando tiver 200+ documentos de conhecimento
   - Permite buscar informações por similaridade semântica

2. **Máquina de Estados Emocional**
   - Ventilação → Clareamento → Educação → Proposta → Agendamento
   - Mais sofisticado, mas também mais complexo

3. **A/B Testing**
   - Comparar V7 vs V6 com leads reais
   - Métricas: taxa de agendamento, NPS, tempo médio

### Manutenção

- **Atualizar Knowledge Base** quando preços/serviços mudarem
- **Adicionar novos métodos** em `CLINIC_KNOWLEDGE.methods`
- **Expandir triagem** com novos sintomas em `performSimpleTriage`

---

## 🆘 Troubleshooting

### "Bot ainda repete perguntas"

**Causa:** LLM pode repetir se histórico estiver vazio

**Solução:** Verificar se `loadConversationHistory` está funcionando

### "Bot não responde perguntas"

**Causa:** `extractQuestions` não detectou

**Solução:** Adicionar padrão em `extractQuestions()` ou revisar regex

### "Bot inventa informações"

**Causa:** Knowledge Base não tem a info → LLM inventa

**Solução:** Adicionar em `CLINIC_KNOWLEDGE` ou melhorar prompt

### "Triagem errada"

**Causa:** Sintoma não mapeado em `performSimpleTriage`

**Solução:** Adicionar sintoma no `symptomMap`

---

## 📞 Suporte

Dúvidas sobre a arquitetura V7?

- Ver código: `backend/orchestrators/WhatsAppOrchestrator.js`
- Ver KB: `backend/knowledge/clinicKnowledge.js`
- Ver integração: `backend/services/aiAmandaService.js`

---

**Última atualização:** 2025-01-08 (Implementação inicial V7)
