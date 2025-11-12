// utils/flagsDetector.js - DETECTA TODAS AS FLAGS

export function detectAllFlags(text = "", lead = {}, context = {}) {
    const t = (text || "").toLowerCase().trim();

    return {
        // 🎯 Intenções gerais
        asksPrice: /(pre[çc]o|valor|custa|quanto|mensal|pacote)/i.test(t),
        insistsPrice: /(s[oó]|apenas)\s*o\s*pre[çc]o|fala\s*o\s*valor/i.test(t),
        wantsSchedule: /(agend|marcar|hor[aá]rio|consulta|vaga)/i.test(t),
        asksAddress: /(onde|endere[cç]o|local|mapa|como\s*chegar)/i.test(t),
        asksPayment: /(pagamento|pix|cart[aã]o|dinheiro|parcel)/i.test(t),
        asksPlans: /(ipasgo|unimed|amil|plano|conv[eê]nio)/i.test(t),
        asksDuration: /(quanto\s*tempo|dura[çc][aã]o|dura\s*quanto)/i.test(t),
        asksAgeMinimum: /(idade.*m[ií]nima|a\s*partir|beb[eê])/i.test(t),
        asksRescheduling: /(cancelar|reagendar|remarcar|adiar)/i.test(t),

        // 🏥 Especialidades mencionadas
        mentionsTEA_TDAH: /(tea|autismo|tdah|d[eé]ficit|hiperativ)/i.test(t),
        mentionsSpeechTherapy: /(fono|fala|linguagem|gagueira|atraso)/i.test(t),
        asksPsychopedagogy: /(psicopedagog|dificuldade.*aprendiz)/i.test(t),
        asksCAA: /(caa|comunica[çc][aã]o.*alternativa|pecs)/i.test(t),

        // 👤 Perfil do lead (contexto)
        userProfile: detectUserProfile(t, lead, context),

        // 📊 Contexto conversacional
        isReturningLead: (context.messageCount || 0) > 1,
        alreadyAskedPrice: context.alreadyAskedPrice || false,
        stage: context.stage || 'novo'
    };
}

/**
 * 🎯 Detecta perfil do lead baseado no texto E contexto histórico
 */
function detectUserProfile(text, lead = {}, context = {}) {
    // Prioriza contexto histórico
    if (context.mentionedTherapies?.includes('neuropsicológica')) return 'neuropsych';
    if (context.mentionedTherapies?.includes('fonoaudiologia')) return 'speech';

    // Detecta no texto atual
    if (/(bebê|bebe|recém|nascido|amamenta|mamar)/i.test(text)) return 'baby';
    if (/(escola|nota|professora|lição|dever)/i.test(text)) return 'school';
    if (/(birra|comportamento|mania|teima)/i.test(text)) return 'behavior';
    if (/(ansiedade|medo|chora|emocional)/i.test(text)) return 'emotional';
    if (/(sensível|sensibilidade|textura|som)/i.test(text)) return 'sensory';
    if (/(coordenação|escrever|lápis|amarrar)/i.test(text)) return 'motor';
    if (/(nota|aprender|estudar|dificuldade escola)/i.test(text)) return 'learning';
    if (/(atenção|concentrar|distrair|hiperativo)/i.test(text)) return 'focus';

    return 'generic';
}

/**
 * 🎯 Detecta intenções de manual (substitui tryManualResponse no orchestrator)
 */
export function detectManualIntent(text = "") {
    const t = (text || "").toLowerCase().trim();

    if (/\b(endere[cç]o|onde fica|local|mapa|como chegar)\b/.test(t)) {
        return { intent: 'address', category: 'localizacao', subcategory: 'endereco' };
    }

    if (/\b(plano|conv[eê]nio|unimed|ipasgo|amil)\b/.test(t)) {
        return { intent: 'plans', category: 'planos_saude', subcategory: 'unimed' };
    }

    if (/\b(pre[cç]o|valor|quanto.*custa)\b/.test(t) &&
        !/\b(neuropsic|fono|psico|terapia|fisio|musico)\b/.test(t)) {
        return { intent: 'price_generic', category: 'valores', subcategory: 'consulta' };
    }

    if (/^(oi|ol[aá]|boa\s*(tarde|noite|dia)|bom\s*dia)[\s!,.]*$/i.test(t)) {
        return { intent: 'greeting', category: 'saudacao', subcategory: null };
    }

    if (/(tchau|at[eé]\s*(logo|mais)|obrigad|valeu)/i.test(t)) {
        return { intent: 'goodbye', category: 'despedida', subcategory: null };
    }

    return null;
}