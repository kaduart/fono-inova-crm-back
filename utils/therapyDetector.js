// utils/therapyDetector.js - APENAS DETECÇÃO E DADOS

export const THERAPY_SPECIALTIES = {
    neuropsychological: {
        id: 'neuropsychological',
        names: ['neuropsicologia', 'neuropsi'],
        patterns: [
            /neuropsi(c(o|ó)l(o|ó)g(a|o|ia))?/i,
            /n[e3]ur[o0]p[s5][i1](c[o0]l[o0]g[i1][a4])?/i,  // neuropsicolog, neuropsico
            /avalia(ç|c)(ã|a)o\s+neuropsi/i,
            /laudo\s+neuropsi/i
        ],
        symptoms: ['investigacao', 'diagnostico', 'laudo', 'avaliacao_completa'],
        ageRange: ['crianca', 'adolescente', 'adulto'],
        duration: '10_sessoes',
        hasReport: true,
        priceTier: 'premium'
    },
    speech: {
        id: 'speech',
        names: ['fonoaudiologia', 'fono'],
        patterns: [
            /f[o0]n[o0](audi[o0]l[o0]g[a4])?/i,  // fono, fino, fini
            /f[o0]n[o0]d[i1][o0]l[o0]g[o0]/i,  // fonodiologo
            /f[o0]n[o0]audi[o0]l[o0]g[a4o0]/i,  // fonoaudiologa, fonoaudiologo
            /n[aã]o\s+fala/i,
            /fala\s+(pouco|errado|mal|direito)/i,
            /gaguej(a|o)/i,
            /troca\s+(letras|sons)/i,
            /atraso\s+(na\s+)?fala/i
        ],
        symptoms: ['atraso_fala', 'troca_letras', 'gagueira', 'nao_fala', 'balbucia'],
        ageRange: ['baby', 'crianca'],
        duration: 'sessao_40min',
        hasReport: false,
        priceTier: 'standard'
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
            /p[s5][i1]c[o0]l[o0]g[a4o0](?![a-z])/i,  // psicologo, psicologa, psicolog (typos)
            /p[s5][i1]c[o0]l[o0]g[i1][a4](?!\s*pedag)/i,  // psicologia (typos)
            /\btcc\b|ansiedade|depress(ã|a)o/i,
            /p[s5][i1]c[o0]l[o0]g[o0a4]\s+infantil/i
        ]
    },
    occupational: {
        names: ['terapia ocupacional', 'TO'],
        patterns: [
            /t[e3]r[a4]p[i1][a4]\s+[o0]cup[a4]c[i1][o0]n[a4]l/i,  // terapia ocupacional (typos)
            /\bTO\b/,
            /[i1]nt[e3]gr[a4][cç][a4][o0]\s+s[e3]ns[o0]r[i1][a4]l/i,
            /c[o0][o0]rd[e3]n[a4][cç][a4][o0]\s+m[o0]t[o0]r[a4]/i
        ]
    },
    physiotherapy: {
        names: ['fisioterapia', 'fisio'],
        patterns: [
            /f[i1]s[i1][o0](t[e3]r[a4]p[i1][a4])?/i,  // fisio, fisoterapia (typos)
            /\bavc\b|paralisia|desenvolvimento\s+motor/i
        ]
    },
    music: {
        names: ['musicoterapia'],
        patterns: [
            /m[uú]s[i1]c[o0]t[e3]r[a4]p[i1][a4]/i,  // musicoterapia (typos)
            /m[uú]s[i1]c[a4]\s+t[e3]r[a4]p[eê]ut[i1]c[a4]/i
        ]
    },
    neuropsychopedagogy: {
        names: ['neuropsicopedagogia'],
        patterns: [
            /n[e3]ur[o0]p[s5][i1]c[o0]p[e3]d[a4]g[o0]g[i1][a4]/i,  // neuropsicopedagogia (typos)
            /dislexia|discalculia/i
        ]
    },
    psychopedagogy: {
        names: ['psicopedagogia'],
        patterns: [
            /p[s5][i1][sc]*[i1]*c[o0]p[e3]d[a4]g[o0]g[ai]/i,  // typo-tolerant: pisicopedagogo, psicopedagoga, etc
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
        // 🛡️ FIX: Remove acentos para normalização consistente
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        // ✅ FIX: Remove nome da clínica ANTES de detectar área
        .replace(/clinica\s+fono\s+inova/gi, '')
        .replace(/fono\s+inova/gi, '')
        // ✅ FIX: Uma regex unificada evita re-processamento em cascata
        // Antes: 3 regexes rodavam em sequência sobre o próprio resultado
        // "neuropsico" → linha 104 virava "neuropsicologiaco" → linha 105 re-processava → "neuropsicologialogiaco"
        .replace(/\b(neuropsicolog(?:a|ia|ica|o)?|neuropsi(?:co(?:log(?:ia|o|a)?)?)?|neuro[\s-]*psico(?:log(?:ia|o|a)?)?)\b/gi, 'neuropsicologia')
        // 🛡️ FIX: Tolerância a typos comuns
        .replace(/\bfino\b/gi, 'fono')  // fino → fono
        .replace(/\bfini\b/gi, 'fono')  // fini → fono
        .replace(/fonoaudiolog(a|o)|fonodiologo/gi, 'fonoaudiologia');
}

/**
 * ✅ APENAS DETECÇÃO (sem gerar resposta)
 */
export function detectAllTherapies(text = "") {
    try {
        // 🛡️ Proteção inicial contra input inválido
        if (!text || typeof text !== 'string') {
            return [];
        }
        
        const normalized = normalizeTherapyTerms(text);
        const detected = [];

        const orderedSpecialties = [
            'neuropsychological', 'speech', 'tongue_tie',
            'occupational', 'physiotherapy', 'music',
            'neuropsychopedagogy', 'psychopedagogy', 'psychology'
        ];

        for (const id of orderedSpecialties) {
            const spec = THERAPY_SPECIALTIES[id];
            // 🛡️ Proteção robusta contra undefined/null
            if (!spec || !Array.isArray(spec.patterns) || spec.patterns.length === 0) {
                console.log(`[therapyDetector] Pulando ${id}: patterns inválido`);
                continue;
            }

            // 🛡️ Proteção extra: validar cada pattern
            const validPatterns = spec.patterns.filter(p => p instanceof RegExp);
            if (validPatterns.length === 0) {
                continue;
            }

            const hasMatch = validPatterns.some(pattern => {
                try {
                    if (pattern.global) pattern.lastIndex = 0;
                    return pattern.test(normalized);
                } catch (e) {
                    console.error(`[therapyDetector] Erro no pattern de ${id}:`, e.message);
                    return false;
                }
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
    } catch (err) {
        console.error('[detectAllTherapies] Erro:', err.message);
        return [];
    }
}

/**
 * ✅ APENAS DADOS (não gera resposta completa)
 */
export const THERAPY_DATA = {
    neuropsychological: {
        explanation: "A avaliação neuropsicológica completa investiga atenção, memória, linguagem e raciocínio",
        price: "R$ 2.000 (até 6x sem juros)",
        details: "São ~10 sessões de 40min + laudo completo",
        engagement: "Faça 1 pergunta simples sobre a principal dificuldade e para quem é o atendimento (sem repetir idade se já estiver no histórico)."
    },
    speech: {
        explanation: "Avaliação especializada em desenvolvimento da fala e linguagem",
        price: "R$ 200 a avaliação inicial (de R$250)",
        details: "40min com fono experiente",
    },
    psychology: {
        explanation: "Acompanhamento psicológico infantil/adolescente — comportamento, emocional, sociabilização",
        price: "R$ 200 a avaliação inicial (de R$250)",
        details: "Sessões semanais de 40min",
    },
    occupational_therapy: {
        explanation: "Terapia ocupacional focada em coordenação motora, integração sensorial e autonomia",
        price: "R$ 200 a avaliação inicial (de R$250)",
        details: "Sessões semanais de 40min",
    },
    physiotherapy: {
        explanation: "Fisioterapia infantil — desenvolvimento motor, postura, reabilitação",
        price: "R$ 200 a avaliação inicial (de R$250)",
        details: "Sessões de 40min com fisioterapeuta especializado",
    },
    music_therapy: {
        explanation: "Musicoterapia — usa música como ferramenta para socialização, comunicação e regulação emocional",
        price: "R$ 200 a avaliação inicial (de R$250)",
        details: "Sessões semanais de 40min",
    },
    psychopedagogy: {
        explanation: "Psicopedagogia — identifica como a criança aprende e trabalha dificuldades escolares (leitura, escrita, dislexia)",
        price: "R$ 200 a avaliação inicial (de R$250)",
        details: "Sessões semanais de 40min",
    },
};

/**
 * ✅ Busca dados (sem montar resposta)
 */
export function getTherapyData(therapyId) {
    return THERAPY_DATA[therapyId] || null;
}

// therapyDetector.js - VERSÃO ESTRUTURAL

export const THERAPY_PROFILES = {
    neuropsychological: {
        id: 'neuropsychological',
        names: ['neuropsicologia', 'neuropsi'],
        patterns: [
            /neuropsi(c(o|ó)l(o|ó)g(a|o|ia))?/i,
            /avalia(ç|c)(ã|a)o\s+neuropsi/i,
            /laudo\s+neuropsi/i
        ],
        symptoms: ['investigacao', 'diagnostico', 'laudo', 'avaliacao_completa'],
        ageRange: ['crianca', 'adolescente', 'adulto'],
        duration: '10_sessoes',
        hasReport: true,
        priceTier: 'premium'
    },
    speech: {
        id: 'speech',
        names: ['fonoaudiologia', 'fono'],
        patterns: [
            /fono(audi(o|ó)log(a|o|ia))?/i,
            /n[aã]o\s+fala/i,
            /fala\s+(pouco|errado|mal|direito)/i,
            /gaguej(a|o)/i,
            /troca\s+(letras|sons)/i,
            /atraso\s+(na\s+)?fala/i
        ],
        symptoms: ['atraso_fala', 'troca_letras', 'gagueira', 'nao_fala', 'balbucia'],
        ageRange: ['baby', 'crianca'],
        duration: 'sessao_40min',
        hasReport: false,
        priceTier: 'standard'
    },
    // ... etc
};

// NOVO: Detecta por SINTOMA, não palavra
export function detectTherapyBySymptoms(text = "") {
    const symptoms = extractSymptoms(text); // NLP leve

    const scores = {};
    for (const [id, profile] of Object.entries(THERAPY_PROFILES)) {
        scores[id] = profile.symptoms.filter(s => symptoms.includes(s)).length;
    }

    // Retorna array ordenado por score, não apenas o primeiro
    return Object.entries(scores)
        .filter(([_, score]) => score > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
}

// Helper: Extrai sintomas do texto (heurística melhorada)
function extractSymptoms(text) {
     const symptoms = [];
    const t = text.toLowerCase();
    
    // Mapeamento semântico, não literal
    if (/(n[aã]o\s+fala|fala\s+pouco|balbucia|n[aã]o\s+consegue\s+se\s+expressar)/.test(t))
        symptoms.push('atraso_fala');
    
    if (/(troca\s+letras|fala\s+errado|pronuncia\s+errado)/.test(t))
        symptoms.push('troca_letras');
        
    if (/(suspeita|investiga|laudo|diagn[oó]stico|fechar\s+diagn)/.test(t))
        symptoms.push('investigacao');

    return symptoms;
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