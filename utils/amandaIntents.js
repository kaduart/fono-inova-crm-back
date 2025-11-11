
/* =========================================================================
   📖 MANUAL_AMANDA - Respostas canônicas (MANTÉM)
   ========================================================================= */
export const MANUAL_AMANDA = {
    "saudacao": "Olá! Sou a Amanda, da Clínica Fono Inova. Como posso ajudar você hoje? 💚",
    
    "localizacao": {
        "endereco": "Ficamos na Av. Minas Gerais, 405 - Jundiaí, Anápolis-GO! Temos estacionamento gratuito e fácil acesso 💚"
    },
    
    "valores": {
        "consulta": "Avaliação inicial: R$ 220 | Neuropsicológica: R$ 2.500 (6x) ou R$ 2.300 (à vista) | Teste Linguinha: R$ 150 💚"
    },
    
    "planos_saude": {
        "unimed": "Estamos em processo de credenciamento com Unimed, IPASGO e Amil. No momento atendemos particular com condições especiais 💚"
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
   ✅ ÚNICA FUNÇÃO PÚBLICA - Simplificada
   ========================================================================= */
export function getAmandaResponse(userMessage, useAIFallback = true) {
    const text = (userMessage || "").toLowerCase().trim();
    
    // Tenta manual primeiro
    if (/endere[cç]o|onde fica/.test(text)) {
        return { 
            message: getManual('localizacao', 'endereco'), 
            source: 'manual', 
            confidence: 1.0 
        };
    }
    
    if (/plano|convenio|unimed/.test(text)) {
        return { 
            message: getManual('planos_saude', 'unimed'), 
            source: 'manual', 
            confidence: 1.0 
        };
    }
    
    if (/pre[cç]o|valor|quanto/.test(text) && !/neuropsic|fono|psico/.test(text)) {
        return { 
            message: getManual('valores', 'consulta'), 
            source: 'manual', 
            confidence: 0.8 
        };
    }
    
    if (/^(oi|ol[aá]|boa|bom\s*dia)[\s!,.]*$/i.test(text)) {
        return { 
            message: getManual('saudacao'), 
            source: 'manual', 
            confidence: 1.0 
        };
    }
    
    // Fallback genérico
    return useAIFallback 
        ? null 
        : { 
            message: "Posso te ajudar com mais detalhes? 💚", 
            source: 'fallback', 
            confidence: 0.5 
        };
}
