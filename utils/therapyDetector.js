// utils/therapyDetector.js - APENAS DETECÇÃO E DADOS

export const THERAPY_SPECIALTIES = {
    neuropsychological: {
        names: ['neuropsicológica', 'neuropsicologia', 'avaliação cognitiva'],
        patterns: [
            /neuropsic(o|ó)log(a|ia|ica)/i,
            /neuropsi/i,
            /avalia(ç|c)(a|ã)o\s+(completa|cognitiva|neuropsicol)/i
        ]
    },
    speech: {
        names: ['fonoaudiologia', 'fono'],
        patterns: [/fono(audi(o|ó)log(a|ia|o))?/i, /\bfala\b|\blinguagem\b/i]
    },
    // ... demais terapias
};

/**
 * ✅ APENAS NORMALIZAÇÃO
 */
export function normalizeTherapyTerms(text = "") {
    if (!text) return "";
    return String(text)
        .toLowerCase()
        .replace(/neuropsic(o|ó)log(a|ia|ica)/gi, 'neuropsicologia')
        .replace(/neuropsi/gi, 'neuropsicologia')
        .replace(/fonoaudi(o|ó)log(a|o)/gi, 'fonoaudiologia');
}

/**
 * ✅ APENAS DETECÇÃO (sem gerar resposta)
 */
export function detectAllTherapies(text = "") {
    const normalized = normalizeTherapyTerms(text);
    const detected = [];

    const orderedSpecialties = [
        'neuropsychological', 'speech', 'tongue_tie',
        'occupational', 'physiotherapy', 'music',
        'neuropsychopedagogy', 'psychopedagogy', 'psychology'
    ];

    for (const id of orderedSpecialties) {
        const spec = THERAPY_SPECIALTIES[id];
        if (!spec) continue;

        const hasMatch = spec.patterns.some(pattern => {
            if (pattern.global) pattern.lastIndex = 0;
            return pattern.test(normalized);
        });

        if (hasMatch) {
            if (id === 'psychology' && detected.some(d => d.id === 'neuropsychological')) {
                continue;
            }
            detected.push({ id, name: spec.names[0], allNames: spec.names });
        }
    }

    return detected;
}

/**
 * ✅ APENAS DADOS (não gera resposta completa)
 */
export const THERAPY_DATA = {
    neuropsychological: {
        explanation: "A avaliação neuropsicológica completa investiga atenção, memória, linguagem e raciocínio",
        price: "R$ 2.500 (6x) ou R$ 2.300 (à vista)",
        details: "São 10 sessões de 50min",
        engagement: "É para investigação de TDAH, TEA ou dificuldade escolar?"
    },
    speech: {
        explanation: "Avaliação especializada em desenvolvimento da fala e linguagem",
        price: "R$ 220 a avaliação inicial",
        details: "40min com fono experiente",
        engagement: "É para bebê ou criança maior?"
    },
    // ... demais terapias
};

/**
 * ✅ Busca dados (sem montar resposta)
 */
export function getTherapyData(therapyId) {
    return THERAPY_DATA[therapyId] || null;
}

/**
 * ✅ Verifica equivalência
 */
export function isAskingAboutEquivalence(text = "") {
    const patterns = [
        /(\w+)\s+(é|e)\s+(a\s+mesma\s+coisa|igual)\s+que\s+(\w+)/i,
        /qual\s+(a\s+)?diferen(ç|c)a\s+entre/i
    ];
    return patterns.some(p => p.test(normalizeTherapyTerms(text)));
}

// ========================================
// 🧠 TDAH - DETECÇÃO E RESPOSTA
// ========================================

/**
 * Detecta perguntas sobre TDAH/tratamento
 */
export function isTDAHQuestion(text) {
    const normalized = text.toLowerCase();
    
    const tdahKeywords = /\b(tdah|tdha|hiperativ|deficit.*aten[çc][aã]o|desaten[çc][aã]o|impulsiv)\b/i;
    const treatmentKeywords = /\b(trata|ajud|fazer|como.*funciona|atend|consult|terap)\b/i;
    
    return tdahKeywords.test(normalized) && treatmentKeywords.test(normalized);
}

/**
 * Resposta estruturada sobre TDAH
 */
export function getTDAHResponse(leadName = '') {
    const greeting = leadName ? `Oi ${leadName}, tudo bem?` : 'Oi, tudo bem?';
    
    return `${greeting} 💚

O TDAH pode ser tratado de forma bem efetiva com um plano multidisciplinar. Em geral, trabalhamos com:

🧠 **Avaliação especializada** – para entender o grau do TDAH, se há outras dificuldades associadas (ansiedade, dificuldades de aprendizagem, TEA, etc.)

🗣️ **Terapia com psicólogo** – ajuda na organização, controle de impulsividade, emoções e estratégias para foco

👨‍👩‍👦 **Orientação aos pais** – para ajustar rotina, combinados em casa e manejo de comportamento no dia a dia

🎓 **Apoio escolar** – adaptação de atividades, estratégias em sala e comunicação com a escola

💊 **Acompanhamento médico** (neuropediatra/psiquiatra) – quando indicado, pode incluir medicação para ajudar na atenção e impulsividade

🧩 **Outras terapias, quando necessário** – como fonoaudiologia, terapia ocupacional ou psicopedagogia, se houver dificuldades de linguagem, motricidade ou aprendizagem

Aqui na clínica a gente monta um plano individualizado, de acordo com a idade, rotina e necessidades de cada paciente 💚

Se você quiser, posso te explicar como funciona a avaliação aqui na Fono Inova e já ver um horário disponível pra gente começar. É para você ou para uma criança/adolescente? Quantos anos? 😊`.trim();
}