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
        engagement: "Faça 1 pergunta simples sobre a principal dificuldade e para quem é o atendimento (sem repetir idade se já estiver no histórico)."
    },
    speech: {
        explanation: "Avaliação especializada em desenvolvimento da fala e linguagem",
        price: "R$ 220 a avaliação inicial",
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

    const tdahKeywords = /\b(tdah|tdha|hiperativ|deficit.*aten[çc][aã]o|desaten[çc][aã]o|impulsiv)\b/i;
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

    // forma curta: "Fono: R$ 220..."
    lines.push(`${t.name}: ${data.price}.`);
    if (lines.length >= max) break;
  }

  return lines;
}
