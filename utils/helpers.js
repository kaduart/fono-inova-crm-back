/**
 * Normaliza a saída final respeitando o contrato da decisão.
 * ResponseEnricher/ResponseBuilder podem ESTILIZAR — não mudar intenção.
 * - hotLead sem pergunta → injeta CTA de agendamento
 * - emotional → garante abertura empática
 * - Sempre passa por ensureSingleHeart (formato unificado)
 */
export function normalizeResponse(text, { decision, flags } = {}) {
    if (!text) return ensureSingleHeart('');

    let normalized = ensureSingleHeart(text);

    // hotLead: garante CTA de agendamento se não existe pergunta
    if (flags?.isHotLead && !normalized.includes('?')) {
        normalized = normalized.replace(' 💚', '\n\nQual período funciona melhor pra você? 💚');
    }

    // emotional: garante que há abertura empática (não inicia com dado clínico seco)
    const startsWithClinical = /^(avalia[çc][aã]o|o investimento|nosso endereço)/i.test(normalized);
    if (flags?.isEmotional && startsWithClinical) {
        normalized = `Entendo sua preocupação. 💚\n\n${normalized}`;
    }

    return normalized;
}

export default function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";

    let clean = text.replace(/💚/g, "").trim();

    clean = clean.replace(
        /^(obrigad[oa]\s*,?\s+[a-zÀ-ú]+(?:\s+[a-zÀ-ú]+)*)/i,
        (match) => {
            return /obrigada/i.test(match) ? "Obrigada" : "Obrigado";
        }
    );

    clean = clean.replace(
        /^(oi|olá|ola)\s*,?\s+[a-zÀ-ú]+(?:\s+[a-zÀ-ú]+)*/i,
        (match, oi) => {
            return oi.charAt(0).toUpperCase() + oi.slice(1).toLowerCase();
        }
    );

    clean = clean.trim();

    return `${clean} 💚`;
}