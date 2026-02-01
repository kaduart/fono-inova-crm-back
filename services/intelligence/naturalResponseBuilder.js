/**
 * Natural Response Builder
 * 
 * Gera respostas humanizadas e empáticas para a Amanda.
 * Prioriza acolhimento antes de fazer perguntas.
 * Substitui respostas robóticas por mensagens naturais e calorosas.
 */

// Templates de acolhimento - SEMPRE vêm antes de perguntas
const ACOLHIMENTO_TEMPLATES = [
    "Entendo como você deve estar...",
    "Sinto muito que estejam passando por isso...",
    "Deve ser muito difícil lidar com isso...",
    "Compreendo a preocupação de vocês...",
    "É natural se preocupar com isso...",
    "Imagino o quanto isso deve pesar...",
];

// Templates de respostas para diferentes intenções
const QUESTION_TEMPLATES = {
    ask_age: [
        "Qual a idade da criança? Isso ajuda a entender melhor como podemos apoiar vocês 💚",
        "Para me orientar melhor, qual a idade da pequena? 💚",
        "Me conta: quantos anos ela tem? Assim posso indicar o melhor caminho 💚",
        "Qual a idade dela? Quero entender o contexto para ajudar da melhor forma 💚",
        "Quantos anos a criança tem? Isso faz diferença no tipo de apoio 💚",
    ],
    ask_period: [
        "Qual período funciona melhor para vocês: manhã ou tarde? 💚",
        "Vocês preferem pela manhã ou à tarde? 💚",
        "Qual horário é mais conveniente: manhã ou tarde? 💚",
        "Funciona melhor de manhã ou à tarde? 💚",
    ],
    ask_therapy: [
        "Qual área de terapia está buscando? (fonoaudiologia, psicologia, etc) 💚",
        "Me conta: qual tipo de acompanhamento precisa? 💚",
        "Está procurando qual especialidade? 💚",
    ],
    ask_complaint: [
        "Qual a principal dificuldade ou preocupação que estão enfrentando? 💚",
        "Me conta um pouco mais sobre o que está acontecendo... 💚",
        "O que motivou vocês a buscar ajuda agora? 💚",
        "Qual a situação que está preocupando vocês? 💚",
    ],
    ask_patient_name: [
        "Qual o nome completo do paciente? 💚",
        "Pode me passar o nome completo da criança? 💚",
        "Como é o nome completo dela? 💚",
    ],
    ask_birthdate: [
        "Qual a data de nascimento? (dd/mm/aaaa) 💚",
        "Agora a data de nascimento no formato dd/mm/aaaa, por favor 💚",
        "Me passa a data de nascimento (dd/mm/aaaa)? 💚",
    ],
    ask_slot_selection: [
        "Qual desses horários funciona melhor para vocês? 💚",
        "Alguma dessas opções serve? 💚",
        "Qual funciona melhor? 💚",
    ],
    confirm_booking: [
        "Vamos confirmar:\n\n✅ {{patientName}}\n✅ {{slotText}}\n\nTudo certo? 💚",
        "Perfeito! Só confirmando:\n\n👤 {{patientName}}\n📅 {{slotText}}\n\nEstá correto? 💚",
        "Show! Vamos confirmar:\n\n✅ {{patientName}}\n✅ {{slotText}}\n\nTudo ok? 💚",
    ],
    confirm_booking_final: [
        "Agendamento confirmado! 🎉\n\n📅 {{slotText}}\n👤 {{patientName}}\n\nVocês vão adorar! Qualquer dúvida é só chamar 💚",
        "Tudo certo! 🎉\n\n📅 {{slotText}}\n👤 {{patientName}}\n\nEstamos aqui para o que precisarem 💚",
        "Confirmado! 🎉\n\n📅 {{slotText}}\n👤 {{patientName}}\n\nVai ser ótimo! 💚",
    ],
    show_slots: [
        "Encontrei essas opções:\n\n{{slotsText}}\n\nQual funciona melhor? 💚",
        "Temos esses horários:\n\n{{slotsText}}\n\nAlgum serve? 💚",
        "Aqui estão as opções disponíveis:\n\n{{slotsText}}\n\nQual prefere? 💚",
    ],
    acknowledge_pain: [
        "Entendo perfeitamente... 💚 Isso realmente preocupa. Vamos encontrar a melhor forma de ajudar.",
        "Sinto muito que estejam passando por isso... 💚 Mas buscar ajuda já é um grande passo!",
        "Compreendo a preocupação... 💚 Vamos juntos encontrar o melhor caminho para {{patientName}}.",
    ],
};

/**
 * Seleciona um item aleatório de um array
 */
function pickRandom(arr) {
    if (!arr || arr.length === 0) return '';
    return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Detecta estado emocional baseado no texto
 */
function detectEmotionalState(text = '') {
    const anxietyWords = /preocup|ansios|desesper|urgente|muito mal|piorando|não aguento|desesperada/i;
    const sadnessWords = /triste|chorando|sofrimento|sofr|angústi|depress/i;
    
    return {
        isAnxious: anxietyWords.test(text),
        isSad: sadnessWords.test(text),
    };
}

/**
 * Substitui variáveis no template
 */
function interpolate(template, context = {}) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return context[key] !== undefined ? context[key] : match;
    });
}

/**
 * Constrói uma resposta humanizada baseada na intenção e contexto
 */
export function buildResponse(intent, context = {}) {
    const { emotionalState, userText, patientName, therapyArea } = context;
    
    // Detecta se o usuário expressou dor/queixa
    const hasComplaint = /dificuldade|problema|preocup|nao fala|atraso|nao anda|nao come|transtorn|síndrome|autismo|tdah/i.test(userText || '');
    
    // Detecta estado emocional do texto
    const detectedEmotion = detectEmotionalState(userText);
    const isAnxious = emotionalState?.isAnxious || detectedEmotion.isAnxious;
    const isSad = emotionalState?.isSad || detectedEmotion.isSad;
    
    // Acolhimento primeiro se detectou queixa ou estado emocional
    if ((hasComplaint || isAnxious || isSad) && intent !== 'acknowledge_pain') {
        const ack = pickRandom(ACOLHIMENTO_TEMPLATES);
        const templates = QUESTION_TEMPLATES[intent];
        if (templates) {
            const question = interpolate(pickRandom(templates), context);
            return `${ack} ${question}`;
        }
    }
    
    // Prefixo emocional se necessário
    const prefix = isAnxious ? 'Respira... 🌸 ' : '';
    
    // Template normal
    const templates = QUESTION_TEMPLATES[intent];
    if (templates) {
        const question = interpolate(pickRandom(templates), context);
        return `${prefix}${question}`;
    }
    
    // Fallback
    return `${prefix}Como posso ajudar? 💚`;
}

/**
 * Gera resposta de follow-up inteligente
 */
export function buildFollowUp(context = {}) {
    const { lastTopic, userName, attempts = 0 } = context;
    
    if (attempts === 0) {
        return pickRandom([
            userName ? `${userName}, consegue me responder? 💚` : "Consegue me responder? 💚",
            "Estou aqui quando puder responder 💚",
            "Sem pressa! Estou aqui 💚",
        ]);
    }
    
    return pickRandom([
        "Ainda estou por aqui quando precisar 💚",
        "Estou aqui para ajudar quando quiser continuar 💚",
        "Qualquer dúvida é só chamar 💚",
    ]);
}

export default {
    buildResponse,
    buildFollowUp,
    ACOLHIMENTO_TEMPLATES,
    QUESTION_TEMPLATES,
};
