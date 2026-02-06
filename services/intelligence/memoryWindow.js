/**
 * 🪟 MEMORY WINDOW (Amanda 4.2)
 * =============================
 * 
 * Mantém as últimas 5 mensagens relevantes para contexto.
 * Não deixa Amanda esquecer informações importantes.
 */

// Tamanho da janela de memória
const WINDOW_SIZE = 5;

// Tipos de informação que consideramos relevantes
const RELEVANT_TYPES = [
    'child_age',
    'child_name', 
    'complaint',
    'therapy_area',
    'preferred_time',
    'preferred_day',
    'urgency_level',
    'emotional_state',
    'price_sensitivity',
    'insurance',
    'schedule_intent'
];

/**
 * 🧠 Extrai informações relevantes de uma mensagem
 * @param {string} message - Texto da mensagem
 * @param {Object} extractedInfo - Info extraída pela IA
 * @returns {Array} Lista de fatos relevantes
 */
export function extractRelevantFacts(message, extractedInfo = {}) {
    const facts = [];
    
    if (!message) return facts;
    
    const text = message.toLowerCase();
    
    // Idade
    const ageMatch = text.match(/(\d+)\s*(anos?|aninhos?)/i);
    if (ageMatch) {
        facts.push({
            type: 'child_age',
            value: parseInt(ageMatch[1]),
            confidence: 'high'
        });
    }
    
    // Nome (padrões comuns)
    const namePatterns = [
        /(?:meu filho|minha filha|o|a)\s+(\w+)(?:\s+tem|\s+está|\s+não)/i,
        /chama\s+(\w+)/i,
        /nome\s+(?:dele|dela|é|eh)\s+(\w+)/i
    ];
    
    for (const pattern of namePatterns) {
        const match = text.match(pattern);
        if (match && match[1].length > 2 && !match[1].match(/^(ele|ela|tem|anos)$/i)) {
            facts.push({
                type: 'child_name',
                value: match[1],
                confidence: 'medium'
            });
            break;
        }
    }
    
    // Queixa/Problema
    const complaintPatterns = [
        { pattern: /não\s+fala|atraso\s+na\s+fala|demora\s+pra\s+falar/i, value: 'speech_delay' },
        { pattern: /não\s+anda|atraso\s+motor/i, value: 'motor_delay' },
        { pattern: /comportamento|agressivo|birra/i, value: 'behavioral' },
        { pattern: /tea|autismo|espectro/i, value: 'autism' },
        { pattern: /tdah|hiperatividade|dificuldade\s+atenção/i, value: 'adhd' },
        { pattern: /dislexia|dificuldade\s+ler/i, value: 'dyslexia' }
    ];
    
    for (const { pattern, value } of complaintPatterns) {
        if (pattern.test(text)) {
            facts.push({
                type: 'complaint',
                value,
                confidence: 'high'
            });
            break;
        }
    }
    
    // Preferência de horário
    const timePatterns = [
        { pattern: /manh[ãa]|cedo|8h|9h|10h|11h/i, value: 'morning' },
        { pattern: /tarde|depois\s+do\s+almo[çc]o|14h|15h|16h|17h|18h/i, value: 'afternoon' },
        { pattern: /noite|depois\s+do\s+trabalho|19h|20h/i, value: 'evening' }
    ];
    
    for (const { pattern, value } of timePatterns) {
        if (pattern.test(text)) {
            facts.push({
                type: 'preferred_time',
                value,
                confidence: 'medium'
            });
            break;
        }
    }
    
    // Preferência de dia
    const dayPatterns = [
        { pattern: /segunda/i, value: 'monday' },
        { pattern: /ter[çc]a/i, value: 'tuesday' },
        { pattern: /quarta/i, value: 'wednesday' },
        { pattern: /quinta/i, value: 'thursday' },
        { pattern: /sexta/i, value: 'friday' },
        { pattern: /s[áa]bado/i, value: 'saturday' }
    ];
    
    for (const { pattern, value } of dayPatterns) {
        if (pattern.test(text)) {
            facts.push({
                type: 'preferred_day',
                value,
                confidence: 'high'
            });
            break;
        }
    }
    
    // Urgência
    if (/urgente|preciso\s+logo|desesperad|emergência/i.test(text)) {
        facts.push({
            type: 'urgency_level',
            value: 'high',
            confidence: 'high'
        });
    } else if (/logo|essa\s+semana|pr[oó]xima\s+semana/i.test(text)) {
        facts.push({
            type: 'urgency_level',
            value: 'medium',
            confidence: 'medium'
        });
    }
    
    // Estado emocional
    if (/ansiosa|preocupada|desesperada|chorando/i.test(text)) {
        facts.push({
            type: 'emotional_state',
            value: 'worried',
            confidence: 'high'
        });
    } else if (/calma|tranquila|esperan[çc]osa/i.test(text)) {
        facts.push({
            type: 'emotional_state',
            value: 'hopeful',
            confidence: 'medium'
        });
    }
    
    // Sensibilidade a preço
    if (/caro|não\s+tenho\s+condi[cç][õo]es|barato|desconto/i.test(text)) {
        facts.push({
            type: 'price_sensitivity',
            value: 'high',
            confidence: 'medium'
        });
    }
    
    // Intenção de agendar
    if (/quero\s+agendar|vamos\s+marcar|pode\s+marcar|quero\s+marcar/i.test(text)) {
        facts.push({
            type: 'schedule_intent',
            value: 'explicit',
            confidence: 'high'
        });
    }
    
    // Mescla com info extraída pela IA (tem prioridade)
    if (extractedInfo.patientAge && !facts.find(f => f.type === 'child_age')) {
        facts.push({
            type: 'child_age',
            value: extractedInfo.patientAge,
            confidence: 'high',
            source: 'ai_extraction'
        });
    }
    
    if (extractedInfo.patientName && !facts.find(f => f.type === 'child_name')) {
        facts.push({
            type: 'child_name',
            value: extractedInfo.patientName,
            confidence: 'high',
            source: 'ai_extraction'
        });
    }
    
    return facts;
}

/**
 * 📝 Atualiza janela de memória com novos fatos
 * @param {Array} currentWindow - Janela atual
 * @param {Array} newFacts - Novos fatos extraídos
 * @returns {Array} Janela atualizada
 */
export function updateMemoryWindow(currentWindow = [], newFacts = []) {
    // Remove duplicados do mesmo tipo (mantém o mais recente)
    const filteredWindow = currentWindow.filter(item => 
        !newFacts.find(newFact => newFact.type === item.type)
    );
    
    // Adiciona novos fatos com timestamp
    const enrichedNewFacts = newFacts.map(fact => ({
        ...fact,
        timestamp: new Date(),
        id: `${fact.type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    }));
    
    // Combina e limita ao tamanho da janela
    const combined = [...filteredWindow, ...enrichedNewFacts];
    
    // Ordena por prioridade (urgência e nome têm prioridade)
    const priorityOrder = ['urgency_level', 'child_name', 'child_age', 'schedule_intent', 'complaint'];
    combined.sort((a, b) => {
        const priorityA = priorityOrder.indexOf(a.type);
        const priorityB = priorityOrder.indexOf(b.type);
        if (priorityA !== priorityB) return priorityA - priorityB;
        return new Date(b.timestamp) - new Date(a.timestamp);
    });
    
    return combined.slice(0, WINDOW_SIZE);
}

/**
 * 🔍 Busca informação específica na janela de memória
 * @param {Array} window - Janela de memória
 * @param {string} type - Tipo de informação
 * @returns {Object|null} Fato encontrado ou null
 */
export function recallFromWindow(window = [], type) {
    return window.find(item => item.type === type) || null;
}

/**
 * 📝 Formata janela de memória para uso no prompt
 * @param {Array} window - Janela de memória
 * @returns {string} Texto formatado
 */
export function formatMemoryForPrompt(window = []) {
    if (window.length === 0) return '';
    
    const labels = {
        child_age: idade => `criança de ${idade.value} anos`,
        child_name: nome => `nome: ${nome.value}`,
        complaint: queixa => `situação: ${queixa.value}`,
        preferred_time: horario => `prefere ${horario.value === 'morning' ? 'manhã' : horario.value === 'afternoon' ? 'tarde' : 'noite'}`,
        preferred_day: dia => `prefere ${dia.value}`,
        urgency_level: urg => urg.value === 'high' ? 'URGÊNCIA ALTA' : 'urgência média',
        emotional_state: emo => emo.value === 'worried' ? 'mãe preocupada' : 'mãe tranquila',
        schedule_intent: () => 'quer agendar'
    };
    
    const parts = window
        .filter(item => labels[item.type])
        .map(item => labels[item.type](item));
    
    if (parts.length === 0) return '';
    
    return `Contexto: ${parts.join(', ')}.`;
}

/**
 * 💾 Prepara dados de memória para salvar no lead
 * @param {Object} lead - Lead atual
 * @param {string} message - Mensagem do usuário
 * @param {Object} extractedInfo - Info extraída pela IA
 * @returns {Object} Dados para atualizar
 */
export function prepareMemoryForSave(lead, message, extractedInfo = {}) {
    const currentWindow = lead?.qualificationData?.memoryWindow || [];
    const newFacts = extractRelevantFacts(message, extractedInfo);
    const updatedWindow = updateMemoryWindow(currentWindow, newFacts);
    
    return {
        'qualificationData.memoryWindow': updatedWindow,
        'qualificationData.memorySummary': formatMemoryForPrompt(updatedWindow)
    };
}

export default {
    extractRelevantFacts,
    updateMemoryWindow,
    recallFromWindow,
    formatMemoryForPrompt,
    prepareMemoryForSave,
    WINDOW_SIZE,
    RELEVANT_TYPES
};
