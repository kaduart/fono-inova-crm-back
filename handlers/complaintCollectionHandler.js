// handlers/complaintCollectionHandler.js
import { generateHandlerResponse } from '../services/aiAmandaService.js';
import Logger from '../services/utils/Logger.js';
import { buildResponse } from '../services/intelligence/naturalResponseBuilder.js';

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
        const startTime = Date.now();
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

        logger.info('ComplaintHandler START', { 
            leadId: lead?._id?.toString(),
            therapy, 
            variationIndex,
            hasHistory: !!memory?.conversationHistory?.length 
        });

        try {
            // 🆕 RESPOSTA NATURAL (rápida) - evita chamada de IA
            const buildStart = Date.now();
            const naturalResponse = buildResponse('ask_complaint', { 
                therapy: therapy,
                leadId: lead?._id 
            });
            const buildTime = Date.now() - buildStart;
            
            logger.info('ComplaintHandler buildResponse', {
                leadId: lead?._id?.toString(),
                buildTimeMs: buildTime,
                hasResponse: !!naturalResponse,
                response: naturalResponse?.substring(0, 50)
            });
            
            if (naturalResponse) {
                const totalTime = Date.now() - startTime;
                logger.info('ComplaintHandler FAST_RETURN', {
                    leadId: lead?._id?.toString(),
                    totalTimeMs: totalTime
                });
                return {
                    text: naturalResponse,
                    extractedInfo: {
                        awaitingComplaint: true,
                        lastQuestion: 'primary_complaint'
                    }
                };
            }

            // Fallback: Gera via IA se não tiver resposta natural
            throw new Error('No natural response available');

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
