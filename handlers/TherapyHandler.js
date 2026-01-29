// handlers/TherapyHandler.js
import { generateHandlerResponse } from '../services/aiAmandaService.js';
import Logger from '../services/utils/Logger.js';

const logger = new Logger('TherapyHandler');

// 🔥 CONTEXTOS ESPECÍFICOS POR TERAPIA
const THERAPY_DETAILS = {
    fonoaudiologia: {
        benefits: ['desenvolvimento da fala', 'comunicação clara', 'mastigação adequada', 'autoconfiança'],
        approach: 'avaliação individualizada com jogos e atividades lúdicas',
        duration: '40-50 minutos'
    },
    psicologia: {
        benefits: ['bem-estar emocional', 'compreensão de comportamentos', 'habilidades sociais', 'autoconhecimento'],
        approach: 'abordagem lúdica e acolhedora no espaço sensorial',
        duration: '50 minutos'
    },
    'terapia ocupacional': {
        benefits: ['autonomia no dia a dia', 'coordenação motora', 'regulação sensorial', 'independência'],
        approach: 'atividades funcionais com integração sensorial',
        duration: '50 minutos'
    },
    fisioterapia: {
        benefits: ['fortalecimento muscular', 'postura adequada', 'equilíbrio', 'qualidade de movimento'],
        approach: 'exercícios terapêuticos adaptados à idade',
        duration: '40-50 minutos'
    },
    neuropsicologia: {
        benefits: ['avaliação completa das funções cognitivas', 'atenção e memória', 'planejamento de intervenção', 'laudo detalhado'],
        approach: 'avaliação neuropsicológica completa com diversos instrumentos',
        duration: '10-12 sessões para avaliação completa'
    },
    musicoterapia: {
        benefits: ['expressão emocional', 'interação social', 'regulação', 'desenvolvimento global'],
        approach: 'uso terapêutico da música e elementos sonoros',
        duration: '40 minutos'
    },
    default: {
        benefits: ['desenvolvimento global', 'qualidade de vida', 'bem-estar'],
        approach: 'acompanhamento individualizado',
        duration: '40-50 minutos'
    }
};

class TherapyHandler {
    async execute({ decisionContext }) {
        const { memory, analysis, lead } = decisionContext;
        
        // Cascata de terapia
        const therapy = 
            memory?.therapyArea || 
            analysis?.therapyArea || 
            lead?.therapyArea ||
            analysis?.extractedInfo?.therapyArea ||
            'terapia';

        const details = THERAPY_DETAILS[therapy] || THERAPY_DETAILS.default;
        
        logger.debug('Generating therapy explanation', { therapy });

        try {
            // 🔥 GERA RESPOSTA DINÂMICA VIA IA
            const promptContext = `
Você é Amanda da Clínica Fono Inova.

TERAPIA: ${therapy}
BENEFÍCIOS: ${details.benefits.join(', ')}
ABORDAGEM: ${details.approach}
DURAÇÃO: ${details.duration}

MISSÃO:
Explicar BREVEMENTE como funciona a ${therapy} de forma acolhedora e convidar para agendamento.

REGRAS:
1. Máximo 2-3 frases sobre a terapia
2. Mencione 1-2 benefícios específicos (não liste todos)
3. Seja natural, não use linguagem técnica excessiva
4. Termine oferecendo ajuda com valores ou horários
5. Exatamente 1 💚

ESTRUTURA (varie!):
- Reconheça a escolha da terapia
- Explique brevemente o foco
- Ofereça próximo passo (valores ou horários)

Exemplos (varie o tom):
"A fonoaudiologia aqui foca no desenvolvimento natural da comunicação 💚 Trabalhamos com jogos e atividades para tornar o processo leve. Quer que eu te explique os valores ou prefere ver horários disponíveis?"

"Com a psicologia, criamos um espaço seguro para a criança explorar emoções e comportamentos 💚 Cada sessão é adaptada às necessidades dela. Posso te ajudar com valores ou verificar disponibilidade?"

Agora gere uma explicação ÚNICA e NATURAL para ${therapy}:
`;

            const aiResponse = await generateHandlerResponse({
                promptContext,
                lead,
                memory
            });

            if (aiResponse && aiResponse.length > 30) {
                return { text: aiResponse };
            }

            throw new Error('AI response too short');

        } catch (err) {
            logger.warn('AI generation failed, using fallback', err.message);
            
            // Fallbacks variados
            const fallbacks = [
                `A ${therapy} na Fono Inova trabalha com ${details.approach} 💚\n\nO foco é em ${details.benefits.slice(0, 2).join(' e ')}, sempre respeitando o ritmo da criança.\n\nQuer que eu te passe os valores ou prefere verificar horários disponíveis?`,
                
                `Com ${therapy}, oferecemos ${details.approach} 💚\n\nBuscamos desenvolver ${details.benefits[0]} de forma natural e acolhedora.\n\nPosso te ajudar com informações de valores ou disponibilidade de horários?`,
                
                `Nossa ${therapy} é pensada para apoiar ${details.benefits.slice(0, 2).join(' e ')} 💚\n\nCada sessão tem ${details.duration} e é totalmente individualizada.\n\nPrefere conhecer os valores ou já verificar horários?`
            ];
            
            // Seleciona baseado no lead (consistente para mesmo lead)
            const leadHash = lead?._id?.toString()?.slice(-1) || '0';
            const index = parseInt(leadHash, 16) % fallbacks.length;
            
            return { text: fallbacks[index] };
        }
    }
}

export default new TherapyHandler();
