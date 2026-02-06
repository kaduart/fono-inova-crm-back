// utils/therapyDetector.js - APENAS DETECÇÃO E DADOS

export const THERAPY_SPECIALTIES = {
    neuropsychological: {
        names: ['neuropsicológica', 'neuropsicologia', 'avaliação cognitiva'],
        patterns: [
            /neuropsic(o|ó)log(a|ia|ica)/i,
            /avalia(ç|c)(a|ã)o\s+(completa|cognitiva|conhecimento)/i,
            /avalia(ç|c)(a|ã)o\s+neuropsic(o|ó)log/i,
            /(solicita(ç|c)(a|ã)o|encaminhament(o|a)).{0,40}neuropsic/i,
            /laudo\s+psicol(ó|o)gico/i
        ]
    },
    speech: {
        names: ['fonoaudiologia', 'fono'],
        patterns: [
            /fono(audi(o|ó)log(a|ia|o))?/i,
            /\bfala\b|\blinguagem\b/i,
            /fala\s+pouco|nao\s+fala|fala\s+errado|dificuldade\s+(de\s+)?falar/i,
            /pron(ú|u)ncia|troca\s+letras|gagueira/i,
            /atraso\s+(de\s+)?fala/i
        ]
    },
    tongue_tie: {
        names: ['teste da linguinha', 'frênulo lingual'],
        patterns: [
            /teste\s+da\s+linguinha/i,
            /fr(e|ê)nulo\s+(lingual)?/i,
            /freio\s+da\s+l(í|i)ngua/i,
            /amamentação|dificuldade.*mamar/i
        ]
    },
    psychology: {
        names: ['psicologia', 'psicólogo'],
        patterns: [
            /psic(o|ó)log(a|o|ia)(?!\s*pedag)/i,
            /\btcc\b|ansiedade|depress(ã|a)o/i,
            /psic(o|ó)log(o|a)\s+infantil/i
        ]
    },
    occupational: {
        names: ['terapia ocupacional', 'TO'],
        patterns: [
            /terapia\s+ocupacional|\bTO\b/i,
            /integra(ç|c)(a|ã)o\s+sensorial/i,
            /coordena(ç|c)(a|ã)o\s+motora/i
        ]
    },
    physiotherapy: {
        names: ['fisioterapia', 'fisio'],
        patterns: [
            /fisio(terapia)?/i,
            /\bavc\b|paralisia|desenvolvimento\s+motor/i
        ]
    },
    music: {
        names: ['musicoterapia'],
        patterns: [
            /musicoterapia|m(ú|u)sica\s+terap(ê|e)utica/i
        ]
    },
    neuropsychopedagogy: {
        names: ['neuropsicopedagogia'],
        patterns: [
            /neuropsicopedagogia/i,
            /dislexia|discalculia/i
        ]
    },
    psychopedagogy: {
        names: ['psicopedagogia'],
        patterns: [
            /psicopedagog/i,
            /dificuldade\s+(de\s+)?aprendizagem/i,
            /problema\s+escolar|rendimento\s+escolar/i
        ]
    }
};

/**
 * ✅ NORMALIZAÇÃO - Remove nome da clínica antes de detectar
 */
export function normalizeTherapyTerms(text = "") {
    if (!text) return "";
    return String(text)
        .toLowerCase()
        // ✅ FIX: Remove nome da clínica ANTES de detectar área
        .replace(/cl[ií]nica\s+fono\s+inova/gi, '')
        .replace(/fono\s+inova/gi, '')
        .replace(/neuropsic(o|ó)log(a|ia|ica)/gi, 'neuropsicologia')
        .replace(/neuropsi/gi, 'neuropsicologia')
        .replace(/neuro[\s-]*psico/gi, 'neuropsicologia')
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

    // 🚫 Fora de escopo clínico (exames, triagens, laudos)
    const outOfScopeKeywords = [
        /\baudiometria\b/i,
        /\blimiar\b/i,
        /\bbera\b/i,
        /\bpeate\b/i,
        /\bteste\s+da\s+orelhinha\b/i,
        /\btriagem\s+auditiva\b/i,
        /\bhiperacusia\b/i
    ];

    const isOutOfScope = outOfScopeKeywords.some(r => r.test(normalized));

    // Se for fora de escopo, adiciona pseudo-terapia para sinalizar
    if (isOutOfScope) {
        detected.push({
            id: "fora_escopo",
            name: "fora_escopo",
            allNames: ["exame", "audiometria", "hiperacusia"]
        });
    }


    return detected;
}

/**
 * ✅ APENAS DADOS (não gera resposta completa)
 */
export const THERAPY_DATA = {
    neuropsychological: {
        explanation: "A avaliação neuropsicológica completa investiga atenção, memória, linguagem e raciocínio",
        price: "R$ 2.000(até 6x)",
        details: "São 10 sessões de 50min",
        engagement: "Faça 1 pergunta simples sobre a principal dificuldade e para quem é o atendimento (sem repetir idade se já estiver no histórico)."
    },
    speech: {
        explanation: "Avaliação especializada em desenvolvimento da fala e linguagem",
        price: "R$ 200 a avaliação inicial",
        details: "40min com fono experiente",
        //engagement: "É para bebê ou criança maior?"
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

    const tdahKeywords = /\b(t\s*d\s*a\s*h|tdah|tdha|tdh|hiperativ|deficit.*aten[çc][aã]o|desaten[çc][aã]o|impulsiv)\b/i;
    const treatmentKeywords = /\b(trata|ajud|fazer|como.*funciona|atend|consult|terap)\b/i;

    return tdahKeywords.test(normalized) && treatmentKeywords.test(normalized);
}

/**
 * Resposta estruturada sobre TDAH
 */
export function getTDAHResponse(leadName = '') {
    const namePart = leadName ? `${leadName}, ` : '';

    return `${namePart}o TDAH costuma ser trabalhado com avaliação especializada e um plano multidisciplinar, envolvendo principalmente psicologia, orientação à família e, quando necessário, outras terapias e acompanhamento médico. Aqui na Fono Inova a gente monta um plano individualizado de acordo com a rotina e as necessidades de cada paciente. Você quer saber mais sobre como funciona a avaliação inicial ou já prefere ver a possibilidade de horário para começar? 💚`;
}


export function detectNegativeScopes(text = "") {
    const normalized = normalizeTherapyTerms(text);

    const mentionsOrelhinha =
        /(teste\s+da\s+orelhinha|triagem\s+auditiva(\s+neonatal)?|\bTAN\b)/i.test(normalized);

    return { mentionsOrelhinha };
}


export function pickPrimaryTherapy(detected = []) {
    const ids = detected.map(d => d.id);

    // neuropsico domina porque é produto fechado
    if (ids.includes("neuropsychological")) return "neuropsychological";

    // se falou linguinha junto com fono, a principal costuma ser linguinha
    if (ids.includes("tongue_tie")) return "tongue_tie";

    // prioridade comum (ajuste como você quiser)
    const priority = ["speech", "psychology", "occupational", "physiotherapy", "psychopedagogy", "neuropsychopedagogy", "music"];
    return priority.find(p => ids.includes(p)) || (detected[0]?.id ?? null);
}

export function getPriceLinesForDetectedTherapies(detected = [], { max = 2 } = {}) {
    const lines = [];

    for (const t of detected) {
        const data = getTherapyData(t.id);
        if (!data?.price) continue;

        // forma curta: "Fono: R$ 200..."
        lines.push(`${t.name}: ${data.price}.`);
        if (lines.length >= max) break;
    }

    return lines;
}

/**
 * 🆕 Busca dados da terapia com preços atualizados do config/pricing.js
 * Use esta função em vez de getTherapyData quando precisar de preços
 * @param {string} therapyId - ID da terapia
 * @returns {Object|null} - Dados da terapia com preços atualizados
 */
export async function getTherapyDataWithPricing(therapyId) {
    const baseData = getTherapyData(therapyId);
    if (!baseData) return null;
    
    // Import dinâmico para evitar circular dependency
    const { getTherapyPricing, formatPrice } = await import('../config/pricing.js');
    
    const pricing = getTherapyPricing(therapyId);
    if (pricing) {
        return {
            ...baseData,
            price: pricing.incluiLaudo 
                ? `${formatPrice(pricing.avaliacao)} (${pricing.parcelamento})`
                : `${formatPrice(pricing.avaliacao)} a avaliação`,
            pricing // dados completos do pricing
        };
    }
    
    return baseData;
}