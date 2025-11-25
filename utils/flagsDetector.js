// utils/flagsDetector.js - DETECTA TODAS AS FLAGS

import { deriveFlagsFromText } from './amandaPrompt.js';

export function detectAllFlags(text = "", lead = {}, context = {}) {
    const t = (text || "").toLowerCase().trim();

    // 🧩 FLAGS BASE vindas do amandaPrompt
    // (asksPrice, insistsPrice, wantsSchedule, asksAddress, asksPayment, asksPlans,
    // asksDuration, asksAgeMinimum, asksRescheduling,
    // mentionsTEA_TDAH, mentionsSpeechTherapy, asksPsychopedagogy,
    // asksCAA, mentionsTOD, mentionsABA, mentionsMethodPrompt,
    // asksAreas, asksDays, asksTimes, mentionsAdult/Child/Teen,
    // wantsHumanAgent, etc.)
    const baseFlags = deriveFlagsFromText(text || "") || {};

    // 🙏 Encerramento / agradecimento simples
    const saysThanks = /\b(obrigad[ao]s?|obg|obgd|brigad[ao]s?|valeu|vlw)\b/i.test(t);
    const saysBye = /(tchau|até\s+logo|até\s+mais|até\s+amanhã|boa\s+noite|bom\s+descanso)/i.test(t);

    // 📊 Contexto conversacional básico
    const stage = context.stage || 'novo';
    const messageCount = context.messageCount || 0;
    const isReturningLead = messageCount > 1;
    const alreadyAskedPrice = context.alreadyAskedPrice || false;

    // 👤 Perfil do lead (contexto + texto atual)
    const userProfile = detectUserProfile(t, lead, context);

    // 🔎 MODO VISITA PRESENCIAL (funil)
    const isNewLead =
        !context.isPatient &&
        (stage === 'novo' || !stage) &&
        messageCount <= 3;

    // sinais de “quero resolver logo”
    const wantsFastSolution = /(?:come[cç]ar logo|quero come[cç]ar|o quanto antes|o mais r[aá]pido poss[ií]vel|urgente|urg[êe]ncia)/i.test(t);

    // baseFlags.wantsSchedule já vem do deriveFlagsFromText
    const wantsSchedule = !!baseFlags.wantsSchedule;

    // sinais de “só pesquisando / vendo opções”
    const justResearching =
        /(s[oó]\s*s[oó]|s[oó]\s*pesquisando|s[oó]\s*olhando|vendo outras cl[ií]nicas|vendo outras opções|ainda vou ver|ainda estou vendo)/i.test(t);

    // lead quente = novo + quer agendar/tem urgência
    const visitLeadHot =
        isNewLead &&
        (wantsSchedule || wantsFastSolution);

    // lead frio = novo + explicitamente em pesquisa + não é lead quente
    const visitLeadCold =
        isNewLead &&
        justResearching &&
        !visitLeadHot;

    // atalho: estamos num contexto bom pra aplicar funil de visita?
    const isVisitFunnel =
        isNewLead &&
        (visitLeadHot || visitLeadCold || messageCount <= 2) &&
        !baseFlags.wantsHumanAgent; // se pediu atendente humana, IA sai do caminho

    return {
        // ✅ Tudo que vem do prompt central
        ...baseFlags,

        // 👤 Perfil do lead
        userProfile,

        // 📊 Contexto conversacional
        isReturningLead,
        alreadyAskedPrice,
        stage,
        messageCount,

        // 🙏 Encerramento
        saysThanks,
        saysBye,

        // 🎯 Funil de visita presencial
        isNewLead,
        visitLeadHot,
        visitLeadCold,
        isVisitFunnel,
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
 * 🎯 Detecta intenções de manual (substitui tryManualResponse no orchestrator se você quiser)
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
