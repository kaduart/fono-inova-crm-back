// /src/utils/amandaIntents.js
/* =========================================================================
   AMANDA INTENTS - Sistema de Fallback Local
   Cérebro rápido com respostas pré-definidas para cenários críticos
   ========================================================================= */

export const AMANDA_INTENTS = {
    // 🎯 INTENÇÃO: SAUDAÇÃO INICIAL
    greeting: {
        patterns: [
            /^(oi|ola|olá|hey|hi|começar|iniciar)$/i,
            /^(quero\s+informações|informações|me\s+ajude|ajuda)$/i,
            /^(boa\s+(tarde|noite|dia)|bom\s+(dia|tarde|noite))$/i
        ],
        responses: [
            "Olá! 😊 Sou a Amanda, da Clínica Fono Inova. Como posso ajudar? 💚",
            "Oi! Que bom seu contato! 💚 Qual especialidade tem interesse?",
            "Bom dia/tarde! 😊 Em que posso ser útil? Fono, psicologia ou outra especialidade? 💚"
        ]
    },

    // 💰 INTENÇÃO: PREÇO DA AVALIAÇÃO
    price_evaluation: {
        patterns: [
            /(preço|preco|valor|custa|quanto).*(avalia|consulta|inicial)/i,
            /(quanto custa|qual o valor).*(avalia|consulta)/i,
            /^(avaliação|consulta).*(quanto|preço|valor)/i,
            /valor da (consulta|avaliação)/i
        ],
        responses: [
            "A avaliação inicial é R$ 220,00! 💚 Serve para entendermos a queixa e traçar o plano ideal. É para criança ou adulto?",
            "O valor da avaliação é R$ 220,00! 💚 Primeiro fazemos essa etapa para conhecer o paciente e definir o acompanhamento. Qual a idade?",
            "Cobramos R$ 220,00 pela avaliação inicial! 💚 É o primeiro passo para montarmos o plano terapêutico. Pode me contar qual a principal queixa?"
        ]
    },

    // 🏥 INTENÇÃO: PLANOS DE SAÚDE
    health_plans: {
        patterns: [
            /(unimed|ipasgo|amil|plano|convênio|convenio)/i,
            /(atendem|aceita).*(plano|convênio|convenio)/i,
            /(particular|plano de saúde)/i
        ],
        responses: [
            "Entendo sua preferência por plano! 💚 Estamos em credenciamento (Unimed, IPASGO, Amil) e no momento atendemos particular. Posso te explicar nossos valores?",
            "Estamos em processo de credenciamento com os planos! 💚 Por enquanto atendemos particular, com condições especiais. Quer conhecer nossos preços?",
            "Agradeço o interesse! 💚 Estamos finalizando o credenciamento. Atualmente atendemos particular - posso te passar os valores?"
        ]
    },

    // 📍 INTENÇÃO: ENDEREÇO/LOCALIZAÇÃO
    address: {
        patterns: [
            /(onde fica|endereço|local|localização|mapa|como chegar)/i,
            /(av\.|avenida|rua|minas gerais)/i,
            /(qual.*endereço|morada)/i
        ],
        responses: [
            "Ficamos na Av. Minas Gerais, 405 - Jundiaí, Anápolis-GO! 💚 Precisa de orientação para chegar?",
            "Nosso endereço é Av. Minas Gerais, 405, Jundiaí - de frente ao SESI! 💚 Temos estacionamento fácil!",
            "Estamos na Av. Minas Gerais, 405 - Jundiaí! 💚 Fácil acesso e estacionamento. Precisa do link do maps?"
        ]
    },

    // 🧩 INTENÇÃO: TEA/TDAH
    tea_tdah: {
        patterns: [
            /(tea|autismo|tdah|transtorno|espectro)/i,
            /(déficit|deficit|hiperatividade)/i,
            /(neurodivers|atípico)/i
        ],
        responses: [
            "Compreendo perfeitamente! 💚 Temos equipe multiprofissional especializada em neurodiversidades. A avaliação inicial é essencial para traçarmos o plano ideal!",
            "Que bom que nos encontrou! 💚 Somos especializados em TEA/TDAH com abordagem integrada. Vamos agendar uma avaliação?",
            "Entendo! 💚 Trabalhamos com muitos casos de neurodiversidade. A primeira avaliação nos ajuda a entender as necessidades específicas. A criança já tem diagnóstico?"
        ]
    },

    // 🗣️ INTENÇÃO: FONO/ATRASO FALA
    speech_delay: {
        patterns: [
            /(fono|fala|linguagem|pronúncia|troca letras)/i,
            /(não fala|atraso|demora para falar|gagueira)/i,
            /(fonoaudiólogo|fonoaudiologia)/i
        ],
        responses: [
            "Entendo sua preocupação! 💚 Nossas fonoaudiólogas são especializadas em desenvolvimento da linguagem. A intervenção precoce faz toda diferença!",
            "Compreendo! 💚 A fonoaudiologia infantil é nossa especialidade! Vamos agendar uma avaliação para entender as necessidades?",
            "Que bom que buscou ajuda! 💚 Na fono, começamos com avaliação para montar o plano ideal. Há quanto tempo notaram essa dificuldade?"
        ]
    },

    // ⏱️ INTENÇÃO: DURAÇÃO DA SESSÃO
    session_duration: {
        patterns: [
            /(quanto tempo|duração|dura quanto|tempo da sessão)/i,
            /(quantos minutos|horas de terapia)/i,
            /(sessão.*dura|dura.*sessão)/i
        ],
        responses: [
            "Cada sessão dura 40 minutos! 💚 É um tempo pensado para que a criança participe bem, sem ficar cansada, e aproveite ao máximo os estímulos.",
            "Nossas sessões têm 40 minutos de duração! 💚 Período ideal para manter o engajamento e garantir resultados.",
            "As sessões são de 40 minutos! 💚 Tempo suficiente para trabalhar os objetivos sem cansar o paciente."
        ]
    },

    // 👶 INTENÇÃO: BEBÊS/CRIANÇAS PEQUENAS
    babies_toddlers: {
        patterns: [
            /(bebê|bebe|recém nascido|recem nascido|1 ano|2 anos|3 anos)/i,
            /(criança pequena|filho pequeno|filha pequena)/i,
            /(meses|primeiros anos)/i
        ],
        responses: [
            "Que fase gostosa! 💚 Nessa idade a intervenção precoce faz toda diferença no desenvolvimento. Atendemos a partir de 1 ano!",
            "Que benção! 💚 Trabalhamos muito com essa faixa etária - a estimulação precoce é fundamental. Vamos agendar uma avaliação?",
            "Compreendo! 💚 Essa é a melhor fase para intervenção! Nossas profissionais são especializadas em desenvolvimento infantil."
        ]
    },

    // 🧠 INTENÇÃO: PSICOLOGIA INFANTIL
    child_psychology: {
        patterns: [
            /(psicóloga infantil|psicologa infantil|psicólogo infantil)/i,
            /(psicologia.*crian|terapia.*crian)/i,
            /(comportamento infantil|birra|mania|transtorno.*crian)/i
        ],
        responses: [
            "Temos psicólogas infantis excelentes! 💚 A avaliação inicial é R$ 220,00. Pode me contar um pouco sobre o comportamento?",
            "Que bom que pensou na psicologia! 💚 Nossas psicólogas são especializadas em infantil. Vamos agendar uma avaliação?",
            "Compreendo! 💚 A psicologia infantil pode ajudar muito! A primeira consulta é para entendermos a demanda. Qual a idade da criança?"
        ]
    },

    // 📅 INTENÇÃO: AGENDAMENTO
    scheduling: {
        patterns: [
            /(agendar|marcar|marcação|consulta|horário|agenda)/i,
            /(quero agendar|gostaria de marcar|marcar consulta)/i,
            /(tem vaga|vagas|disponibilidade)/i
        ],
        responses: [
            "Perfeito! 💚 Vamos encontrar o melhor horário! Qual período prefere: manhã ou tarde?",
            "Excelente! 💚 Posso te ajudar com o agendamento! Qual dia da semana funciona melhor?",
            "Que ótimo! 💚 Vamos reservar seu horário! Prefere segunda a sexta ou tem flexibilidade?"
        ]
    },

    // 💳 INTENÇÃO: PAGAMENTO
    payment: {
        patterns: [
            /(pagamento|pix|cartão|cartao|dinheiro|crédito|débito)/i,
            /(forma de pagamento|como pagar)/i,
            /(parcel|dividir|vezes no cartão)/i
        ],
        responses: [
            "Aceitamos PIX, cartão (até 6x) e dinheiro! 💚 Temos condições especiais também!",
            "Temos várias formas: PIX, cartão crédito/débito (até 6x) e dinheiro! 💚 Qual prefere?",
            "Facilitamos o pagamento: PIX, cartão em até 6x ou dinheiro! 💚 Conforto total para você!"
        ]
    },

    // 🧪 INTENÇÃO: AVALIAÇÃO NEUROPSICOLÓGICA
    neuropsychological: {
        patterns: [
            /(neuropsicológica|neuropsicologia|avaliação completa)/i,
            /(laudo|diagnóstico|teste psicológico)/i,
            /(avaliação.*atenção|memória|raciocínio)/i
        ],
        responses: [
            "A avaliação neuropsicológica é R$ 2.500,00 em 6x ou R$ 2.300,00 à vista! 💚 São 10 sessões de 50min para investigar funções cognitivas.",
            "Fazemos avaliação neuropsicológica completa! 💚 Valor: R$ 2.500,00 (6x) ou R$ 2.300,00 (à vista). Ideal para TDAH, TEA e dificuldades de aprendizagem.",
            "Temos avaliação neuropsicológica! 💚 R$ 2.500,00 parcelado ou R$ 2.300,00 à vista. A partir de 4 anos, investiga atenção, memória e raciocínio."
        ]
    },

    // 👅 INTENÇÃO: TESTE DA LINGUINHA
    tongue_tie: {
        patterns: [
            /(teste da linguinha|frênulo|freio lingual)/i,
            /(linguinha|amamentação|dificuldade.*mamar)/i,
            /(bebe.*não.*mama|sucção)/i
        ],
        responses: [
            "O Teste da Linguinha é R$ 150,00! 💚 Avaliamos o frênulo lingual de forma rápida e segura.",
            "Fazemos Teste da Linguinha por R$ 150,00! 💚 Protocolo completo para verificar se há alteração no frênulo.",
            "Temos Teste da Linguinha - R$ 150,00! 💚 Essencial para identificar dificuldades na amamentação e fala."
        ]
    },

    // ❓ INTENÇÃO: PEDIDO MÉDICO
    medical_request: {
        patterns: [
            /(pedido médico|receita|encaminhamento)/i,
            /(precisa.*médico|médico.*encaminha)/i,
            /(documento.*consulta)/i
        ],
        responses: [
            "Não precisa de pedido médico para agendar! 💚 Você pode marcar direto conosco!",
            "Pode agendar sem pedido médico! 💚 A avaliação é o primeiro passo, independente de encaminhamento.",
            "Não é necessário pedido médico! 💚 Muitos pacientes nos procuram diretamente. Vamos agendar?"
        ]
    },

    // 🎯 INTENÇÃO: PADRÃO (FALLBACK)
    default: {
        patterns: [/.*/],
        responses: [
            "Entendi! 💚 Pode me contar um pouco mais sobre o que precisa? Assim posso te ajudar melhor!",
            "Compreendo! 💚 Qual especialidade tem interesse? Fono, psicologia, terapia ocupacional?",
            "Obrigada pela mensagem! 💚 Pode me explicar qual é a queixa principal? Assim direciono para a profissional ideal!"
        ]
    }
};

/* =========================================================================
   SISTEMA DE MATCH DE INTENÇÕES
   ========================================================================= */

/**
 * Encontra a intenção mais adequada para a mensagem do usuário
 */
export function findMatchingIntent(userMessage) {
    const message = userMessage.toLowerCase().trim();

    // Procura por intenções específicas (excluindo 'default')
    const intents = Object.entries(AMANDA_INTENTS)
        .filter(([intentName]) => intentName !== 'default')
        .map(([intentName, intentData]) => {
            const matchScore = calculateMatchScore(message, intentData.patterns);
            return { intentName, matchScore, intentData };
        })
        .filter(result => result.matchScore > 0)
        .sort((a, b) => b.matchScore - a.matchScore);

    // Retorna a intenção com maior score, ou default
    if (intents.length > 0 && intents[0].matchScore >= 0.3) {
        return intents[0];
    }

    return {
        intentName: 'default',
        matchScore: 1,
        intentData: AMANDA_INTENTS.default
    };
}

/**
 * Calcula score de match baseado nos padrões
 */
function calculateMatchScore(message, patterns) {
    let maxScore = 0;

    patterns.forEach(pattern => {
        if (pattern.test(message)) {
            // Score base + bônus por padrões mais específicos
            let score = 0.5;

            // Bônus por match exato
            if (message === pattern.source.replace(/^\/|\/i$/g, '')) {
                score += 0.3;
            }

            // Bônus por padrões mais longos (mais específicos)
            if (pattern.source.length > 20) {
                score += 0.2;
            }

            maxScore = Math.max(maxScore, score);
        }
    });

    return maxScore;
}

/**
 * Obtém resposta aleatória para uma intenção
 */
export function getIntentResponse(intentName) {
    const intent = AMANDA_INTENTS[intentName] || AMANDA_INTENTS.default;
    const responses = intent.responses;
    const randomIndex = Math.floor(Math.random() * responses.length);
    return responses[randomIndex];
}

/**
 * Processa mensagem e retorna resposta do sistema de intenções
 */
export function processWithIntents(userMessage) {
    const match = findMatchingIntent(userMessage);
    const response = getIntentResponse(match.intentName);

    return {
        intent: match.intentName,
        confidence: match.matchScore,
        response: response,
        source: 'intents_fallback'
    };
}

/* =========================================================================
   INTEGRAÇÃO COM O SISTEMA EXISTENTE
   ========================================================================= */

/**
 * Função principal para uso no serviço - decide se usa IA ou fallback
 */
export function getAmandaResponse(userMessage, useAIFallback = true) {
    // Tenta primeiro o sistema de intenções
    const intentResult = processWithIntents(userMessage);

    // Se confiança alta (>0.7) ou fallback forçado, usa intenções
    if (!useAIFallback || intentResult.confidence > 0.7) {
        return {
            message: intentResult.response,
            source: intentResult.source,
            intent: intentResult.intent,
            confidence: intentResult.confidence
        };
    }

    // Caso contrário, retorna null para usar a IA principal
    return null;
}

/* =========================================================================
   ESTATÍSTICAS DE USO (opcional para analytics)
   ========================================================================= */
export const intentStats = {
    usageCount: {},

    recordUsage(intentName) {
        this.usageCount[intentName] = (this.usageCount[intentName] || 0) + 1;
    },

    getStats() {
        return this.usageCount;
    },

    getMostUsedIntents(limit = 5) {
        return Object.entries(this.usageCount)
            .sort(([, a], [, b]) => b - a)
            .slice(0, limit)
            .map(([intent, count]) => ({ intent, count }));
    }
};


