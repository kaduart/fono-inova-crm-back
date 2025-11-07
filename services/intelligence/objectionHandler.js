// services/intelligence/objectionHandler.js

export const OBJECTIONS = {
    preco_alto: {
        patterns: [
            /\b(caro|muito\s+caro|achei\s+salgado|pre[cç]o\s+alto)\b/i,
            /\b(n[aã]o\s+tenho\s+dinheiro|n[aã]o\s+posso\s+pagar)\b/i
        ],
        severity: 'high',
        handler: (lead, extracted) => {
            const isChild = extracted.idadeRange && (extracted.idadeRange.includes('infantil') || extracted.idadeRange === 'bebe_1a3');

            let response = "Entendo perfeitamente! 💚 ";

            if (isChild && (extracted.queixa === 'tea' || extracted.queixa === 'tdah')) {
                response += "A intervenção precoce é um investimento que faz toda diferença no desenvolvimento. ";
            } else {
                response += "O valor reflete nossa equipe especializada. ";
            }

            response += "Temos o pacote mensal que sai mais em conta: R$ 180/sessão vs R$ 220 avulsa. Posso te explicar? 💚";

            return response;
        }
    },

    tempo_disponibilidade: {
        patterns: [/\b(n[aã]o\s+tenho\s+tempo|corrido|agenda\s+cheia)\b/i],
        severity: 'medium',
        handler: () => {
            return "Compreendo! 💚 Trabalhamos com horários flexíveis - manhã, tarde e início da noite. Qual período seria mais tranquilo? 💚";
        }
    },

    duvida_eficacia: {
        patterns: [/\b(funciona|resolve|vai\s+adiantar|quanto\s+tempo)\b/i],
        severity: 'medium',
        handler: (lead, extracted) => {
            let response = "Ótima pergunta! 💚 ";

            if (extracted.queixa === 'tea' || extracted.queixa === 'tdah') {
                response += "Trabalhamos com protocolos baseados em evidências para TEA/TDAH. ";
            } else {
                response += "Cada caso é único, mas usamos abordagens validadas. ";
            }

            response += "Na avaliação inicial já traçamos um plano com objetivos claros. Quer saber mais? 💚";

            return response;
        }
    }
};

/**
 * 🔍 Detecta objeção
 */
export function detectObjection(text, extracted = {}) {
    const t = text.toLowerCase();

    for (const [type, config] of Object.entries(OBJECTIONS)) {
        for (const pattern of config.patterns) {
            if (pattern.test(t)) {
                return {
                    type,
                    severity: config.severity,
                    message: config.handler(null, extracted)
                };
            }
        }
    }

    return null;
}