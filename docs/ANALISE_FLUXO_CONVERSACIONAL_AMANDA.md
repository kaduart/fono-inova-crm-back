# 🔍 ANÁLISE COMPLETA DO FLUXO CONVERSACIONAL DA AMANDA

## 📋 RESUMO EXECUTIVO

A Amanda (bot de atendimento WhatsApp da Fono Inova) possui uma **arquitetura tecnicamente robusta** mas com **problemas graves de humanização**. O atendimento soa robótico devido a falhas na implementação das regras de saudação, excesso de formalidade corporativa e falta de adaptação emocional contextual.

---

## 🗺️ MAPEAMENTO DO FLUXO ATUAL

### 1. FLUXO DE ENTRADA DE MENSAGEM

```
WhatsApp Message
    ↓
whatsappController.js (receiveMessage)
    ↓
Tratamento de mídia (áudio/imagem/texto)
    ↓
Criação/Atualização do Lead
    ↓
Salvar mensagem no Message
    ↓
enrichLeadContext() → Contexto enriquecido
    ↓
getOptimizedAmandaResponse() [ORQUESTRADOR]
    ↓
Resposta gerada → Envio WhatsApp
```

### 2. COMPONENTES PRINCIPAIS

| Componente | Arquivo | Responsabilidade |
|------------|---------|------------------|
| **Orquestrador Principal** | `amandaOrchestrator.js` | Roteamento inteligente, fluxos de agendamento, detecção de intenções |
| **Prompt Builder** | `amandaPrompt.js` | Construção do SYSTEM_PROMPT e módulos dinâmicos |
| **Flags Detector** | `flagsDetector.js` | Extração de flags da mensagem do usuário |
| **Context Builder** | `leadContext.js` + `ContextPack.js` | Enriquecimento de contexto do lead |
| **Response Builder** | `responseBuilder.js` | Montagem de respostas baseadas em terapias |
| **AI Service** | `aiAmandaService.js` | Interface com APIs de IA (Claude/OpenAI) |

### 3. COMO A PRIMEIRA MENSAGEM É GERADA HOJE

**Problema crítico identificado:**

No `amandaOrchestrator.js`, função `tryManualResponse()`:

```javascript
// 👋 SAUDAÇÃO PURA
if (PURE_GREETING_REGEX.test(normalizedText)) {
    if (isFirstContact || !messageCount) {
        return getManual("saudacao");  // ← SEMPRE A MESMA SAUDAÇÃO
    }
    return "Oi! Que bom falar com você de novo 😊 Me conta, deu tudo certo com o agendamento ou ficou mais alguma dúvida? 💚";
}
```

A saudação do `MANUAL_AMANDA.saúdacao`:
```javascript
"saudacao": (
    "Oi! 💚 Eu sou a Amanda, pré-consultora da Clínica Fono Inova..." +
    "Quer me contar o que te fez procurar a clínica hoje? 😊"
)
```

**❌ PROBLEMAS:**
1. **Não há saudação baseada em horário** (bom dia/tarde/noite)
2. **Sempre usa "pré-consultora"** - termo corporativo, frio
3. **Emoji 💚 sempre na mesma posição** - padrão robótico
4. **Mesma frase de abertura para TODO MUNDO** - sem personalização

---

## 🚨 PROBLEMAS ENCONTRADOS

### PROBLEMA 1: SAUDAÇÃO ROBÓTICA E REPETITIVA

**Local:** `amandaPrompt.js` → `MANUAL_AMANDA.saudacao`

**Como está:**
```
"Oi! 💚 Eu sou a Amanda, pré-consultora da Clínica Fono Inova..."
```

**Por que soa robótico:**
- "Pré-consultora" é um termo corporativo que ninguém usa na vida real
- Nunca muda conforme o horário
- Sempre começa com "Oi! 💚"
- Não detecta estado emocional do usuário

**Evidência no código:**
```javascript
// ❌ NÃO EXISTE lógica de saudação baseada em horário
// ❌ NÃO EXISTE detecção de primeiro_contato_24h
// ❌ NÃO EXISTE variação de tom conforme emoção
```

---

### PROBLEMA 2: PERSONALIDADE INCONSISTENTE

**Local:** `amandaPrompt.js` → `SYSTEM_PROMPT_AMANDA`

**O prompt diz:**
```
"Você NÃO é recepcionista. Você é uma PRÉ-CONSULTORA ESTRATÉGICA."
```

**O problema:**
- O termo "pré-consultora estratégica" cria uma **barreira artificial**
- Soa como jargão de consultoria, não como acolhimento de clínica
- Uma recepcionista real de clínica nunca se apresentaria assim

**O que deveria ser:**
- "Sou a Amanda, recepcionista da Fono Inova"
- Ou simplesmente: "Sou a Amanda, da Fono Inova"

---

### PROBLEMA 3: EXCESSO DE INSTRUÇÕES TÉCNICAS NO PROMPT

**Local:** `amandaPrompt.js` → `SYSTEM_PROMPT_AMANDA` (linhas 673-854)

**O prompt tem:**
- 180+ linhas de instruções
- Múltiplos módulos dinâmicos
- Regras complexas de negócio
- Scripts de quebra de objeção engessados

**Resultado:** A IA fica **sobrecarregada** e gera respostas:
- Mecânicas (seguindo scripts à risca)
- Longas demais (muitas informações)
- Repetitivas (sempre os mesmos padrões)

---

### PROBLEMA 4: MÚLTIPLAS PERGUNTAS NO MESMO BLOCO

**Exemplo do código:**

```javascript
// Em buildTriageSchedulingMessage:
return "Claro 😊 Só pra eu te orientar direitinho: qual a idade do paciente (anos ou meses)?";
// Depois...
return "Entendi 💚 Me conta um pouquinho: o que você tem observado no dia a dia que te preocupou?";
// Depois...
return "Perfeito! Pra eu ver as melhores opções: vocês preferem manhã ou tarde?";
```

**❌ Problema:** São 3 mensagens separadas, mas o usuário sente como um **fluxo engessado** de interrogatório.

---

### PROBLEMA 5: RESPOSTAS LONGAS E BLOCS DE TEXTO

**Regra no prompt:**
```
"Máximo 2-3 frases + 1 pergunta"
```

**Na prática (exemplos reais do código):**

```javascript
// ❌ Resposta longa demais:
"Entendo totalmente 💚, é natural comparar. O que muitas famílias percebem é que 
investir em uma equipe integrada (fono + psico + TO) faz o tratamento render mais 
e, no fim, até economiza tempo e sessões. Quer que eu te explique como funciona 
o primeiro passo pra vocês decidirem tranquilos?"
```

**3 frases longas + 1 pergunta = Parece bot.**

---

### PROBLEMA 6: FALTA DE MEMÓRIA DE CONTEXTO EMOCIONAL

**Local:** `amandaOrchestrator.js` → `getOptimizedAmandaResponse()`

**O código detecta emoção em `ContextPack.js`:**
```javascript
const hasEmotionalLanguage = emotionalKeywords.some((word) => text.includes(word));
if (hasEmotionalLanguage) return "acolhimento";
```

**Mas NÃO usa isso para:**
- Adaptar a saudação inicial
- Mudar o tom da primeira resposta
- Priorizar acolhimento vs. agendamento

---

### PROBLEMA 7: EMOJIS PADRONIZADOS E MECÂNICOS

**Regra no código:**
```javascript
// ensureSingleHeart garante SEMPRE 1 💚 no final
return ensureSingleHeart(response);
```

**Resultado:**
- TODAS as mensagens terminam com 💚
- Previsível = robótico
- Sem variação natural

---

### PROBLEMA 8: FLUXO DE AGENDAMENTO MUITO ENGESSADO

**Triagem atual:**
```
1. Pedir período (manhã/tarde)
2. Pedir nome do paciente  
3. Pedir idade
4. Mostrar slots
5. Pedir confirmação
```

**Problema:** Se o usuário já deu a idade na mensagem anterior, **ainda pergunta de novo** se o código não capturou corretamente.

**Evidência:**
```javascript
// ❌ O código TENTA evitar perguntar o que já sabe, mas:
const hasAge = /\b\d{1,2}\s*(anos?|mes(es)?)\b/i.test(text) ||
    lead?.patientInfo?.age ||
    lead?.ageGroup ||
    lead?.qualificationData?.extractedInfo?.idade;
```

Mas na prática, a experiência ainda é de **repetição**.

---

## 📊 DIAGNÓSTICO POR CAMADA

### CAMADA 1: DETECÇÃO DE CONTEXTO (FlagsDetector)

| Aspecto | Status | Observação |
|---------|--------|------------|
| Detecta intenção | ✅ Bom | `deriveFlagsFromText()` é completo |
| Detecta emoção | ⚠️ Razoável | `detectUserProfile()` existe mas é superficial |
| Detecta urgência | ✅ Bom | `mentionsUrgency` e contexto de idade |
| Detecta primeiro contato | ❌ Ruim | Só verifica `messageCount <= 1` |
| Detecta horário | ❌ Não existe | Não há `getHour()` para saudação |

### CAMADA 2: ENRIQUECIMENTO DE CONTEXTO (leadContext.js)

| Aspecto | Status | Observação |
|---------|--------|------------|
| Histórico de mensagens | ✅ Bom | Retorna últimas 20 mensagens |
| Resumo de conversa | ✅ Bom | Gera summary quando necessário |
| Dados do paciente | ⚠️ Razoável | Múltiplas fontes, pode haver inconsistência |
| shouldGreet | ⚠️ Parcial | Baseado em horas desde última mensagem (>24h) |
| Detecção de retorno | ❌ Ruim | Não diferencia "voltei agora" de "primeira vez" |

### CAMADA 3: CONSTRUÇÃO DE RESPOSTA (amandaPrompt.js)

| Aspecto | Status | Observação |
|---------|--------|------------|
| Módulos dinâmicos | ⚠️ Excesso | 30+ módulos sobrecarregam a IA |
| Tom de voz | ❌ Ruim | "Pré-consultora estratégica" é frio |
| Regras de formatação | ⚠️ Razoável | "Máx 2-3 frases" mas não é respeitado |
| Saudação automática | ❌ Ruim | Sempre a mesma mensagem |
| Personalização | ❌ Ruim | Não usa nome do lead na saudação |

### CAMADA 4: ORQUESTRAÇÃO (amandaOrchestrator.js)

| Aspecto | Status | Observação |
|---------|--------|------------|
| Roteamento de fluxos | ✅ Bom | Diferencia agendamento, preço, info |
| Anti-loop | ✅ Bom | Previne repetições com flags |
| Coleta de dados | ⚠️ Razoável | Múltiplos estados, pode confundir |
| Fallbacks | ✅ Bom | Tem fallbacks para erros |
| Humanização | ❌ Ruim | Foca em regras, não em empatia |

---

## 🎯 MELHORIAS SUGERIDAS

### MELHORIA 1: SAUDAÇÃO INTELIGENTE BASEADA EM CONTEXTO

**Nova implementação sugerida:**

```javascript
// utils/greetingEngine.js

export function generateSmartGreeting(context) {
    const { 
        isFirstContact,           // Primeira mensagem ever
        isReturningAfter24h,      // Voltou depois de 24h
        hoursSinceLastMessage,    // Horas desde última msg
        hourOfDay,                // Hora atual (0-23)
        userName,                 // Nome do usuário
        emotionalState,           // 'calmo' | 'ansioso' | 'desesperado' | 'bravo'
        lastTopic,                // Último assunto conversado
    } = context;

    // 1. Determinar tipo de saudação
    let greetingType = 'normal';
    if (isFirstContact) greetingType = 'first_contact';
    else if (isReturningAfter24h) greetingType = 'returning';
    else greetingType = 'continuation';

    // 2. Determinar saudação de horário (só para primeiro contato ou >24h)
    let timeGreeting = '';
    if (greetingType !== 'continuation') {
        if (hourOfDay >= 5 && hourOfDay < 12) timeGreeting = 'Bom dia';
        else if (hourOfDay >= 12 && hourOfDay < 18) timeGreeting = 'Boa tarde';
        else timeGreeting = 'Boa noite';
    }

    // 3. Construir mensagem base
    const greetings = {
        first_contact: {
            calmo: `${timeGreeting}! Que bom que você chegou por aqui. 😊 Sou a Amanda da Fono Inova.`,
            ansioso: `${timeGreeting}! Respira, você está no lugar certo. 🌸 Sou a Amanda da Fono Inova.`,
            desesperado: `${timeGreeting}! Vi sua mensagem e já quero te ajudar. 💚 Sou a Amanda da Fono Inova.`,
            default: `${timeGreeting}! Que bom que você chegou por aqui. 😊 Sou a Amanda da Fono Inova.`,
        },
        returning: {
            calmo: `Oi de novo, ${userName}! 👋`,
            ansioso: `${userName}, voltei aqui para te ajudar. 💚`,
            default: `Oi${userName ? ', ' + userName : ''}! Que bom que você voltou. 😊`,
        },
        continuation: {
            default: '', // Sem saudação, continua fluído
        }
    };

    const baseGreeting = greetings[greetingType][emotionalState] || 
                         greetings[greetingType].default;

    // 4. Adicionar pergunta de abertura contextual
    const openingQuestions = {
        first_contact: 'Como você está? Me conta o que te trouxe até nós hoje?',
        returning: lastTopic ? 
            `Continuando sobre ${lastTopic}, como posso te ajudar?` :
            'Me conta, o que você precisa hoje?',
        continuation: ''
    };

    return baseGreeting + '\n\n' + openingQuestions[greetingType];
}
```

### MELHORIA 2: SIMPLIFICAÇÃO DO AMANDA PROMPT

**Remover do SYSTEM_PROMPT:**

```javascript
// ❌ REMOVER:
"Você NÃO é recepcionista. Você é uma PRÉ-CONSULTORA ESTRATÉGICA."

// ✅ SUBSTITUIR POR:
"Você é a Amanda, recepcionista da Fono Inova. Seu papel é acolher as pessoas como uma recepcionista experiente faria."
```

**Simplificar módulos:**
- De 30+ módulos para 10 módulos essenciais
- Agrupar por contexto (fono, psico, etc.) em um único módulo
- Remover scripts engessados de quebra de objeção

### MELHORIA 3: RESPOSTAS CURTAS E NATURAIS

**Nova regra estrita:**

```javascript
// utils/responseValidator.js

export function validateHumanLikeResponse(response) {
    const checks = {
        // Máximo 140 caracteres por "bloco" (estilo WhatsApp)
        maxBlockLength: response.length <= 140,
        
        // No máximo 1 pergunta
        questionCount: (response.match(/\?/g) || []).length <= 1,
        
        // No máximo 2 emojis
        emojiCount: (response.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length <= 2,
        
        // Não pode ter números de lista (1., 2., 3.)
        noNumberedList: !/^\d+\./m.test(response),
        
        // Não pode ter formatação markdown pesada
        noHeavyMarkdown: !/[\*\_]{2,}/.test(response),
    };
    
    return checks;
}
```

### MELHORIA 4: DETECÇÃO E RESPOSTA A EMOÇÕES

**Implementar em `flagsDetector.js`:**

```javascript
export function detectEmotionalState(text) {
    const normalized = text.toLowerCase();
    
    const emotions = {
        desesperado: [
            /desesperad[oa]/, /t[aá] desesperad/, /n[aã]o aguento mais/,
            /socorro/, /urgente/, /emerg[eê]ncia/, /preciso muito/
        ],
        ansioso: [
            /ansios[oa]/, /preocupad[oa]/, /medo/, /receio/,
            /n[aã]o sei o que fazer/, /t[oô] perdida/, /t[oô] perdido/
        ],
        bravo: [
            /raiva/, /brav[oa]/, /irritad[oa]/, /chatead[oa]/,
            /n[aã]o quero mais/, /j[aá] cansei/, /p[eé]ssimo/
        ],
        calmo: [
            /s[oó] quero informa[cç][aã]o/, /t[aá] tudo bem/,
            /s[oó] pesquisando/, /tranquilo/
        ]
    };
    
    for (const [emotion, patterns] of Object.entries(emotions)) {
        if (patterns.some(p => p.test(normalized))) {
            return emotion;
        }
    }
    
    return 'calmo';
}
```

### MELHORIA 5: MIDDLEWARE DE HUMANIZAÇÃO

**Novo middleware:**

```javascript
// middleware/humanizationMiddleware.js

export function humanizeResponse(response, context) {
    let humanized = response;
    
    // 1. Remover frases robóticas
    const roboticPhrases = [
        /Como posso ajud[aá]-lo[oa]?\??/gi,
        /Aguardo seu retorno\.?/gi,
        /Estou [aà] disposi[cç][aã]o\.?/gi,
        /Entre em contato\.?/gi,
    ];
    
    roboticPhrases.forEach(phrase => {
        humanized = humanized.replace(phrase, '');
    });
    
    // 2. Variar emojis (não sempre 💚)
    if (context.emotionalState === 'ansioso') {
        humanized = humanized.replace(/💚/g, '🌸');
    } else if (context.emotionalState === 'desesperado') {
        humanized = humanized.replace(/💚/g, '🤗');
    }
    
    // 3. Adicionar toques humanos aleatórios
    const humanTouches = [
        { condition: response.includes('certinho'), add: ' 😊' },
        { condition: response.includes('entendi'), add: ' 💚' },
    ];
    
    // 4. Quebrar respostas longas em mensagens separadas
    const sentences = humanized.split(/(?<=[.!?])\s+/);
    if (sentences.length > 2) {
        // Retornar array de mensagens em vez de uma só
        return sentences.slice(0, 2);
    }
    
    return humanized.trim();
}
```

### MELHORIA 6: FLUXO CONVERSACIONAL REVISADO

**Novo fluxo de primeira interação:**

```
Mensagem do usuário
    ↓
[1] Detectar emoção + intenção
    ↓
[2] Gerar saudação contextual (horário + emoção)
    ↓
[3] Responder À PERGUNTA (se houver)
    ↓
[4] Fazer UMA pergunta de follow-up (se necessário)
    ↓
[5] Validar se está "humano" o suficiente
    ↓
Enviar
```

---

## 📝 EXEMPLOS DE MENSAGENS HUMANIZADAS

### CENÁRIO 1: PRIMEIRO CONTATO - MANHÃ

**❌ Atual (robótico):**
```
Oi! 💚 Eu sou a Amanda, pré-consultora da Clínica Fono Inova, aqui em Anápolis.
Meu papel é te ajudar a entender o melhor caminho clínico com clareza e 
acolhimento — pra que você tome uma decisão segura e assertiva.
Quer me contar o que te fez procurar a clínica hoje? 😊
```

**✅ Proposto (humano):**
```
Bom dia! Que bom que você chegou por aqui. 😊 Sou a Amanda da Fono Inova.

Como você está? Me conta o que te trouxe até nós hoje?
```

---

### CENÁRIO 2: USUÁRIO ANSIOSO

**Mensagem do usuário:**
```
Meu filho de 3 anos não fala ainda e eu tô muito preocupada
```

**❌ Atual (robótico):**
```
Entendo sua preocupação 💚 Isso é algo que preocupa muitos pais, e você fez 
muito bem em buscar orientação cedo. A avaliação ajuda a trazer clareza com 
tranquilidade. Prefere agendar essa semana ou na próxima?
```

**✅ Proposto (humano):**
```
Respira comigo... 🌸 Você fez o certo em me procurar.

Com 3 anos ainda tem muito tempo pra estimular, viu? Me conta: ele entende 
o que você fala? Consegue se comunicar de outras formas?
```

---

### CENÁRIO 3: CONTINUAÇÃO DE CONVERSA

**Mensagem do usuário (depois de 2 horas):**
```
Ele entende sim, mas só aponta
```

**❌ Atual (robótico):**
```
Oi! Que bom falar com você de novo 😊 Entendi, ele entende mas ainda não 
fala. Isso é mais comum do que parece! A avaliação de fonoaudiologia vai 
ajudar a entender o melhor caminho. Prefere agendar pra essa semana?
```

**✅ Proposto (humano):**
```
Entendi! Apontar é uma boa sinal — quer dizer que ele quer se comunicar. 
💚

É pra ele que você quer a avaliação, certo? Qual a idade dele mesmo?
```

---

### CENÁRIO 4: PERGUNTA DE PREÇO

**Mensagem do usuário:**
```
Quanto custa a avaliação?
```

**❌ Atual (robótico):**
```
Entendo! Vou te passar certinho 😊 A avaliação inicial é R$ 200. Se você 
me disser se é pra Fono, Psicologia, TO, Fisioterapia ou Neuropsicológica 
eu te passo o certinho 💚
```

**✅ Proposto (humano):**
```
Claro! Sobre valores, a gente cobra R$ 200 a avaliação inicial.

Mas me conta rapidinho: é pra quem? O que você tem observado? Às vezes 
a gente consegue direcionar melhor se eu entender um pouquinho antes 💚
```

---

### CENÁRIO 5: USUÁRIO VOLTOU DEPOIS DE 3 DIAS

**Mensagem do usuário:**
```
Oi, desculpe sumir
```

**❌ Atual (robótico):**
```
Oi! Que bom falar com você de novo 😊 Sem problemas! Me conta, deu tudo 
certo com o agendamento ou ficou mais alguma dúvida? 💚
```

**✅ Proposto (humano):**
```
Oi! 😊 Imagina, acontece. Rotina de mãe é assim mesmo!

Conseguiu ver sobre o que conversamos? Como você tá com isso?
```

---

## 🏗️ NOVA ARQUITETURA SUGERIDA

```
┌─────────────────────────────────────────────────────────────┐
│                    ENTRADA DE MENSAGEM                       │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              CAMADA 1: DETECÇÃO DE CONTEXTO                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │
│  │   Intenção   │ │    Emoção    │ │  Primeiro Contato?   │ │
│  └──────────────┘ └──────────────┘ └──────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│           CAMADA 2: ENGENHARIA DE SAUDAÇÃO                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │
│  │    Horário   │ │    Nome      │ │  Estado Emocional    │ │
│  └──────────────┘ └──────────────┘ └──────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│           CAMADA 3: CONSTRUÇÃO DE RESPOSTA                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │
│  │   Responder  │ │   Perguntar  │ │   Acolher/Validar    │ │
│  └──────────────┘ └──────────────┘ └──────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│           CAMADA 4: HUMANIZAÇÃO                              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │
│  │   Quebrar    │ │   Variar     │ │   Remover robótico   │ │
│  │   frases     │ │   emojis     │ │   padrões            │ │
│  └──────────────┘ └──────────────┘ └──────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                         SAÍDA                                │
└─────────────────────────────────────────────────────────────┘
```

---

## 🎯 PRÓXIMOS PASSOS IMPLEMENTAÇÃO

### Prioridade 1 (Semana 1): Saudação Inteligente
1. [ ] Criar `greetingEngine.js`
2. [ ] Implementar detecção de horário
3. [ ] Implementar detecção de emoção aprimorada
4. [ ] Atualizar `MANUAL_AMANDA.saudacao`

### Prioridade 2 (Semana 2): Simplificação do Prompt
1. [ ] Reescrever `SYSTEM_PROMPT_AMANDA`
2. [ ] Reduzir módulos dinâmicos de 30 para 10
3. [ ] Remover "pré-consultora estratégica"
4. [ ] Adicionar instruções de simplicidade

### Prioridade 3 (Semana 3): Middleware de Humanização
1. [ ] Criar `humanizationMiddleware.js`
2. [ ] Implementar validadores de resposta
3. [ ] Criar sistema de variação de emojis
4. [ ] Implementar quebra de mensagens longas

### Prioridade 4 (Semana 4): Testes e Ajustes
1. [ ] Criar suite de testes de humanização
2. [ ] Testar com 20 cenários diferentes
3. [ ] Coletar feedback de usuários reais
4. [ ] Ajustar finamente

---

## 📈 MÉTRICAS DE SUCESSO

| Métrica | Atual | Meta |
|---------|-------|------|
| Taxa de resposta com saudação genérica | 100% | < 20% |
| Mensagens terminando com 💚 | 100% | < 40% |
| Respostas > 140 caracteres | 70% | < 30% |
| Respostas com > 1 pergunta | 35% | < 10% |
| Satisfação do usuário (NPS) | ? | +20 pontos |
| Taxa de conversão | ? | +10% |

---

## 📚 ANEXOS

### Anexo A: Prompt Simplificado Proposto

```javascript
export const SYSTEM_PROMPT_AMANDA_V2 = `
Você é a Amanda, recepcionista da Clínica Fono Inova em Anápolis.

SEU TOM:
- Fale como uma pessoa real, não como assistente
- Seja acolhedora, mas não forçada
- Use "me conta", "deve estar difícil", "respira"
- NUNCA diga "pré-consultora estratégica"
- NUNCA use listas numeradas
- NUNCA termine com "aguardo retorno"

ESTRUTURA DAS RESPOSTAS:
- Máximo 2 blocos curtos (estilo WhatsApp)
- 1 pergunta por vez
- Máximo 140 caracteres por bloco
- Use emojis com moderação (máx 2)

PRIORIDADES:
1. Acolher primeiro (especialmente se a pessoa está ansiosa)
2. Responder o que foi perguntado
3. Fazer UMA pergunta que avance
4. Nunca repetir o que já foi dito

DADOS DA CLÍNICA:
- Endereço: Av. Minas Gerais, 405 - Jundiaí, Anápolis/GO
- Avaliação inicial: R$ 200 (a maioria das áreas)
- Neuropsicológica: R$ 2.000 (pacote)
- Atendemos: Fono, Psico (criança/adolescente), TO, Fisio, Musicoterapia

REGRA DE OURO:
Se a pessoa parecer ansiosa ou desesperada, ACOLHA antes de tudo.
`.trim();
```

### Anexo B: Exemplos de Respostas para Treinamento

[Seriam adicionados 50+ exemplos de pares (input, output) humanizados]

---

**Documento criado em:** 2026-02-01  
**Versão:** 1.0  
**Autor:** Análise de Código Amanda AI
