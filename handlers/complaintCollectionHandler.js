// handlers/complaintCollectionHandler.js
import { generateHandlerResponse } from '../services/aiAmandaService.js';
import Logger from '../services/utils/Logger.js';

const logger = new Logger('ComplaintCollectionHandler');

// 🔥 VARIAÇÕES de contexto para tornar as respostas dinâmicas
const THERAPY_CONTEXTS = {
    fonoaudiologia: {
        focus: 'fala, comunicação, mastigação ou linguagem',
        examples: 'troca de letras, dificuldade para engolir, atraso na fala',
        tone: 'acolhedora e leve'
    },
    psicologia: {
        focus: 'comportamento, emoções ou socialização',
        examples: 'ansiedade, dificuldade de interação, birras frequentes',
        tone: 'empática e acolhedora'
    },
    'terapia ocupacional': {
        focus: 'coordenação motora, autonomia ou sensorial',
        examples: 'dificuldade com objetos, sensibilidade a texturas, independência',
        tone: 'encorajadora'
    },
    fisioterapia: {
        focus: 'desenvolvimento motor, postura ou movimento',
        examples: 'atraso para engatinhar, marcha, fortalecimento muscular',
        tone: 'profissional e acolhedora'
    },
    neuropsicologia: {
        focus: 'atenção, memória, aprendizagem ou funções executivas',
        examples: 'dificuldade de concentração, TDAH, avaliação para laudo',
        tone: 'técnica mas acolhedora'
    },
    default: {
        focus: 'desenvolvimento ou bem-estar',
        examples: 'o que você observa no dia a dia',
        tone: 'acolhedora'
    }
};

// 🔥 PERGUNTAS VARIADAS (nunca a mesma)
const QUESTION_VARIATIONS = [
    "Me conta brevemente o que tem te preocupado?",
    "Qual é a principal situação que você gostaria de trabalhar?",
    "O que você tem observado que motivou essa busca?",
    "Pode compartilhar o que tem acontecido?",
    "O que te trouxe até aqui hoje?"
];

export const complaintCollectionHandler = {
    async execute({ decisionContext }) {
        const { memory, analysis, lead } = decisionContext;
        
        // Terapia detectada (cascata completa)
        const therapy = 
            memory?.therapyArea || 
            analysis?.therapyArea || 
            lead?.therapyArea ||
            analysis?.extractedInfo?.therapyArea ||
            'terapia';

        // Contexto específico da terapia
        const context = THERAPY_CONTEXTS[therapy] || THERAPY_CONTEXTS.default;
        
        // Variação baseada no hash do lead (sempre a mesma para o mesmo lead, diferente para outros)
        const leadHash = lead?._id?.toString()?.slice(-2) || '00';
        const variationIndex = parseInt(leadHash, 16) % QUESTION_VARIATIONS.length;
        const baseQuestion = QUESTION_VARIATIONS[variationIndex];

        logger.debug('Generating dynamic complaint request', { 
            therapy, 
            variationIndex,
            hasHistory: !!memory?.conversationHistory?.length 
        });

        try {
            // 🔥 GERA RESPOSTA DINÂMICA VIA IA
            const promptContext = `
Você é Amanda, pré-consultora da Clínica Fono Inova.

CONTEXTO DO LEAD:
- Terapia identificada: ${therapy}
- Foco: ${context.focus}
- Tom: ${context.tone}
- Exemplos relevantes: ${context.examples}

MISSÃO:
Acolher brevemente (1 frase) e pedir a queixa principal de forma natural.

REGRAS:
1. Máximo 2-3 frases curtas
2. NÃO seja robótica - varie a estrutura
3. Mencione a terapia específica
4. Sugira exemplos relevantes mas deixe aberto
5. Exatamente 1 💚 no final
6. Termine com pergunta que avança

ESTRUTURA SUGERIDA (varie!):
- Acolhimento: "Entendi que você busca ${therapy} 💚"
- Pergunta: "${baseQuestion}"
- Contexto: "Pode ser sobre ${context.examples}... o que você observa?"

Exemplos BOAS (não copie, use como referência de tom):
"Entendi que é para fonoaudiologia 💚 Me conta: o que você tem notado sobre a fala dela? Troca letras? Tem dificuldade com algum som?"

"Perfeito, psicologia 💚 O que tem motivado essa busca? Pode ser algo com comportamento, ansiedade ou socialização..."

Agora gere uma resposta ÚNICA e NATURAL:
`;

            const aiResponse = await generateHandlerResponse({
                promptContext,
                systemPrompt: null, // Usa prompt padrão do Amanda
                lead,
                memory
            });

            if (aiResponse && aiResponse.length > 20) {
                return {
                    text: aiResponse,
                    extractedInfo: {
                        awaitingComplaint: true,
                        lastQuestion: 'primary_complaint'
                    }
                };
            }

            // Fallback se IA falhar
            throw new Error('AI response too short');

        } catch (err) {
            logger.warn('AI generation failed, using fallback', err.message);
            
            // Fallback dinâmico (não a mesma mensagem fixa!)
            const fallbacks = [
                `Entendi que você busca ${therapy} 💚\n\n${baseQuestion}\n\nPode ser sobre ${context.examples}. O que você observa no dia a dia?`,
                `Ótimo, ${therapy} 💚\n\nPara eu preparar o melhor atendimento, ${baseQuestion.toLowerCase()}\n\n(${context.examples}...)`,
                `${baseQuestion} 💚\n\nCom ${therapy}, trabalhamos com ${context.focus}. Pode ser algo como ${context.examples}?`
            ];
            
            const fallbackIndex = parseInt(leadHash, 16) % fallbacks.length;
            
            return {
                text: fallbacks[fallbackIndex],
                extractedInfo: {
                    awaitingComplaint: true,
                    lastQuestion: 'primary_complaint'
                }
            };
        }
    }
};
