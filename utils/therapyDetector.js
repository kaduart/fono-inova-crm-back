// NOVO ARQUIVO: src/utils/therapyDetector.js

export const THERAPY_SPECIALTIES = {
    neuropsychological: {
        names: ['neuropsicológica', 'neuropsicologia', 'avaliação conhecimento', 'laudo conhecimento', 'pular série', 'avançar série'],
        patterns: [
            /neuropsic(o|ol[oó]gic)/i,
            /psic[oó]log[oa].*(conhecimento|avalia|laudo)/i,
            /avalia.*conhecimento/i,
            /laudo.*conhecimento/i,
            /pular.*s[ée]rie/i,
            /avan[cç]ar.*s[ée]rie/i,
            /teste.*conhecimento/i
        ],
        description: "Avaliação neuropsicológica completa para laudo de conhecimento",
        price: "R$ 2.500,00 (10 sessões)",
        process: "10 sessões de 50min para mapear habilidades cognitivas"
    },

    speech: {
        names: ['fono', 'fonoaudiologia', 'gagueira', 'fala', 'linguagem'],
        patterns: [
            /fono(audiologia)?/i,
            /gaguej/i,
            /fala.*travando/i,
            /flu[eê]ncia/i,
            /dificuldade.*fala/i,
            /linguagem/i
        ],
        description: "Terapia para gagueira e desenvolvimento da fala",
        price: "Avaliação R$ 220,00 | Sessão R$ 220,00",
        process: "Avaliação + sessões personalizadas para fluência"
    },

    psychology: {
        names: ['psicologia', 'psicóloga', 'psicólogo', 'comportamento', 'emocional'],
        patterns: [
            /psic[oó]log[oa]/i,
            /comportamento/i,
            /emocional/i,
            /birra/i,
            /mania/i
        ],
        description: "Acompanhamento psicológico infantil/comportamental",
        price: "Avaliação R$ 220,00 | Sessão R$ 220,00",
        process: "Avaliação + sessões semanais"
    },

    psychopedagogy: {
        names: ['psicopedagogia', 'dificuldade aprendizagem', 'problema escola'],
        patterns: [
            /psicopedagog/i,
            /dificuldade.*aprendizagem/i,
            /problema.*escola/i,
            /rendimento.*escolar/i
        ],
        description: "Avaliação e intervenção em dificuldades de aprendizagem",
        price: "Anamnese R$ 200,00 | Sessão R$ 160,00",
        process: "Anamnese + sessões com estratégias pedagógicas"
    },

    occupational: {
        names: ['terapia ocupacional', 'to', 'integracao sensorial'],
        patterns: [
            /terapia.*ocupacional/i,
            /\bto\b/i,
            /integra[cç][aã]o.*sensorial/i,
            /avd/i
        ],
        description: "Terapia para desenvolvimento de habilidades funcionais",
        price: "Avaliação R$ 220,00 | Sessão R$ 220,00",
        process: "Avaliação + sessões de integração sensorial"
    },

    physiotherapy: {
        names: ['fisioterapia', 'fisio', 'motora'],
        patterns: [
            /fisioterapia/i,
            /fisio/i,
            /motora/i,
            /coordena[cç][aã]o/i
        ],
        description: "Terapia para desenvolvimento motor",
        price: "Avaliação R$ 220,00 | Sessão R$ 220,00",
        process: "Avaliação + sessões de desenvolvimento motor"
    },

    music: {
        names: ['musicoterapia', 'musica'],
        patterns: [
            /musicoterapia/i,
            /m[uú]sica.*terapia/i
        ],
        description: "Terapia através da música para desenvolvimento",
        price: "Avaliação R$ 220,00 | Sessão R$ 220,00",
        process: "Avaliação + sessões com intervenções musicais"
    },

    caa: {
        names: ['caa', 'comunicação alternativa'],
        patterns: [
            /\bcaa\b/i,
            /comunica[cç][aã]o.*alternativa/i,
            /n[aã]o.*verbal/i,
            /pecs/i
        ],
        description: "Comunicação alternativa para não-verbais",
        price: "Avaliação R$ 220,00 | Sessão R$ 220,00",
        process: "Avaliação + desenvolvimento de sistema de comunicação"
    }
};

/**
 * 🎯 CONHECIMENTO DE EQUIVALÊNCIAS - A Amanda SEMPRE sabe que são a mesma coisa
 */
export const THERAPY_EQUIVALENCIES = {
    neuropsychological: {
        primary_name: "avaliação neuropsicológica",
        equivalent_terms: [
            "avaliação para laudo de conhecimento",
            "avaliação de conhecimento",
            "laudo de conhecimento",
            "teste de conhecimento",
            "avaliação neuro psicologia",
            "neuro psicologia",
            "psicóloga que avalia conhecimento",
            "laudo para pular série",
            "avaliação para avançar série",
            "teste para pular série",
            "avaliação escolar",
            "laudo escolar"
        ],
        description: "Processo completo de 10 sessões para mapear habilidades cognitivas e emitir laudo",
        standard_response: "Avaliação neuropsicológica - 10 sessões de 50min para mapear atenção, memória, raciocínio e funções executivas. Ideal para casos de avanço de série e diagnóstico de dificuldades de aprendizagem."
    }
};

/**
 * 🎯 DETECTAR E UNIFICAR TERMOS EQUIVALENTES
 */
export function normalizeTherapyTerms(text = "") {
    let normalizedText = text.toLowerCase();

    // Substituir todos os termos equivalentes pelo termo primário
    Object.values(THERAPY_EQUIVALENCIES).forEach(equivalency => {
        equivalency.equivalent_terms.forEach(term => {
            const regex = new RegExp(term, 'gi');
            normalizedText = normalizedText.replace(regex, equivalency.primary_name);
        });
    });

    return normalizedText;
}

/**
 * 🎯 DETECTAR SE O PACIENTE ESTÁ PERGUNTANDO SOBRE EQUIVALÊNCIA
 */
export function isAskingAboutEquivalence(text = "") {
    const t = text.toLowerCase();
    const equivalencePatterns = [
        /(é|eh)\s+(a|a mesma)\s+(coisa|mesma)/i,
        /(são|sao)\s+(a mesma|a mesma coisa)/i,
        /(é|eh)\s+igual/i,
        /mesma\s+coisa/i,
        /significa\s+a\s+mesma/i,
        /são\s+ a\s+mesma/i,
        /sao\s+a\s+mesma/i,
        /são\s+o\s+mesmo/i,
        /sao\s+o\s+mesmo/i,
        /quer\s+dizer\s+a\s+mesma/i
    ];

    return equivalencePatterns.some(pattern => pattern.test(t));
}

/**
 * 🎯 RESPOSTA PADRÃO PARA EQUIVALÊNCIAS
 */
export function generateEquivalenceResponse(text = "") {
    const normalizedText = normalizeTherapyTerms(text);

    // Verificar se a pergunta é sobre neuropsicológica
    if (normalizedText.includes("avaliação neuropsicológica")) {
        return `Sim, é exatamente a mesma coisa! 💚 

"Avaliação para laudo de conhecimento", "avaliação neuropsicológica", "teste de conhecimento" - todos são o mesmo processo completo de 10 sessões para mapear habilidades cognitivas e emitir o laudo.

${THERAPY_EQUIVALENCIES.neuropsychological.standard_response}

Valor: R$ 2.500,00 (6x cartão) ou R$ 2.300,00 (à vista). Posso te explicar o passo a passo?`;
    }

    return "Sim, são a mesma coisa! 💚 Posso te explicar melhor como funciona?";
}



/**
 * 🎯 Detecta TODAS as terapias mencionadas em uma mensagem
 */
export function detectAllTherapies(text = "") {
    const detectedTherapies = [];
    const cleanText = text.toLowerCase();

    // Verificar cada especialidade
    Object.entries(THERAPY_SPECIALTIES).forEach(([key, therapy]) => {
        const hasMatch = therapy.patterns.some(pattern => pattern.test(cleanText));
        if (hasMatch) {
            detectedTherapies.push({
                id: key,
                ...therapy
            });
        }
    });

    return detectedTherapies;
}

/**
 * 🧠 Gera resposta inteligente para múltiplas terapias
 */
export function generateMultiTherapyResponse(therapies, userText = "") {
    const therapyCount = therapies.length;

    // 🚨 CASO: Frustração (não responde)
    if (/(não responde|nao responde|ainda não|demora|esperando)/i.test(userText)) {
        return generateFrustrationResponse(therapies);
    }

    // 🎯 CASO: 1 terapia
    if (therapyCount === 1) {
        return generateSingleTherapyResponse(therapies[0]);
    }

    // 🎯 CASO: 2 terapias (mais comum)
    if (therapyCount === 2) {
        return generateDualTherapyResponse(therapies);
    }

    // 🎯 CASO: 3+ terapias (pacote completo)
    if (therapyCount >= 3) {
        return generateMultiTherapyPackageResponse(therapies);
    }

    // Fallback
    return "Entendi sua mensagem! 💚 Pode me contar qual é a principal queixa para eu te direcionar para a profissional ideal?";
}