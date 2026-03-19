# 🧠 ANÁLISE CORE - RN (Regras de Negócio) da Amanda

## 📁 Arquivos Analisados
1. `utils/flagsDetector.js` (751 linhas) - Detecção de intenções e flags
2. `utils/therapyDetector.js` (420 linhas) - Detecção de áreas terapêuticas  
3. `utils/amandaPrompt.js` (347 linhas) - Prompts e contextos

---

## 1. FLAGS DETECTOR - `flagsDetector.js`

### 🔥 FUNÇÃO PRINCIPAL: `deriveFlagsFromText(text)`
Retorna objeto com ~40 flags booleanas baseadas no texto.

#### FLAGS DE INTENÇÃO (Job/Emprego)
```javascript
hasCurriculumTerms: /\b(curriculo|currículo|cv)\b/i
hasExplicitPartnership: /\b(parceria|credenciamento|prestador|trabalhar com vocês)\b/i
hasJobContext: /\b(vaga de trabalho|emprego|estágio|enviar curric|procura de profissional|estão a procura)\b/i
hasProfessionalIntro: /\b(sou|me chamo)\b.*\b(fonoaudiólogo|psicólogo|terapeuta|fisioterapeuta)\b/i

wantsPartnershipOrResume: hasCurriculumTerms || hasExplicitPartnership || hasJobContext || hasProfessionalIntro
wantsJobOrInternship: isJobRelated(normalizedText) // da therapyKeywords.js
jobArea: extractJobArea(normalizedText) // área mencionada no contexto de emprego
```

#### FLAGS DE AGENDAMENTO
```javascript
wantsSchedule: /\b(agendar|marcar|vaga|consulta|horário disponível|tem hora|quando posso)\b/i
mentionsUrgency: /\b(urgente|hj|hoje|hoje mesmo|ainda hoje|o mais rápido possível)\b/i
confirmsData: /\b(isso mesmo|exato|correto|certo|confirmo|pode ser|ta bom)\b/i && text.length < 30
refusesOrDenies: [/não (quero|preciso)/, /obrigado, não/, /vou pensar/, /depois eu vejo/]
givingUp: /\b(desist|não vou (fazer|continuar)|esquece|não quero mais|tá caro demais|não tenho condições)\b/i
```

#### FLAGS DE PREÇO/PLANO
```javascript
asksPrice: /\b(preço|valor|custa|quanto|investimento|mensalidade|pacote|tabela de preços)\b/i
insistsPrice: /\b(só o preço|fala o valor|me diz o preço)\b/i
mentionsPriceObjection: /\b(car(o|a) demais|muito caro|não tenho dinheiro|tá fora do meu orçamento|não posso pagar)\b/i
mentionsReembolso: /\b(reembolso|reembols(ável|a)|devolvem o dinheiro|posso pedir reembolso)\b/i
asksPlans: /\b(plano|convênio|unimed|ipasgo|amil|sulamérica|bradesco|assim saúde)\b/i
mentionsInsuranceObjection: /\b(só tenho plano|não atende plano|queria pelo plano|particular é caro)\b/i
```

#### FLAGS DE TEMPERAMENTO/EMOCIONAL
```javascript
mentionsDoubtTEA: /\b(será que é tea|suspeita de autismo|muito novo pra saber|fase de descoberta)\b/i
mentionsInvestigation: /\b(investiga|descobrir|saber se tem|fechar diagnóstico|suspeita|laudo)\b/i
isEmotional: /\b(preocupad|ansios|desesperad|chorando|não sei o que fazer|me ajuda|urgente|desespero)\b/i
isJustBrowsing: /\b(só olhando|só pesquisando|tirando dúvida|só queria saber|ainda não decidi)\b/i
isHotLead: /\b(quero agendar|pode marcar|quando tem vaga|quero começar|vamos fazer)\b/i
```

#### FLAGS DE IDADE/PERFIL
```javascript
ageGroup: { baby: 0-2, crianca: 2-12, teen: 12-18, adulto: 18+ }
mentionsChild: /\b(filho|filha|criança|bebê|menino|menina)\b/i
mentionsTeen: /\b(adolescente|pré-adolescente|puberdade|13|14|15|16|17 anos)\b/i
mentionsAdult: /\b(eu mesmo|pra mim|sou eu|tenho \d{2,3} anos|adulto)\b/i
mentionsBaby: /\b(bebê|recém-nascido|rn|meses|0-24 meses)\b/i
```

#### FLAGS DE LOCALIZAÇÃO
```javascript
asksAddress: /\b(onde fica|qual o endereço|como chego|localização|vocês são de|ficam em)\b/i
asksAboutAfterHours: /\b(depois das 18|final de semana|sábado|domingo|fora do horário comercial)\b/i
```

#### FLAGS DE TEA/AUTISMO
```javascript
mentionsTEA_TDAH: /\b(tea|autismo|tdah|déficit de atenção|hiperatividade|espectro autista)\b/i
mentionsLaudo: /\b(laudo|relatório|avaliação completa|testes|avaliação neuropsicológica)\b/i
mentionsNeuropediatra: /\b(neuropediatra|neurologista|médico|pediatra)\b/i
```

---

## 2. THERAPY DETECTOR - `therapyDetector.js`

### 🏥 ESPECIALIDADES MAPEADAS

```javascript
THERAPY_SPECIALTIES = {
    neuropsychological: {
        id: 'neuropsychological',
        names: ['neuropsicologia', 'neuropsi'],
        patterns: [
            /neuropsicologia/i,
            /avaliação neuropsi/i,
            /laudo neuropsi/i,
            /funções executivas/i,
            /teste de qi/i
        ],
        symptoms: ['investigacao', 'diagnostico', 'laudo'],
        ageRange: ['crianca', 'adolescente', 'adulto'],
        duration: '10_sessoes',
        hasReport: true,
        priceTier: 'premium'
    },
    
    speech: {
        id: 'speech',
        names: ['fonoaudiologia', 'fono'],
        patterns: [
            /fono|fonoaudiologia/i,
            /não fala|fala pouco/i,
            /gagueira|gaguejo/i,
            /troca letras|troca sons/i,
            /atraso na fala/i
        ],
        symptoms: ['atraso_fala', 'gagueira', 'nao_fala'],
        ageRange: ['baby', 'crianca'],
        duration: 'sessao_40min',
        priceTier: 'standard'
    },
    
    tongue_tie: {
        names: ['teste da linguinha', 'frênulo lingual'],
        patterns: [
            /teste da linguinha/i,
            /frênulo|freio da língua/i,
            /amamentação|dificuldade mamar/i
        ]
    },
    
    psychology: {
        names: ['psicologia', 'psicólogo'],
        patterns: [
            /psicologia|psicólogo/i,
            /ansiedade|depressão/i,
            /comportamento|birra/i
        ]
    },
    
    occupational: {
        names: ['terapia ocupacional', 'TO'],
        patterns: [
            /terapia ocupacional/i,
            /\bTO\b/,
            /integração sensorial/i,
            /coordenação motora/i
        ]
    },
    
    physiotherapy: {
        names: ['fisioterapia', 'fisio'],
        patterns: [
            /fisio|fisioterapia/i,
            /avc|paralisia/i,
            /desenvolvimento motor/i
        ]
    },
    
    music: {
        names: ['musicoterapia'],
        patterns: [/musicoterapia/i]
    },
    
    neuropsychopedagogy: {
        names: ['neuropsicopedagogia'],
        patterns: [/neuropsicopedagogia|dislexia|discalculia/i]
    },
    
    psychopedagogy: {
        names: ['psicopedagogia'],
        patterns: [
            /psicopedagogia/i,
            /dificuldade de aprendizagem/i,
            /problema escolar/i
        ]
    }
}
```

### 🔧 FUNÇÃO: `detectAllTherapies(text)`
Retorna array de terapias detectadas ordenadas por prioridade.

```javascript
// Ordem de prioridade:
['neuropsychological', 'speech', 'tongue_tie', 'occupational', 
 'physiotherapy', 'music', 'neuropsychopedagogy', 'psychopedagogy', 'psychology']

// Retorno:
[{
    id: 'neuropsychological',
    confidence: 0.95,
    matchedPattern: /neuropsicologia/i,
    position: 15
}]
```

### 🔧 FUNÇÃO: `normalizeTherapyTerms(text)`
Normaliza o texto antes da detecção:
- Remove acentos
- Remove "clínica fono inova"
- Corrige typos: "fino" → "fono", "fini" → "fono"
- Unifica: "neuropsico" → "neuropsicologia"

---

## 3. AMANDA PROMPT - `amandaPrompt.js`

### 📝 CONTEXTO DO SISTEMA
Prompt base que define a personalidade da Amanda:
- Fofa, acolhedora, profissional
- Nunca médica, sempre terapeuta
- Nunca promete diagnóstico por WhatsApp
- Foco em agendamento de avaliação

### 📋 MANUAIS DE RESPOSTA (WISDOM)

```javascript
manuals = {
    saudacao: "Oi! 😊 Meu nome é Amanda...",
    
    valores: {
        avaliacao: "A avaliação inicial é R$ 200...",
        fonoaudiologia: "A avaliação de fonoaudiologia...",
        psicologia: "A avaliação de psicologia...",
        neuropsicologia: "A avaliação neuropsicológica completa é R$ 2.000..."
    },
    
    convenio: "Trabalhamos com reembolso...",
    
    localizacao: "Estamos na Av. Minas Gerais, 405...",
    
    curriculo: "Que bom seu interesse! 💚\n\n" +
               "Os currículos são recebidos por e-mail:\n" +
               "📩 contato@clinicafonoinova.com.br\n\n" +
               "No assunto, coloque sua área de atuação..."
}
```

### 🎯 FUNÇÕES PRINCIPAIS

#### `getManual(type, subtype)`
Retorna texto do manual especificado.

#### `selectBestContext(flags, text)`
Seleciona o contexto mais adequado baseado nas flags:
```javascript
if (flags.mentionsTEA_TDAH) return 'teaContext';
if (flags.mentionsInvestigation) return 'investigationContext';
if (flags.multidisciplinary) return 'multiTeamContext';
if (flags.mentionsBaby) return 'babyContext';
if (flags.mentionsPriceObjection) return 'priceObjection';
```

---

## 🔗 FLUXO DE INTEGRAÇÃO

### 1. Mensagem chega no Webhook
```
whatsappController.receiveMessage()
  └── contentToSave = texto da mensagem
  └── quickFlags = deriveFlagsFromText(contentToSave)
```

### 2. Amanda Orchestrador processa
```
getOptimizedAmandaResponse()
  └── processMessageLikeAmanda()
      └── detectAllTherapies() // therapyDetector
      └── extracted.flags = { ... } // flags locais
  └── buildSimpleResponse()
      └── usa flags + contexto
```

### 3. Resposta é gerada
```
Se wantsPartnershipOrResume → Resposta de currículo
Se wantsSchedule + therapyArea → Resposta de agendamento
Se asksPrice → Resposta de valores
Se !therapyArea → Pergunta qual área
```

---

## ⚠️ PROBLEMAS IDENTIFICADOS

### 1. Flags de Emprego Não Estavam Sendo Verificadas
**Local:** `AmandaOrchestrator.js` linha 1564-1567
**Problema:** A verificação de `wantsPartnershipOrResume` acontecia DEPOIS da pergunta "qual área você precisa?"
**Correção:** Adicionar verificação ANTES da linha 1564 ✅ FEITO

### 2. Terapeuta Ocupacional Não Detectado
**Local:** `AREA_DEFS` e patterns de TO
**Problema:** Regex não capturava "terapeuta ocupacional" (só "terapia ocupacional")
**Correção:** Adicionar `terapeuta ocupacional` nos patterns ✅ FEITO

### 3. Detecção de Área em Contexto de Emprego
**Local:** `flagsDetector.js` 
**Problema:** `hasProfessionalIntro` detectava profissional, mas não extraía a área
**Correção:** Adicionar `jobArea` nos exports ✅ FEITO

---

## 📊 COBERTURA DE TERMOS

### Fonoaudiologia (Fono)
✅ fono, fonoaudiologia, fonoaudiólogo, fonoaudióloga, fonoáudiologa
✅ linguagem, fala, voz, deglutição, mastigação
✅ miofuncional, motricidade orofacial
✅ linguinha, freio da língua, frenulo, lábio leporino, fenda palatina
✅ respiração oral, voz rouca, rouquidão
✅ gagueira, gaguejo, tartamudez, fluência
✅ engasgar, baba, salivação
✅ mamar, amamentação, chupeta, lactação

### Psicologia
✅ psicologia, psicólogo, psicóloga, psicoterapia
✅ comportamento, comportamental, birra, birras, manha
✅ não obedece, desobedece, agressivo, agressividade
✅ ansiedade, ansioso, ansiosa, medo, fobia, fobico
✅ depressão, depressivo, triste, choroso
✅ não dorme, insônia, pesadelo, terror noturno
✅ enurese, xixi na cama, encoprese, queima roupa
✅ autolesão, automutilação, toc, ritual, mania
✅ seletividade alimentar, recusa alimentar
✅ timidez, isolamento, socialização

### Terapia Ocupacional (TO)
✅ terapia ocupacional, terapeuta ocupacional, to
✅ ocupacional, integração sensorial, sensorial
✅ coordenação motora, motricidade, motricidade fina
✅ segurar lápis, amarrar cadarço, botão, zíper
✅ escovar dentes, tomar banho, vestir-se
✅ alimentação, comer sozinho, pinça
✅ lateralidade, canhoto, destro, dominância
✅ reflexos, reflexos primitivos, tônus
✅ avd, atividades de vida diária

### Fisioterapia (Fisio)
✅ fisioterapia, fisioterapeuta, fisio
✅ atraso motor, desenvolvimento motor, psicomotor
✅ não engatinhou, não andou, começou a andar tarde
✅ andar na ponta, pé torto
✅ torticolo, assimetria, preferência lateral
✅ prematuro, prematuridade
✅ hipotonia, flacidez, hipertonia, espasticidade
✅ fortalecimento, equilíbrio, quedas
✅ postura, escoliose, cifose, coluna

### Neuropsicologia
✅ neuropsicologia, neuropsicólogo, neuropsicóloga, neuropsi
✅ avaliação neuropsicológica, laudo
✅ teste de qi, funções executivas, inteligência
✅ memória, atenção, concentração, foco
✅ dificuldade de aprendizagem, dislexia, discalculia
✅ tdah, tda, déficit de atenção, hiperatividade
✅ rendimento escolar, nota baixa, reprovação
✅ superdotação, altas habilidades
✅ tea, autismo, espectro autista

### Musicoterapia
✅ musicoterapia, musicoterapeuta
✅ música, musical, ritmo, melodia
✅ instrumento musical, cantar, vocalização
✅ estimulação musical, percepção musical

### Psicopedagogia
✅ psicopedagogia, psicopedagogo, psicopedagoga
✅ reforço escolar, acompanhamento escolar
✅ dificuldade escolar, dificuldade de aprendizagem
✅ alfabetização, leitura, escrita, matemática
✅ adaptação curricular

---

## 🎯 CONSIDERAÇÕES FINAIS

1. **As RN estão bem distribuídas** nos 3 arquivos
2. **A detecção é robusta** com múltiplos patterns por área
3. **A normalização** corrige typos comuns
4. **A priorização** (neuro > fono > to > fisio) faz sentido clínico
5. **O problema do log** foi a ordem de verificação, não a detecção em si

**Próximos passos:** Monitorar se as correções funcionam nos próximos logs.
