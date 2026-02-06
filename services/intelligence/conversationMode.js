/**
 * 🎭 CONVERSATION MODE MANAGER (Amanda 4.2)
 * =========================================
 * 
 * Alterna personalidade da Amanda baseada no intent score:
 * - closing: Foco em converter (score >= 75)
 * - warming: Construindo valor (40-74)
 * - discovery: Explorando necessidades (< 40)
 */

// Thresholds de modo
const MODE_THRESHOLDS = {
    CLOSING: 75,
    WARMING: 40
};

// Configurações de cada modo
const MODE_CONFIG = {
    closing: {
        name: 'closing',
        label: 'Modo Fechamento',
        tone: 'assertive_confident',
        maxLength: 150,        // Mensagens curtas e diretas
        maxQuestions: 1,       // Poucas perguntas
        urgencyLevel: 'high',
        behaviors: {
            offerSpecificSlots: true,
            askForCommitment: true,
            minimizeExplanations: true,
            createScarcity: true,
            assumePositive: true
        },
        avoid: [
            'long_explanations',
            'multiple_questions',
            'educational_content',
            'price_focus'
        ],
        ctas: [
            'Posso confirmar esse horário para você? 💚',
            'Quer que eu reserve agora?',
            'Tenho {slot1} ou {slot2}, qual prefere?',
            'Vamos fechar esse horário?'
        ]
    },
    
    warming: {
        name: 'warming',
        label: 'Modo Aquecimento',
        tone: 'helpful_guiding',
        maxLength: 250,
        maxQuestions: 2,
        urgencyLevel: 'medium',
        behaviors: {
            buildValue: true,
            addressConcerns: true,
            showSocialProof: true,
            offerSoftCTA: true,
            educateLightly: true
        },
        avoid: [
            'pushing_too_hard',
            'ignoring_objections'
        ],
        ctas: [
            'Quer que eu verifique a disponibilidade para essa semana?',
            'Posso mostrar os horários disponíveis? 💚',
            'Faz sentido para vocês?',
            'Quer conhecer a clínica?'
        ]
    },
    
    discovery: {
        name: 'discovery',
        label: 'Modo Descoberta',
        tone: 'warm_nurturing',
        maxLength: 300,
        maxQuestions: 3,
        urgencyLevel: 'low',
        behaviors: {
            askOpenQuestions: true,
            listenActively: true,
            educate: true,
            buildRapport: true,
            noPressure: true
        },
        avoid: [
            'pushing_for_sale',
            'talking_price_too_early',
            'asking_for_commitment'
        ],
        ctas: [
            'Me conta um pouco sobre {patientName}? 💚',
            'Qual a principal preocupação de vocês?',
            'Como posso ajudar melhor?',
            'Quer saber mais sobre como funciona?'
        ]
    }
};

/**
 * 🎭 Determina modo baseado no score
 * @param {number} score - Intent score
 * @param {string} trend - Tendência (up/down/stable)
 * @returns {string} Modo: closing | warming | discovery
 */
export function determineMode(score, trend = 'stable') {
    // Closing: score alto OU subindo rápido para alto
    if (score >= MODE_THRESHOLDS.CLOSING || (score >= 60 && trend === 'up')) {
        return 'closing';
    }
    
    // Warming: score médio ou subindo
    if (score >= MODE_THRESHOLDS.WARMING || trend === 'up') {
        return 'warming';
    }
    
    // Discovery: score baixo
    return 'discovery';
}

/**
 * ⚙️ Retorna configuração completa do modo
 * @param {string} mode - Nome do modo
 * @returns {Object} Configuração
 */
export function getModeConfig(mode) {
    return MODE_CONFIG[mode] || MODE_CONFIG.discovery;
}

/**
 * 📝 Gera instrução de sistema para o modo
 * @param {string} mode - Modo atual
 * @param {Object} context - Contexto do lead
 * @returns {string} Instrução para IA
 */
export function buildModeInstruction(mode, context = {}) {
    const config = getModeConfig(mode);
    const { patientName, patientAge, therapyArea } = context;
    
    const instructions = {
        closing: `
🎯 MODO FECHAMENTO ATIVADO (Score: ${context.score || 'alto'})

Você é uma closer experiente. O lead já demonstrou alta intenção de agendar.

REGRAS:
• Seja OBJETIVA - máximo ${config.maxLength} caracteres
• Ofereça horários ESPECÍFICOS, não genéricos
• Faça PERGUNTAS FECHADAS (sim/não ou escolha A/B)
• Assuma o SIM - "Vou reservar" em vez de "Quer reservar?"
• Crie leve escassez - "Tenho só esses horários"
• EVITE: explicações longas, múltiplas perguntas, histórias

CTAs sugeridos:
${config.ctas.join('\n')}

Exemplo:
❌ "Temos vários horários disponíveis durante a semana, quando você prefere?"
✅ "Tenho terça 14h ou quarta 9h. Qual funciona? 💚"
`,

        warming: `
🔥 MODO AQUECIMENTO (Score: médio)

O lead está interessado mas precisa de mais valor/confiabilidade.

REGRAS:
• Construa VALOR antes de pedir compromisso
• Mostre PROVA SOCIAL ("muitos pais...")
• Endosse OBJEÇÕES leves ("entendo que é um investimento...")
• Ofereça CTA suave - ver disponibilidade, conhecer clínica
• Use tom de consultora, não vendedora

CTAs sugeridos:
${config.ctas.join('\n')}
`,

        discovery: `
💚 MODO DESCOBERTA (Score: baixo/médio)

O lead está explorando. Acolha e qualifique sem pressão.

REGRAS:
• ACOLHA primeiro - valide emoções
• Faça PERGUNTAS ABERTAS para entender
• EDUQUE levemente sobre a terapia
• NÃO fale de preço ainda (a menos que perguntem)
• NÃO peça compromisso, peça CONVERSA
• Seja a mais gentil possível

CTAs sugeridos:
${config.ctas.join('\n')}
`
    };
    
    return instructions[mode] || instructions.discovery;
}

/**
 * 🔧 Aplica restrições do modo à resposta
 * @param {string} text - Texto original
 * @param {string} mode - Modo atual
 * @returns {string} Texto ajustado
 */
export function applyModeConstraints(text, mode) {
    const config = getModeConfig(mode);
    
    // Limita tamanho
    if (text.length > config.maxLength) {
        // Tenta cortar em ponto natural
        const cutPoint = text.lastIndexOf('.', config.maxLength);
        if (cutPoint > config.maxLength * 0.7) {
            text = text.substring(0, cutPoint + 1);
        } else {
            text = text.substring(0, config.maxLength) + '...';
        }
    }
    
    // Conta perguntas
    const questionCount = (text.match(/\?/g) || []).length;
    if (questionCount > config.maxQuestions) {
        // Remove perguntas extras (mantém as primeiras)
        const parts = text.split('?');
        text = parts.slice(0, config.maxQuestions).join('?') + '?';
    }
    
    return text;
}

/**
 * 🎨 Seleciona CTA apropriada para o modo
 * @param {string} mode - Modo atual
 * @param {Object} context - Contexto (slots disponíveis, etc)
 * @returns {string} CTA formatada
 */
export function selectCTA(mode, context = {}) {
    const config = getModeConfig(mode);
    const ctas = config.ctas;
    
    // Seleciona aleatoriamente ou baseado no contexto
    let selected = ctas[Math.floor(Math.random() * ctas.length)];
    
    // Substitui placeholders
    if (context.slots && context.slots.length >= 2) {
        selected = selected
            .replace('{slot1}', context.slots[0])
            .replace('{slot2}', context.slots[1]);
    }
    
    if (context.patientName) {
        selected = selected.replace(/{patientName}/g, context.patientName);
    }
    
    return selected;
}

/**
 * 📊 Detecta transição de modo
 * @param {string} previousMode - Modo anterior
 * @param {string} currentMode - Modo atual
 * @returns {Object} Info da transição
 */
export function detectModeTransition(previousMode, currentMode) {
    if (previousMode === currentMode) {
        return { changed: false, direction: null };
    }
    
    const hierarchy = { discovery: 1, warming: 2, closing: 3 };
    const direction = hierarchy[currentMode] > hierarchy[previousMode] ? 'escalation' : 'deescalation';
    
    return {
        changed: true,
        from: previousMode,
        to: currentMode,
        direction,
        isPositive: direction === 'escalation'
    };
}

/**
 * 💾 Prepara dados do modo para salvar
 * @param {Object} lead - Lead
 * @param {string} mode - Modo atual
 * @param {number} score - Score
 * @returns {Object} Dados para update
 */
export function prepareModeForSave(lead, mode, score) {
    const previousMode = lead?.qualificationData?.conversationMode || 'discovery';
    const transition = detectModeTransition(previousMode, mode);
    
    const update = {
        'qualificationData.conversationMode': mode,
        'qualificationData.modeScore': score,
        'qualificationData.modeUpdatedAt': new Date()
    };
    
    // Se houve transição positiva, registra
    if (transition.changed && transition.isPositive) {
        update['$push'] = {
            'qualificationData.modeTransitions': {
                from: transition.from,
                to: transition.to,
                score,
                at: new Date()
            }
        };
    }
    
    return update;
}

export default {
    determineMode,
    getModeConfig,
    buildModeInstruction,
    applyModeConstraints,
    selectCTA,
    detectModeTransition,
    prepareModeForSave,
    MODE_THRESHOLDS,
    MODE_CONFIG
};
