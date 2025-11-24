/* =========================================================================
   AMANDA INTENTS - Sistema de Fallback Local (VERSÃO FINAL)
   Clínica Fono Inova - Anápolis/GO
   ========================================================================= */

import { normalizeTherapyTerms } from './therapyDetector.js';

/* =========================================================================
   📖 MANUAL_AMANDA - Respostas Canônicas Expandidas
   ========================================================================= */
export const MANUAL_AMANDA = {
    "saudacao": "Olá! 😊 Sou a Amanda, da Clínica Fono Inova. Como posso ajudar você hoje? 💚",

    "localizacao": {
        "endereco": "Ficamos na Av. Minas Gerais, 405 - Jundiaí, Anápolis-GO!💚",
        "como_chegar": "Estamos em frente ao SESI no Jundiaí! Precisa do link do Google Maps? 💚"
    },

    "valores": {
        "avaliacao": "Avaliação inicial: R$ 220 | É o primeiro passo para entender a queixa e traçar o plano ideal. Para criança ou adulto? 💚",
        "neuropsico": "Avaliação Neuropsicológica completa (10 sessões): R$ 2.500 em até 6x ou R$ 2.300 à vista 💚",
        "teste_linguinha": "Teste da Linguinha: R$ 150. Avaliamos o frênulo lingual de forma rápida e segura 💚",
        "sessao": "Sessão avulsa R$ 220 | Pacote mensal (1x/semana): R$ 180/sessão (~R$ 720/mês) 💚",
        "psicopedagogia": "Psicopedagogia: Anamnese R$ 200 | Pacote mensal R$ 160/sessão (~R$ 640/mês) 💚"
    },

    "planos_saude": {
        "credenciamento": "Estamos em processo de credenciamento com Unimed, IPASGO e Amil. No momento atendemos particular com condições especiais 💚"
    },

    "agendamento": {
        "horarios": "Perfeito! 💚 Qual período funciona melhor: manhã ou tarde?",
        "dados": "Vou precisar de: Nome e idade do paciente, nome do responsável e principal queixa 💚"
    },

    "especialidades": {
        "tea_tdah": "Compreendo perfeitamente! 💚 Temos equipe multiprofissional especializada em neurodiversidades. A avaliação inicial é essencial para traçar o plano ideal",
        "fono": "Entendo sua preocupação! 💚 Nossas fonoaudiólogas são especializadas em desenvolvimento da linguagem. A intervenção precoce faz toda diferença",
        "psicologia": "Que bom que pensou em buscar ajuda! 💚 Nossas psicólogas são especializadas em infantil. Vamos agendar uma avaliação?",
        "caa": "Temos fono especializada em CAA! 💚 Trabalhamos com PECS e outros sistemas para comunicação não-verbal"
    },

    "duvidas_frequentes": {
        "duracao": "Cada sessão dura 40 minutos. É um tempo pensado para que a criança participe bem, sem ficar cansada 💚",
        "idade_minima": "Atendemos a partir de 1 ano! 💚 A avaliação neuropsicológica é a partir de 4 anos",
        "pagamento": "Aceitamos PIX, cartão em até 6x e dinheiro 💚",
        "pedido_medico": "Não precisa de pedido médico para agendar! 💚 A avaliação é o primeiro passo"
    },

    "despedida": "Foi um prazer conversar! Qualquer dúvida, estou à disposição. Tenha um ótimo dia! 💚"
};

/* =========================================================================
   🔍 HELPER - Busca no manual
   ========================================================================= */
export function getManual(cat, sub) {
    if (!cat) return null;
    const node = MANUAL_AMANDA?.[cat];
    if (!node) return null;
    if (sub && typeof node === 'object') return node[sub] ?? null;
    return typeof node === 'string' ? node : null;
}

/* =========================================================================
   🎯 PATTERNS DE DETECÇÃO - Consolidados e Otimizados
   ========================================================================= */
const PATTERNS = {
    // Saudações
    greeting: /^(oi|ol[aá]|hey|hi|bom\s*dia|boa\s*(tarde|noite)|começar|iniciar)[\s!,.]*$/i,

    // Localização
    address: /(onde\s*(fica|[eé])|fica\s*onde|endere[cç]o|local|localiza[çc][aã]o|mapa|como\s*chegar|rua|av\.|avenida|minas\s*gerais)/i,

    // Valores - Específicos
    price_neuro: /(neuropsico|avalia[çc][aã]o\s*neuro).*(pre[çc]o|valor|quanto)/i,
    price_linguinha: /(teste|linguinha|fr[eê]nulo).*(pre[çc]o|valor|quanto)/i,
    price_psychoped: /(psicopedagog).*(pre[çc]o|valor|quanto)/i,
    price_session: /(sess[aã]o|pacote|mensal).*(pre[çc]o|valor|quanto)/i,
    price_generic: /(pre[çc]o|valor|custa|quanto).*(avalia|consulta|inicial)|quanto\s*custa|qual\s*o\s*valor/i,

    // Planos de saúde
    health_plans: /(ipasgo|unimed|amil|bradesco|sul\s*am[eé]rica|hapvida|plano|conv[eê]nio)/i,

    // Agendamento
    schedule: /(agend(ar|o|a|amento)|marcar|marca[çc][aã]o|hor[aá]rio|consulta|vaga|disponibilidade|quero\s*agendar)/i,

    // Especialidades
    tea_tdah: /(tea|autismo|tdah|transtorno|espectro|d[eé]ficit|hiperatividade|neurodivers)/i,
    speech: /(fono|fala|linguagem|pron[uú]ncia|troca\s*letras|gagueira|atraso.*fala|n[aã]o\s*fala)/i,
    psychology: /(psic[oó]log|tcc|ansiedade|depress[aã]o|comportamento|birra|emocional)/i,
    caa: /(caa|comunica[çc][aã]o\s*alternativa|n[aã]o\s*verbal|pecs|prompt)/i,

    // Dúvidas frequentes
    duration: /(quanto\s*tempo|dura[çc][aã]o|tempo.*sess[aã]o|dura\s*quanto)/i,
    age_minimum: /(idade\s*m[ií]nima|a\s*partir\s*de|beb[eê]|rec[eé]m|nascido)/i,
    payment: /(pagamento|pix|cart[aã]o|dinheiro|cr[eé]dito|d[eé]bito|forma.*pagamento|parcel)/i,
    medical_request: /(pedido\s*m[eé]dico|receita|encaminhamento|precisa.*m[eé]dico)/i,

    // Despedida
    goodbye: /(tchau|at[eé]\s*(logo|mais|breve)|obrigad|valeu|falou)/i
};

/* =========================================================================
   ✅ ÚNICA FUNÇÃO PÚBLICA - Detecção Inteligente
   ========================================================================= */
export function getAmandaResponse(userMessage, useAIFallback = true) {
    const text = normalizeTherapyTerms(userMessage || "").toLowerCase().trim();

    // 1️⃣ SAUDAÇÕES (máxima prioridade)
    if (PATTERNS.greeting.test(text) && text.length < 25) {
        return {
            message: getManual('saudacao'),
            source: 'manual',
            confidence: 1.0,
            intent: 'greeting'
        };
    }

    // 2️⃣ DESPEDIDAS
    if (PATTERNS.goodbye.test(text)) {
        return {
            message: getManual('despedida'),
            source: 'manual',
            confidence: 1.0,
            intent: 'goodbye'
        };
    }

    // 3️⃣ LOCALIZAÇÃO
    if (PATTERNS.address.test(text)) {
        const hasComoChegar = /como\s*chegar|maps|rota/.test(text);
        return {
            message: getManual('localizacao', hasComoChegar ? 'como_chegar' : 'endereco'),
            source: 'manual',
            confidence: 0.95,
            intent: 'address'
        };
    }

    // 4️⃣ VALORES (ordem de especificidade)
    if (PATTERNS.price_neuro.test(text)) {
        return {
            message: getManual('valores', 'neuropsico'),
            source: 'manual',
            confidence: 0.95,
            intent: 'price_neuropsych'
        };
    }

    if (PATTERNS.price_linguinha.test(text)) {
        return {
            message: getManual('valores', 'teste_linguinha'),
            source: 'manual',
            confidence: 0.95,
            intent: 'price_linguinha'
        };
    }

    if (PATTERNS.price_psychoped.test(text)) {
        return {
            message: getManual('valores', 'psicopedagogia'),
            source: 'manual',
            confidence: 0.95,
            intent: 'price_psychoped'
        };
    }

    if (PATTERNS.price_session.test(text)) {
        return {
            message: getManual('valores', 'sessao'),
            source: 'manual',
            confidence: 0.9,
            intent: 'price_session'
        };
    }

    if (PATTERNS.price_generic.test(text)) {
        return {
            message: getManual('valores', 'avaliacao'),
            source: 'manual',
            confidence: 0.85,
            intent: 'price_evaluation'
        };
    }

    // 5️⃣ PLANOS DE SAÚDE
    if (PATTERNS.health_plans.test(text)) {
        return {
            message: getManual('planos_saude', 'credenciamento'),
            source: 'manual',
            confidence: 1.0,
            intent: 'health_plans'
        };
    }

    // 6️⃣ AGENDAMENTO
    if (PATTERNS.schedule.test(text)) {
        const needsData = /dados|informa[çc]/.test(text);
        return {
            message: getManual('agendamento', needsData ? 'dados' : 'horarios'),
            source: 'manual',
            confidence: 0.9,
            intent: 'scheduling'
        };
    }

    // 7️⃣ ESPECIALIDADES (guia para AI)
    if (PATTERNS.tea_tdah.test(text)) {
        return {
            message: getManual('especialidades', 'tea_tdah'),
            source: 'manual',
            confidence: 0.85,
            intent: 'tea_tdah'
        };
    }

    if (PATTERNS.speech.test(text)) {
        return {
            message: getManual('especialidades', 'fono'),
            source: 'manual',
            confidence: 0.85,
            intent: 'speech_therapy'
        };
    }

    if (PATTERNS.caa.test(text)) {
        return {
            message: getManual('especialidades', 'caa'),
            source: 'manual',
            confidence: 0.9,
            intent: 'caa'
        };
    }

    if (PATTERNS.psychology.test(text)) {
        return {
            message: getManual('especialidades', 'psicologia'),
            source: 'manual',
            confidence: 0.8,
            intent: 'psychology'
        };
    }

    // 8️⃣ DÚVIDAS FREQUENTES
    if (PATTERNS.duration.test(text)) {
        return {
            message: getManual('duvidas_frequentes', 'duracao'),
            source: 'manual',
            confidence: 1.0,
            intent: 'duration'
        };
    }

    if (PATTERNS.age_minimum.test(text)) {
        return {
            message: getManual('duvidas_frequentes', 'idade_minima'),
            source: 'manual',
            confidence: 0.95,
            intent: 'age_minimum'
        };
    }

    if (PATTERNS.payment.test(text)) {
        return {
            message: getManual('duvidas_frequentes', 'pagamento'),
            source: 'manual',
            confidence: 0.95,
            intent: 'payment'
        };
    }

    if (PATTERNS.medical_request.test(text)) {
        return {
            message: getManual('duvidas_frequentes', 'pedido_medico'),
            source: 'manual',
            confidence: 0.95,
            intent: 'medical_request'
        };
    }

    // 9️⃣ FALLBACK
    return useAIFallback
        ? null  // Deixa AI responder
        : {
            message: "Posso te ajudar com mais detalhes? 💚",
            source: 'fallback',
            confidence: 0.3,
            intent: 'unknown'
        };
}