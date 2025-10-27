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
 * 🎯 DETECTAR E UNIFICAR TERMOS EQUIVALENTES
 */
export function normalizeTherapyTerms(text = "") {
    let normalizedText = text.toLowerCase();

    // 1️⃣ PRIMEIRO: Corrigir erros de digitação comuns
    Object.entries(TYPEO_CORRECTIONS).forEach(([wrong, correct]) => {
        const regex = new RegExp(wrong, 'gi');
        normalizedText = normalizedText.replace(regex, correct);
    });

    // 2️⃣ SEGUNDO: Substituir termos equivalentes pelo termo primário
    Object.values(THERAPY_EQUIVALENCIES).forEach(equivalency => {
        equivalency.equivalent_terms.forEach(term => {
            const regex = new RegExp(`\\b${term}\\b`, 'gi');
            normalizedText = normalizedText.replace(regex, equivalency.primary_name);
        });
    });

    console.log(`🔤 [NORMALIZAÇÃO] Original: "${text}" → Normalizada: "${normalizedText}"`);

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


// ATUALIZAR THERAPY_EQUIVALENCIES com sistema completo

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
            "laudo escolar",
            "psicóloga conhecimento",
            "teste psicológico conhecimento",
            "neuropsicológica"
        ],
        description: "Processo completo de 10 sessões para mapear habilidades cognitivas e emitir laudo",
        standard_response: "Avaliação neuropsicológica - 10 sessões de 50min para mapear atenção, memória, raciocínio e funções executivas. Ideal para casos de avanço de série e diagnóstico de dificuldades de aprendizagem."
    },

    speech: {
        primary_name: "fonoaudiologia",
        equivalent_terms: [
            "fono",
            "fonoaudiologia",
            "terapia da fala",
            "fala",
            "gagueira",
            "linguagem",
            "pronúncia",
            "troca letras",
            "atraso de fala",
            "desenvolvimento da fala"
        ],
        description: "Avaliação e terapia para desenvolvimento da fala e linguagem",
        standard_response: "Fonoaudiologia - trabalhamos com gagueira, atraso de fala, troca de letras, comunicação alternativa e desenvolvimento da linguagem."
    },

    psychology: {
        primary_name: "psicologia",
        equivalent_terms: [
            "psico",
            "psicóloga",
            "psicólogo",
            "psicologia",
            "terapia psicológica",
            "acompanhamento psicológico",
            "comportamento",
            "emocional",
            "psicoterapia"
        ],
        description: "Acompanhamento psicológico para questões emocionais e comportamentais",
        standard_response: "Psicologia - atendimento para questões emocionais, comportamentais, TEA, TDAH, ansiedade, com abordagens como TCC e terapia infantil."
    },

    psychopedagogy: {
        primary_name: "psicopedagogia",
        equivalent_terms: [
            "psicopedagoga",
            "psicopedagogo",
            "psico pedagogia",
            "dificuldade aprendizagem",
            "problema escola",
            "rendimento escolar",
            "aprendizagem",
            "dificuldade escola",
            "dificuldade de aprendizado"
        ],
        description: "Avaliação e intervenção em dificuldades de aprendizagem",
        standard_response: "Psicopedagogia - trabalhamos com dificuldades de aprendizagem, dislexia, TDAH escolar e estratégias pedagógicas personalizadas."
    },

    occupational: {
        primary_name: "terapia ocupacional",
        equivalent_terms: [
            "to",
            "t.o.",
            "t o",
            "terapeuta ocupacional",
            "integração sensorial",
            "integracao sensorial",
            "avd",
            "atividades vida diária",
            "coordenação motora fina"
        ],
        description: "Terapia para desenvolvimento de habilidades funcionais e integração sensorial",
        standard_response: "Terapia Ocupacional - trabalhamos com integração sensorial, coordenação motora, atividades de vida diária e autonomia."
    },

    physiotherapy: {
        primary_name: "fisioterapia",
        equivalent_terms: [
            "fisio",
            "fisioterapeuta",
            "fisioterapia motora",
            "fisio motora",
            "coordenação motora",
            "desenvolvimento motor",
            "fisioterapia respiratória",
            "fisio respiratória",
            "fisioterapia neurologica",
            "fisio neurologica",
            "fisioterapia ortopédica",
            "fisio ortopédica",
            "fisioterapia pediatrica",
            "fisio pediatrica"
        ],
        description: "Terapia para desenvolvimento motor e funcional",
        standard_response: "Fisioterapia - trabalhamos com desenvolvimento motor, coordenação, fortalecimento, equilíbrio e questões respiratórias/ortopédicas."
    },

    music: {
        primary_name: "musicoterapia",
        equivalent_terms: [
            "musicoterapeuta",
            "música terapia",
            "musica terapia",
            "terapia com música",
            "terapia musical"
        ],
        description: "Terapia através da música para desenvolvimento e expressão",
        standard_response: "Musicoterapia - utilizamos a música para trabalhar comunicação, expressão emocional, atenção e regulação."
    },

    caa: {
        primary_name: "comunicação alternativa",
        equivalent_terms: [
            "caa",
            "c.a.a.",
            "comunicação suplementar",
            "comunicacao alternativa",
            "comunicacao suplementar",
            "pecs",
            "picture exchange",
            "sistema comunicação",
            "não verbal",
            "não fala"
        ],
        description: "Sistemas de comunicação para pessoas não-verbais",
        standard_response: "Comunicação Alternativa - desenvolvemos sistemas personalizados como PECS para pacientes não-verbais se comunicarem."
    },

    tongue_tie: {
        primary_name: "teste da linguinha",
        equivalent_terms: [
            "teste linguinha",
            "teste da lingüinha",
            "teste lingüinha",
            "frênulo lingual",
            "freio lingual",
            "frênulo",
            "freio",
            "linguinha",
            "avaliação linguinha",
            "avaliação da linguinha",
            "amamentação",
            "dificuldade mamar",
            "sucção",
            "bebe não mama",
            "bebê não mama"
        ],
        description: "Avaliação do frênulo lingual para verificar alterações na amamentação e fala",
        standard_response: "Teste da Linguinha - avaliação rápida e segura do frênulo lingual. Ideal para bebês com dificuldade na amamentação. Valor: R$ 150,00."
    }
};

export const TYPEO_CORRECTIONS = {
    // Correções comuns de digitação
    "fonoafdionoliga": "fonoaudiologia",
    "fonoafdionoli": "fonoaudiologia", 
    "fonoafdionol": "fonoaudiologia",
    "fonoafdiono": "fonoaudiologia",
    "fonoafdion": "fonoaudiologia",
    "fonoafdio": "fonoaudiologia",
    "fonoafdi": "fonoaudiologia",
    "fonoafd": "fonoaudiologia",
    "fonoaf": "fonoaudiologia",
    "fonoa": "fonoaudiologia",
    "fona": "fonoaudiologia",
    
    "psicologjia": "psicologia",
    "psicolofia": "psicologia",
    "psicologa": "psicologia",
    "psicologo": "psicologia",
    
    "terapia ocupa": "terapia ocupacional",
    "terapia ocp": "terapia ocupacional",
    
    "musicoterapeuta": "musicoterapia",
    
    // Abreviações comuns
    "fono": "fonoaudiologia",
    "psico": "psicologia", 
    "to": "terapia ocupacional",
    "fisio": "fisioterapia",

    // 🆕 Correções para Fisioterapia
    "fisioterapia": "fisioterapia",
    "fisioterapia": "fisioterapia",
    "fisioterapia": "fisioterapia", 
    "fisioterapya": "fisioterapia",
    "fisioterapya": "fisioterapia",
    "fisioterapya": "fisioterapia",
    
    // 🆕 Correções para Teste da Linguinha
    "lingunha": "linguinha",
    "lingünha": "linguinha",
    "linguina": "linguinha",
    "lingüinha": "linguinha",
    "teste lingunha": "teste da linguinha",
    "teste lingünha": "teste da linguinha", 
    "teste linguina": "teste da linguinha",
    "teste lingüinha": "teste da linguinha",
    "frenulo": "frênulo",
    "freio lingual": "frênulo lingual"

};


