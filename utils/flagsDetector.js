// flagsDetector.js
import { normalizeTherapyTerms } from "./therapyDetector.js";

/* =========================================================================
   1) BASE FLAGS (regex) — FONTE DA VERDADE
   ========================================================================= */
export function deriveFlagsFromText(text = "") {
    const normalizedText = normalizeTherapyTerms(text || "").toLowerCase().trim();

    const mentionsLinguinha =
        /\b(linguinha|fr[eê]nulo\s+lingual|freio\s+da\s+l[ií]ngua|freio\s+lingual)\b/i.test(normalizedText);

    const ageGroup = extractAgeGroup(normalizedText);

    return {
        text,
        normalizedText,

        ageGroup,
        asksPrice: /(pre[çc]o|valor|custa|quanto|mensal|pacote)/i.test(normalizedText),
        insistsPrice: /(s[oó]|apenas)\s*o\s*pre[çc]o|fala\s*o\s*valor|me\s*diz\s*o\s*pre[çc]o/i.test(normalizedText),

        wantsSchedule:
            /\b(agendar|marcar|agendamento|remarcar|consultar)\b/i.test(normalizedText) ||
            /\b(teria\s+vaga|tem\s+vaga|tem\s+hor[áa]rio|conseguir\s+um\s+hor[áa]rio)\b/i.test(normalizedText) ||
            /\b(hor[áa]rio\s+pra\s+(consulta|avalia[çc][aã]o))\b/i.test(normalizedText),

        asksAddress: /(onde|endere[cç]o|local|mapa|como\s*chegar)/i.test(normalizedText),
        asksPayment: /(pagamento|pix|cart[aã]o|dinheiro|parcel)/i.test(normalizedText),
        asksPlans: /(ipasgo|unimed|amil|plano|conv[eê]nio)/i.test(normalizedText),
        asksDuration: /(quanto\s*tempo|dura[çc][aã]o|dura\s*quanto)/i.test(normalizedText),

        mentionsSpeechTherapy: /(fono|fala|linguagem|gagueira|atraso)/i.test(normalizedText),
        asksPsychopedagogy: /(psicopedagog|dificuldade.*aprendiz)/i.test(normalizedText),
        asksCAA: /(caa|comunica[çc][aã]o.*alternativa|prancha.*comunica[çc][aã]o|pecs)/i.test(normalizedText),
        asksAgeMinimum: /(idade.*m[ií]nima|a\s*partir|beb[eê])/i.test(normalizedText),
        asksRescheduling: /(cancelar|reagendar|remarcar|adiar)/i.test(normalizedText),

        givingUp:
            /\b(n[aã]o\s+vou\s+esperar|desist|vou\s+deixar\s+pra\s+l[aá]|depois\s+eu\s+vejo|vou\s+pensar|deixa\s+quieto)\b/i.test(normalizedText),

        talksAboutTypeOfAssessment: /(avalia[çc][aã]o|teste|laudo|relat[oó]rio)/i.test(normalizedText),
        hasMedicalReferral: /(pedido|encaminhamento|requisi[çc][aã]o)\s+m[eé]dic/i.test(normalizedText),

        wantsHumanAgent:
            /(falar\s+com\s+atendente|falar\s+com\s+uma\s+pessoa|falar\s+com\s+humano|quero\s+atendente|quero\s+falar\s+com\s+algu[eé]m|quero\s+falar\s+com\s+a\s+secret[aá]ria)/i.test(normalizedText),

        alreadyScheduled:
            /\b(já\s+est[aá]\s+(agendado|marcado)|já\s+agendei|já\s+marquei|consegui(u|mos)\s+agendar|minha\s+esposa\s+conseguiu\s+agendar|minha\s+mulher\s+conseguiu\s+agendar)\b/i.test(normalizedText),

        asksAreas: /(quais\s+as?\s+áreas\??|atua\s+em\s+quais\s+áreas|áreas\s+de\s+atendimento)/i.test(normalizedText),
        asksDays: /(quais\s+os\s+dias\s+de\s+atendimento|dias\s+de\s+atendimento|atende\s+quais\s+dias)/i.test(normalizedText),
        asksTimes: /(quais\s+os\s+hor[aá]rios|e\s+hor[aá]rios|tem\s+hor[aá]rio|quais\s+hor[aá]rios\s+de\s+atendimento)/i.test(normalizedText),

        mentionsAdult: /\b(adulto|adultos|maior\s*de\s*18|\d{2,}\s*anos|pra\s*mim|para\s*mim)\b/i.test(normalizedText),
        mentionsChild:
            /\b(crian[çc]a|meu\s*filho|minha\s*filha|meu\s*bb|minha\s*bb|beb[eê]|pequenininh[ao])\b/i.test(normalizedText) || mentionsLinguinha,
        mentionsTeen: /\b(adolescente|adolesc[êe]ncia|pré[-\s]*adolescente)\b/i.test(normalizedText),

        mentionsTEA_TDAH: /(tea|autismo|autista|tdah|d[eé]ficit\s+de\s+aten[cç][aã]o|hiperativ)/i.test(normalizedText),

        mentionsTOD:
            /\b(tod|transtorno\s+oposito|transtorno\s+opositor|desafiador|desafia\s+tudo|muita\s+birra|agressiv[ao])\b/i.test(normalizedText),
        mentionsABA: /\baba\b|an[aá]lise\s+do\s+comportamento\s+aplicada/i.test(normalizedText),
        mentionsMethodPrompt: /m[eé]todo\s+prompt/i.test(normalizedText),
        mentionsDenver: /\b(denver|early\s*start\s*denver|esdm)\b/i.test(normalizedText),
        mentionsBobath: /\bbobath\b/i.test(normalizedText),

        // aqui fica só 1 lugar pro “bye/thanks”
        saysThanks: /\b(obrigad[ao]s?|obg|obgd|brigad[ao]s?|valeu|vlw|agrade[cç]o)\b/i.test(normalizedText),
        saysBye: /\b(tchau|até\s+mais|até\s+logo|boa\s+noite|boa\s+tarde|bom\s+dia|bom\s+descanso|até\s+amanhã)\b/i.test(normalizedText),

        asksSpecialtyAvailability:
            /(voc[eê]\s*tem\s+(psicolog|fono|fonoaudiolog|terapia\s+ocupacional|fisioterap|neuropsico|musicoterap)|\btem\s+(psicolog|fono|fonoaudiolog|terapia\s+ocupacional|fisioterap|neuropsico|musicoterap))/i.test(normalizedText),

        // objeções
        mentionsPriceObjection:
            /\b(outra\s+cl[ií]nica|mais\s+(barato|em\s+conta|acess[ií]vel)|encontrei\s+(outra|um\s+lugar|mais\s+barato)|vou\s+fazer\s+(em\s+outro|l[aá])|n[aã]o\s+precisa\s+mais|desist|cancel|muito\s+caro|caro\s+demais|n[aã]o\s+tenho\s+condi[çc][õo]es|fora\s+do\s+(meu\s+)?or[çc]amento|achei\s+mais\s+barato|prefer[io]\s+outra)\b/i.test(normalizedText),

        mentionsInsuranceObjection:
            /\b(queria\s+(pelo|usar\s+o)\s+plano|s[oó]\s+atendo\s+por\s+plano|n[aã]o\s+pago\s+particular|particular\s+[eé]\s+caro|pelo\s+conv[eê]nio)\b/i.test(normalizedText),

        mentionsTimeObjection:
            /\b(n[aã]o\s+tenho\s+tempo|sem\s+tempo|correria|agenda\s+cheia|dif[ií]cil\s+encaixar|trabalho\s+muito)\b/i.test(normalizedText),

        mentionsOtherClinicObjection:
            /\b(j[aá]\s+(estou|tô|to)\s+(vendo|fazendo|tratando)|outra\s+cl[ií]nica|outro\s+profissional|j[aá]\s+tenho\s+(fono|psic[oó]log|terapeuta))\b/i.test(normalizedText),

        mentionsDoubtTEA:
            /\b(ser[aá]\s+que\s+[eé]\s+tea|suspeita\s+de\s+(tea|autismo)|acho\s+que\s+pode\s+ser|n[aã]o\s+sei\s+se\s+[eé]|muito\s+novo\s+pra\s+saber)\b/i.test(normalizedText),

        mentionsNeuropediatra: /\bneuro(pediatra)?\b/i.test(normalizedText),
        mentionsLaudo: /\blaudo\b/i.test(normalizedText),

        // úteis pro funil
        mentionsBaby: /\b(beb[eê]|rec[ée]m[-\s]?nascid[oa]|rn\b|meses)\b/i.test(normalizedText),
    };
}

// 1️⃣ Extração de idade e definição de faixa
function extractAgeGroup(text = "") {
    const normalized = text.toLowerCase();
    const ageMatch = normalized.match(/(\d{1,2})\s*anos?/);

    const explicitAge = ageMatch ? parseInt(ageMatch[1], 10) : null;

    if (explicitAge !== null) {
        if (explicitAge <= 12) return "crianca";
        if (explicitAge <= 17) return "adolescente";
        return "adulto";
    }

    // fallback: termos sem idade explícita
    if (/\badulto|maior\s*de\s*18/.test(normalized)) return "adulto";
    if (/\badolescente|pré[-\s]*adolescente|adolesc[êe]ncia/.test(normalized)) return "adolescente";
    if (/\b(crian[çc]a|meu\s*filho|minha\s*filha|beb[eê]|bb)\b/.test(normalized)) return "crianca";
    return null;
}

/* =========================================================================
   2) TOPIC — FONTE DA VERDADE
   ========================================================================= */
export function resolveTopicFromFlags(flags = {}, text = "") {
    const t = (flags.normalizedText ?? (text || "").toLowerCase()).toLowerCase();
    if (flags.topic) return flags.topic;

    // neuropsico só quando mencionar neuro/neuropsico/laudo neuro explicitamente
    if (/\bneuropsic|\bavalia[çc][aã]o\s+neuro|\blaudo\s+neuro/.test(t)) return "neuropsicologica";

    if (/\blinguinha|fr[eê]nulo|freio\s+da\s+l[ií]ngua|freio\s+lingual/.test(t)) return "teste_linguinha";
    if (/\bpsicopedagog/.test(t) || flags.asksPsychopedagogy) return "psicopedagogia";

    if (/\bfono\b|fonoaudiolog|fala|linguagem|gagueira|atraso/.test(t) || flags.mentionsSpeechTherapy) return "fono";
    if (/\bpsicolog|ansiedad|comportamento|emocional/.test(t)) return "psicologia";
    if (/terapia\s+ocupacional|\bto\b|integra[çc][aã]o\s+sensorial/.test(t)) return "terapia_ocupacional";
    if (/fisioterap|fisio\b|bobath|dor\s+(nas?|na\s+)?(costas|coluna|ombro|joelho|pesco[cç]o)|postura|reabilita[cç][aã]o|motor/i.test(t))
        return "fisioterapia";
    if (/musicoterap/.test(t)) return "musicoterapia";

    return null;
}

/* =========================================================================
   3) TEA STATUS — FONTE DA VERDADE
   ========================================================================= */
export function computeTeaStatus(flags = {}, text = "") {
    const t = (flags.normalizedText ?? (text || "").toLowerCase()).toLowerCase();
    const hasTEA = !!flags.mentionsTEA_TDAH;

    const hasSuspeita =
        hasTEA &&
        (flags.mentionsDoubtTEA || /\bsuspeita\s+de\s+(tea|autismo|tdah)\b/i.test(t));

    const hasLaudoConfirmado =
        hasTEA &&
        flags.mentionsLaudo &&
        !flags.mentionsDoubtTEA &&
        !/suspeita\s+de\s+(tea|autismo|tdah)/i.test(t);

    if (hasLaudoConfirmado) return "laudo_confirmado";
    if (hasSuspeita) return "suspeita";
    return "desconhecido";
}

/* =========================================================================
   4) FLAGS COMPLETAS (texto + contexto) — FONTE DA VERDADE
   ========================================================================= */
export function detectAllFlags(text = "", lead = {}, context = {}) {
    const rawText = String(text ?? "");
    const baseFlags = deriveFlagsFromText(rawText || "");
    const t = baseFlags.normalizedText;

    // contexto conversacional
    const stage = context.stage || "novo";
    const messageCount = context.messageCount || 0;
    const isReturningLead = messageCount > 1;
    const alreadyAskedPrice = !!context.alreadyAskedPrice;

    // 👇 só pra DETECTAR flags (regex) e evitar ruído
    const normalizedText = normalizeTherapyTerms(rawText).toLowerCase().trim();

    const userProfile = detectUserProfile(t, lead, context);

    // bebê conta como criança
    const mentionsChildFromBaby = baseFlags.mentionsBaby || userProfile === "baby";

    // funil visita
    const isNewLead =
        !context.isPatient &&
        (stage === "novo" || !stage) &&
        messageCount <= 3;

    const wantsFastSolution =
        /(?:come[cç]ar logo|quero come[cç]ar|o quanto antes|o mais r[aá]pido poss[ií]vel|urgente|urg[êe]ncia)/i.test(t);

    const justResearching =
        /(s[oó]\s*s[oó]|s[oó]\s*pesquisando|s[oó]\s*olhando|vendo outras cl[ií]nicas|vendo outras opções|ainda vou ver|ainda estou vendo)/i.test(t);

    const visitLeadHot = isNewLead && (baseFlags.wantsSchedule || wantsFastSolution);
    const visitLeadCold = isNewLead && justResearching && !visitLeadHot;

    const isVisitFunnel =
        isNewLead &&
        (visitLeadHot || visitLeadCold || messageCount <= 2) &&
        !baseFlags.wantsHumanAgent;

    // respostas curtas de período/dia
    const answersPeriodOrDay =
        /\b(manh[ãa]|tarde|noite|qualquer|tanto faz)\b/.test(t) ||
        /\b(seg(unda)?|ter(ça|ca)?|qua(rta)?|qui(nta)?|sex(ta)?|s[áa]bado|sabado|dom(ingo)?)\b/.test(t);

    // confirmação
    const isAffirmative =
        /\b(sim|isso mesmo|ta|isso|ok|pode ser|fechado|combinado|t[áa]\s*bom|ta bom|beleza|blz|uhum|aham)\b/.test(t);

    // última mensagem do bot (pra detectar fluxo)
    const lastBotRaw = context.lastBotMessage || "";
    const lastBotMessage =
        typeof lastBotRaw === "string"
            ? lastBotRaw.toLowerCase()
            : (lastBotRaw?.content || "").toLowerCase();

    const lastBotAskedSchedule =
        /\b(agendar|marcar|consulta|avalia[çc][aã]o|visita)\b/.test(lastBotMessage) ||
        /prefere.*semana/.test(lastBotMessage) ||
        /prefere.*manh[ãa].*tarde/.test(lastBotMessage) ||
        /qual\s+per[ií]odo\s+funciona\s+melhor/.test(lastBotMessage) ||
        /qual\s+turno\s+fica\s+melhor/.test(lastBotMessage);

    const inSchedulingFlow =
        !!lead?.pendingSchedulingSlots ||
        !!lead?.pendingChosenSlot ||
        !!lead?.autoBookingContext?.active ||
        lastBotAskedSchedule;

    const wantsSchedulingNow =
        baseFlags.wantsSchedule ||
        (answersPeriodOrDay && inSchedulingFlow) ||
        (isAffirmative && inSchedulingFlow);

    const topic = resolveTopicFromFlags(baseFlags, rawText);
    const teaStatus = computeTeaStatus(baseFlags, rawText);

    return {
        ...baseFlags,
        rawText,           // 👈 pro prompt / logs
        normalizedText,
        // perfil do lead
        userProfile,
        mentionsChild: !!(baseFlags.mentionsChild || mentionsChildFromBaby),

        // contexto conversacional
        stage,
        messageCount,
        isReturningLead,
        alreadyAskedPrice,

        // funil
        isNewLead,
        visitLeadHot,
        visitLeadCold,
        isVisitFunnel,

        // agendamento
        answersPeriodOrDay,
        isAffirmative,
        inSchedulingFlow,
        wantsSchedulingNow,

        // classificação
        topic,
        teaStatus,
    };
}

/* =========================================================================
   5) PERFIL DO LEAD
   ========================================================================= */
function detectUserProfile(text, lead = {}, context = {}) {
    if (context.mentionedTherapies?.includes("neuropsicológica")) return "neuropsych";
    if (context.mentionedTherapies?.includes("fonoaudiologia")) return "speech";

    if (/(bebê|bebe|recém|nenem|nascido|amamenta|mamar)/i.test(text)) return "baby";
    if (/(escola|nota|professora|lição|dever)/i.test(text)) return "school";
    if (/(birra|comportamento|mania|teima)/i.test(text)) return "behavior";
    if (/(ansiedade|medo|chora|emocional)/i.test(text)) return "emotional";
    if (/(sensível|sensibilidade|textura|som)/i.test(text)) return "sensory";
    if (/(coordenação|escrever|lápis|amarrar)/i.test(text)) return "motor";
    if (/(nota|aprender|estudar|dificuldade escola)/i.test(text)) return "learning";
    if (/(atenção|concentrar|distrair|hiperativo)/i.test(text)) return "focus";

    return "generic";
}

/* =========================================================================
   6) MANUAL INTENT (opcional)
   ========================================================================= */
export function detectManualIntent(text = "") {
    const t = (text || "").toLowerCase().trim();

    if (/\b(endere[cç]o|onde fica|local|mapa|como chegar)\b/.test(t)) {
        return { intent: "address", category: "localizacao", subcategory: "endereco" };
    }

    if (/\b(plano|conv[eê]nio|unimed|ipasgo|amil)\b/.test(t)) {
        return { intent: "plans", category: "planos_saude", subcategory: "credenciamento" };
    }

    // genérico de preço (quando não citou área)
    if (/\b(pre[cç]o|valor|quanto.*custa)\b/.test(t) &&
        !/\b(neuropsic|fono|psico|terapia|fisio|musico)\b/.test(t)) {
        return { intent: "price_generic", category: "valores", subcategory: "avaliacao" };
    }

    if (/^(oi|ol[aá]|boa\s*(tarde|noite|dia)|bom\s*dia)[\s!,.]*$/i.test(t)) {
        return { intent: "greeting", category: "saudacao", subcategory: null };
    }

    if (/(tchau|at[eé]\s*(logo|mais)|obrigad|valeu)/i.test(t)) {
        return { intent: "goodbye", category: "despedida", subcategory: null };
    }

    return null;
}
