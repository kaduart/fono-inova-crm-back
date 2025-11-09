// utils/therapyDetector.js - VERSÃO COMPLETA COM TUDO!

export const THERAPY_SPECIALTIES = {
    neuropsychological: {
        names: ['neuropsicológica', 'neuropsicologia', 'avaliação cognitiva'],
        patterns: [
            /neuropsic(o|ó)log(a|ia|ica)/i,
            /avalia(ç|c)(a|ã)o\s+(completa|cognitiva|conhecimento)/i,
            /laudo\s+psicol(ó|o)gico/i
        ]
    },
    speech: {
        names: ['fonoaudiologia', 'fono'],
        patterns: [
            /fono(audi(o|ó)log(a|ia|o))?/i,
            /\bfala\b|\blinguagem\b/i,
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
 * Normaliza termos terapêuticos
 */
export function normalizeTherapyTerms(text = "") {
    if (!text) return "";

    let normalized = String(text).toLowerCase();

    normalized = normalized
        .replace(/neuropsic(o|ó)log(a|ia|ica)/gi, 'neuropsicologia')
        .replace(/fonoaudi(o|ó)log(a|o)/gi, 'fonoaudiologia')
        .replace(/psic(o|ó)log(a|o|ia)/gi, 'psicologia')
        .replace(/fr(e|ê)nulo/gi, 'frênulo');

    console.log(`🔤 [NORMALIZAÇÃO] Original: "${text}" → Normalizada: "${normalized}"`);
    return normalized;
}

/**
 * Detecta todas as terapias mencionadas no texto
 */
export function detectAllTherapies(text = "") {
    const normalized = normalizeTherapyTerms(text);
    const detected = [];

    for (const [id, spec] of Object.entries(THERAPY_SPECIALTIES)) {
        const hasMatch = spec.patterns.some(pattern => {
            if (pattern.global) pattern.lastIndex = 0;
            return pattern.test(normalized);
        });

        if (hasMatch) {
            detected.push({
                id,
                name: spec.names[0],
                allNames: spec.names
            });
        }
    }

    if (detected.length > 0) {
        console.log(`🎯 [TERAPIAS] Detectadas: ${detected.length} - ${detected.map(t => t.id).join(', ')}`);
    }

    return detected;
}

// ✅ INFORMAÇÕES COMPLETAS OTIMIZADAS: VALOR → PREÇO → ENGAJAMENTO
const THERAPY_RESPONSES = {
    neuropsychological: {
        explanation: "Avaliação neuropsicológica completa - são 10 sessões que incluem avaliação, aplicação de testes e laudo detalhado",
        price: "R$ 2.500,00 (valor único para todo o processo)",
        details: "10 sessões de 50min + avaliação + laudo completo",
        engagement: "É para investigação de TDAH, TEA ou dificuldade escolar?",
        segments: {
            school: "Ideal para casos de dificuldade escolar ou suspeita de TDAH/TEA",
            advance: "Essencial para processos de avanço de série escolar"
        }
    },

    speech: {
        explanation: "Avaliação especializada em desenvolvimento da fala e linguagem",
        price: "R$ 220 a avaliação inicial",
        details: "40min com fono experiente em infantil",
        engagement: "É para bebê ou criança maior?",
        segments: {
            baby: "Para bebês com dificuldade na amamentação ou atraso na fala",
            child: "Para crianças com troca de letras ou gagueira"
        }
    },

    tongue_tie: {
        explanation: "Avaliação rápida do frênulo lingual",
        price: "R$ 150,00",
        details: "Protocolo completo em 30min",
        engagement: "O bebê tem dificuldade para mamar?",
        segments: {
            baby: "Essencial nos primeiros meses para garantir amamentação adequada"
        }
    },

    psychology: {
        explanation: "Avaliação comportamental e emocional",
        price: "R$ 220 a avaliação inicial",
        details: "40min com psicóloga infantil",
        engagement: "É questão emocional ou comportamental?",
        segments: {
            behavior: "Para birras, manias ou dificuldades de comportamento",
            emotional: "Para ansiedade, medos ou questões emocionais"
        }
    },

    occupational: {
        explanation: "Avaliação de funcionalidade e integração sensorial",
        price: "R$ 220 a avaliação inicial",
        details: "40min focada em atividades diárias",
        engagement: "A criança tem dificuldade com coordenação ou sensibilidade?",
        segments: {
            sensory: "Para crianças muito sensíveis a texturas, sons ou movimentos",
            motor: "Para dificuldades em amarrar tênis, segurar lápis etc."
        }
    },

    physiotherapy: {
        explanation: "Avaliação motora e neurológica",
        price: "R$ 220 a avaliação inicial",
        details: "40min com foco em desenvolvimento motor",
        engagement: "A criança tem atraso motor ou outra questão específica?"
    },

    music: {
        explanation: "Avaliação através da música para comunicação e regulação",
        price: "R$ 220 a avaliação inicial",
        details: "40min usando música como ferramenta terapêutica",
        engagement: "Qual o objetivo principal do atendimento?"
    },

    neuropsychopedagogy: {
        explanation: "Avaliação de aprendizagem e funções cognitivas",
        price: "R$ 220 a avaliação inicial",
        details: "Estratégias alinhadas com família e escola",
        engagement: "A criança já fez alguma avaliação pedagógica?"
    },

    psychopedagogy: {
        explanation: "Avaliação de dificuldades de aprendizagem",
        price: "Anamnese R$ 200 | Pacote R$ 160/sessão",
        details: "Estratégias personalizadas com escola e família",
        engagement: "Quais as maiores dificuldades na escola?",
        segments: {
            learning: "Para notas baixas ou dificuldade em acompanhar a turma",
            focus: "Para falta de atenção ou dispersão nas aulas"
        }
    }
};

/**
 * 🎯 DETECTAR PERFIL DO LEAD PARA SEGMENTAÇÃO
 */
function detectUserProfile(text) {
    const t = text.toLowerCase();

    if (/(bebê|bebe|recém|nascido|amamenta|mamar)/i.test(t)) return "baby";
    if (/(escola|nota|professora|lição|dever)/i.test(t)) return "school";
    if (/(birra|comportamento|mania|teima)/i.test(t)) return "behavior";
    if (/(ansiedade|medo|chora|emocional)/i.test(t)) return "emotional";
    if (/(sensível|sensibilidade|textura|som|toque)/i.test(t)) return "sensory";
    if (/(coordenação|escrever|lápis|amarrar)/i.test(t)) return "motor";
    if (/(nota|aprender|estudar|dificuldade escola)/i.test(t)) return "learning";
    if (/(atenção|concentrar|distrair|hiperativo)/i.test(t)) return "focus";

    return "generic";
}

function fallbackResponse(therapyName) {
    return `Temos ${therapyName}! Avaliação R$ 220. Posso te explicar como funciona?`;
}

/**
 * ✅ Gera resposta COMPLETA para UMA terapia
 * Aplica VALOR → PREÇO → DETALHES → ENGAJAMENTO
 */
// ✅ CORREÇÃO NA FUNÇÃO generateSingleTherapyResponse - TERAPIA DETECTOR
export function generateSingleTherapyResponse(therapy, userText, flags = {}) {
    const info = THERAPY_RESPONSES[therapy.id];

    if (!info) {
        return `Temos especialistas em ${therapy.name}! A avaliação inicial é R$ 220,00. Posso te explicar como funciona? 💚`;
    }

    const { asksPrice, wantsSchedule, asksHours } = flags;

    // 🎯 RESPOSTA ESPECÍFICA PARA NEUROPSICOLÓGICA
    if (therapy.id === 'neuropsychological') {
        if (asksPrice || wantsSchedule) {
            return `Fazemos sim! ${info.explanation}. ${info.price} - já inclui avaliação, aplicação de testes e laudo completo. ${info.engagement} 💚`;
        }
        return `Fazemos sim! ${info.explanation}. ${info.price} ${info.engagement} 💚`;
    }

    // 🎯 DETECTAR PERFIL DO LEAD
    const userProfile = detectUserProfile(userText);
    const segmentInfo = info.segments?.[userProfile] ? `${info.segments[userProfile]}. ` : "";

    console.log(`🎯 [TERAPIA] ${therapy.id} - Perfil: ${userProfile}, PerguntaPreço: ${asksPrice}`);

    // 🎯 ESTRATÉGIA COMPLETA: VALOR → PREÇO → ENGAJAMENTO

    // Se pergunta preço diretamente
    if (asksPrice) {
        return `Fazemos sim! ${info.explanation}. ${segmentInfo}Valor: ${info.price}. ${info.engagement} 💚`;
    }

    // Se quer agendar
    if (wantsSchedule) {
        return `Perfeito! ${info.explanation}. Valor: ${info.price}. Qual período funciona melhor: manhã ou tarde? 💚`;
    }

    // Se pergunta horários
    if (asksHours) {
        return `Atendemos seg-sex, 8h-18h. ${info.explanation}. ${info.engagement} 💚`;
    }

    // ✅ RESPOSTA PADRÃO COMPLETA (VALOR → PREÇO → ENGAJAMENTO)
    return `Fazemos sim! ${info.explanation}. ${segmentInfo}Valor: ${info.price}. ${info.engagement} 💚`;
}

/**
 * ✅✅✅ MANTIDO: Gera resposta para MÚLTIPLAS terapias
 */
export function generateMultiTherapyResponse(therapies, userText, flags = {}) {
    // Se for apenas 1 terapia, usa função específica
    if (therapies.length === 1) {
        return generateSingleTherapyResponse(therapies[0], userText, flags);
    }

    // Múltiplas terapias detectadas
    const names = therapies.map(t => t.name).join(' e ');
    const { asksPrice, wantsSchedule } = flags;

    if (asksPrice) {
        return `Temos especialistas em ${names}! Cada uma tem sua avaliação específica. Qual você gostaria de saber mais?`;
    }

    if (wantsSchedule) {
        return `Perfeito! Atendemos em ${names}. Qual especialidade te interessa mais para agendar?`;
    }

    return `Atendemos em ${names}! Qual especialidade você procura?`;
}

/**
 * ✅✅✅ MANTIDO: Verifica se pergunta sobre equivalência
 */
export function isAskingAboutEquivalence(text = "") {
    const patterns = [
        /(\w+)\s+(é|e)\s+(a\s+mesma\s+coisa|igual|o\s+mesmo)\s+que\s+(\w+)/i,
        /qual\s+(a\s+)?diferen(ç|c)a\s+entre\s+(\w+)\s+e\s+(\w+)/i
    ];
    return patterns.some(p => p.test(normalizeTherapyTerms(text)));
}

/**
 * ✅✅✅ MANTIDO: Gera resposta sobre equivalência
 */
export function generateEquivalenceResponse(text) {
    return "Cada avaliação tem seu propósito específico! Me conta mais sobre o que você precisa que te explico a diferença?";
}

/**
 * ✅✅✅ MANTIDO: Função principal de detecção (alias para compatibilidade)
 */
export function detectTherapies(text = "") {
    return detectAllTherapies(text);
}