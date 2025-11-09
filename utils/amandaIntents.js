// /src/utils/amandaIntents.js
/* =========================================================================
   AMANDA INTENTS + MANUAL (integrado)
   Sistema de Fallback Local com respostas canônicas
   ========================================================================= */

import { normalizeTherapyTerms } from './therapyDetector.js';

/* =========================================================================
   MANUAL_AMANDA (o que você me enviou) + helper getManual
   ========================================================================= */
export const MANUAL_AMANDA = {
    "saudacao": "Olá! Tudo bem? 😊 Sou a Amanda, da Clínica Fono Inova. Fico muito feliz pelo seu contato! Como posso ajudar você e seu(ua) pequeno(a) hoje?",

    "fonoaudiologia": {
        "atraso_fala": "Oi! Que bom que você está atenta ao desenvolvimento do seu bebê! 💙 Com 2 anos, esperamos que as crianças já formem frases simples com 2-3 palavras. A ausência de fala pode ser um sinal importante para investigarmos. Nossas fonoaudiólogas são especializadas em estimulação precoce. Gostaria de agendar uma avaliação?",

        "troca_letras": "Que olhar atento você tem! 👏 Essas trocas são comuns em determinadas fases, mas quando persistem podem precisar de atenção. Nossas fonoaudiólogas trabalham com consciência fonológica através de jogos e atividades lúdicas. Vamos agendar uma avaliação?",

        "gagueira": "Oi, amor! É tão comum as famílias se preocuparem com a gagueira! 💙 A gagueira do desenvolvimento é muito frequente entre 2-5 anos. Trabalhamos com abordagem de fluência baseada em evidências. Que tal agendarmos uma conversa com nossa fono especialista?"
    },

    "psicologia": {
        "tdah": "Oi, querida! É natural se sentir assim quando a escola traz essas observações. 💙 O TDAH é uma condição neurobiológica. Aqui fazemos uma avaliação completa com entrevista detalhada, observação lúdica e instrumentos validados. Nossas psicólogas usam Terapia Cognitivo-Comportamental adaptada para crianças!",

        "dificuldade_emocional": "Oi, amor! Nossos pequenos sentem as emoções com tanta intensidade, não é? 💙 Aqui usamos a ludoterapia - terapia através do brincar - que permite à criança expressar sentimentos. Estamos aqui para acolher seu coraçãozinho!"
    },

    "neuropsicologia": {
        "avaliacao": "Que pergunta importante! 💙 A avaliação neuropsicológica é como um 'mapa do cérebro' da criança - avaliamos funções como atenção, memória, raciocínio e linguagem. O processo inclui entrevistas, sessões com a criança e laudo detalhado. É fundamental para identificar TEA, TDAH e dificuldades de aprendizagem."
    },

    "psicopedagogia": {
        "dificuldade_escolar": "Oi! Ver nosso filho com dificuldade na escola é realmente preocupante. 💙 Nossa psicopedagoga faz uma avaliação completa para entender como a criança processa informações e aprende. Trabalhamos com intervenções baseadas em ciência cognitica!"
    },

    "terapia_ocupacional": {
        "o_que_faz": "Que pergunta importante! 💙 A terapia ocupacional ajuda as crianças a desenvolverem habilidades para o dia a dia - desde segurar um lápis até amarrar o tênis! Trabalhamos com coordenação motora, integração sensorial e habilidades sociais."
    },

    "fisioterapia": {
        "quando_precisa": "A fisioterapia pediátrica vai muito além do que imaginamos! 💙 Trabalhamos com estimulação precoce, desenvolvimento motor, coordenação e muito mais. Para bebês e crianças com atraso motor, a intervenção precoce faz toda diferença!"
    },

    "musicoterapia": {
        "o_que_e": "A musicoterapia é uma ferramenta maravilhosa! 💙 Através da música, trabalhamos comunicação, regulação emocional e habilidades sociais - e a criança não precisa saber música! É sobre se expressar e se desenvolver de forma natural."
    },

    "valores": {
        "consulta": "Entendo perfeitamente! 💙 Temos opções acessíveis: Avaliação inicial: R$220 | Sessões: R$200 avulsa ou R$720/mês (4 sessões) | Avaliação neuropsicológica: a partir de R$2.300. Aceitamos cartão em até 6x, PIX e dinheiro!"
    },

    "planos_saude": {
        "unimed": "Estamos em processo de credenciamento com os principais planos! 💙 Enquanto isso, atendemos particular mas emitimos nota fiscal para reembolso e temos condições especiais. O importante é não postergar o cuidado do seu pequeno!"
    },

    "localizacao": {
        "endereco": "Ficamos na Av. Minas Gerais, 405 - Jundiaí, Anápolis! 🗺️ Temos estacionamento gratuito, acesso fácil e um ambiente totalmente preparado para receber crianças com todo conforto e carinho! 💙"
    },

    "agendamento": {
        "info_necessarias": "Perfeito! Vou ajudar com o agendamento! 💙 Preciso de: Nome e idade da criança | Seu telefone | Principal queixa/objetivo. Lembre-se: buscar ajuda é demonstração de amor! 😊"
    },

    "despedida": "Foi um prazer conversar com você! Nossa equipe está aqui para acolhê-los com todo carinho e profissionalismo. Qualquer outra dúvida, estou à disposição! Tenha um dia abençoado! 💙",

    "situacoes_especiais": {
        "pais_angustiados": "Oi, querida! Sinto que você está bem preocupada... É completamente compreensível! 💙 Nossos filhos são nosso mundo! Mas saiba que você não está sozinha. Estamos aqui para caminhar junto com vocês!",

        "duvidas_diagnostico": "Entendo sua cautela! 💙 O diagnóstico é um processo cuidadoso. Nosso foco é compreender seu filho para podermos ajudá-lo da melhor forma possível!",

        "urgencias": "Oi! Entendo a urgência! 💙 Para casos que precisam de atenção imediata, temos horários reservados. Vou verificar nossa agenda e te retorno rapidamente!"
    }
};

export function getManual(cat, sub) {
    if (!cat) return null;
    const node = MANUAL_AMANDA?.[cat];
    if (!node) return null;
    if (sub && typeof node === 'object') return node[sub] ?? null;
    return typeof node === 'string' ? node : null;
}

/* =========================================================================
   Helpers
   ========================================================================= */
const ensureSingleHeartAtEnd = (text = "") => {
    const cleaned = String(text).replace(/💚/g, "").trim();
    return `${cleaned} 💚`;
};

/* =========================================================================
   Mapa: intenção → (categoria/sub) do MANUAL_AMANDA
   ========================================================================= */
const INTENT_TO_MANUAL = {
    greeting: { cat: 'saudacao' },
    goodbye: { cat: 'despedida' },

    price_evaluation: { cat: 'valores', sub: 'consulta' },
    health_plans: { cat: 'planos_saude', sub: 'unimed' },
    address: { cat: 'localizacao', sub: 'endereco' },
    scheduling: { cat: 'agendamento', sub: 'info_necessarias' },

    neuropsychological: { cat: 'neuropsicologia', sub: 'avaliacao' },
    speech_delay: { cat: 'fonoaudiologia', sub: 'atraso_fala' },
    speech_stutter: { cat: 'fonoaudiologia', sub: 'gagueira' },
    speech_letters: { cat: 'fonoaudiologia', sub: 'troca_letras' },

    child_psychology: { cat: 'psicologia', sub: 'dificuldade_emocional' },

    parent_anxious: { cat: 'situacoes_especiais', sub: 'pais_angustiados' },
    diagnosis_doubt: { cat: 'situacoes_especiais', sub: 'duvidas_diagnostico' },
    urgency: { cat: 'situacoes_especiais', sub: 'urgencias' },
};

/* =========================================================================
   AMANDA INTENTS (fallback)
   ========================================================================= */
/* export const AMANDA_INTENTS = {
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

    default: {
        patterns: [/.],
        responses: [
            "Entendi! 💚 Pode me contar um pouco mais sobre o que precisa? Assim posso te ajudar melhor!",
            "Compreendo! 💚 Qual especialidade tem interesse? Fono, psicologia, terapia ocupacional?",
            "Obrigada pela mensagem! 💚 Pode me explicar qual é a queixa principal? Assim direciono para a profissional ideal!"
        ]
    }
}; */

/* =========================================================================
   Match de intenções
   ========================================================================= */
export function findMatchingIntent(userMessage) {
    const message = normalizeTherapyTerms(userMessage || "").toLowerCase().trim();

    const intents = Object.entries(AMANDA_INTENTS)
        .filter(([intentName]) => intentName !== 'default')
        .map(([intentName, intentData]) => {
            const matchScore = calculateMatchScore(message, intentData.patterns);
            return { intentName, matchScore, intentData };
        })
        .filter(result => result.matchScore > 0)
        .sort((a, b) => b.matchScore - a.matchScore);

    if (intents.length > 0 && intents[0].matchScore >= 0.3) {
        return intents[0];
    }

    return {
        intentName: 'default',
        matchScore: 1,
        intentData: AMANDA_INTENTS.default
    };
}

function calculateMatchScore(message, patterns) {
    let maxScore = 0;

    patterns.forEach(pattern => {
        if (pattern.global) pattern.lastIndex = 0;

        if (pattern.test(message)) {
            let score = 0.5;
            if (pattern.source.length > 20) score += 0.2;

            const firstToken = pattern.source.split('|')[0]?.replace(/[^\p{L}\p{N}]+/gu, '');
            if (firstToken && new RegExp(`^${firstToken}`, 'i').test(message)) score += 0.1;

            maxScore = Math.max(maxScore, score);
        }
    });

    return maxScore;
}

/* =========================================================================
   Resposta de intenção (prioriza o MANUAL)
   ========================================================================= */
export function getIntentResponse(intentName) {
    const link = INTENT_TO_MANUAL[intentName];
    if (link) {
        const manual = getManual(link.cat, link.sub);
        if (manual) return ensureSingleHeartAtEnd(manual);
    }

    const intent = AMANDA_INTENTS[intentName] || AMANDA_INTENTS.default;
    const responses = Array.isArray(intent?.responses) ? intent.responses : [];
    if (responses.length > 0) {
        const pick = responses[Math.floor(Math.random() * responses.length)];
        return ensureSingleHeartAtEnd(pick);
    }

    return ensureSingleHeartAtEnd("Posso te ajudar com mais detalhes?");
}

/* =========================================================================
   Facades
   ========================================================================= */
export function processWithIntents(userMessage) {
    const match = findMatchingIntent(userMessage);
    const response = getIntentResponse(match.intentName);

    return {
        intent: match.intentName,
        confidence: match.matchScore,
        response,
        source: 'intents_fallback'
    };
}

export function getAmandaResponse(userMessage, useAIFallback = true) {
    const intentResult = processWithIntents(userMessage);

    if (!useAIFallback || intentResult.confidence > 0.7) {
        return {
            message: intentResult.response,
            source: intentResult.source,
            intent: intentResult.intent,
            confidence: intentResult.confidence
        };
    }
    return null;
}
