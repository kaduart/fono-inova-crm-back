// flagsDetector.js
import { normalizeTherapyTerms } from "./therapyDetector.js";
import Logger from '../services/utils/Logger.js';

const logger = new Logger('FlagsDetector');

// Helper para log estruturado
function logFlags(text, flags) {
    const activeFlags = Object.entries(flags)
        .filter(([key, value]) => value === true && !['text', 'normalizedText'].includes(key))
        .map(([key]) => key);
    
    if (activeFlags.length > 0) {
        logger.debug('FLAGS_DETECTED', {
            textPreview: text?.substring(0, 50),
            flags: activeFlags,
            flagCount: activeFlags.length
        });
    }
}

const PRICE_REGEX = /(?:\b(?:pre(?:c|ç)o|val(?:or|ores)|or(?:c|ç)amento|mensal(?:idade)?|pacote|tabela\s+de\s+pre(?:c|ç)os?|investimento|custo|taxa|pre(?:c|ç)o\s+m(?:e|é)dio|me\s+passa\s+o\s+valor|qual\s+(?:(?:o|é)\s+)?valor|quanto(?:\s+(?:custa|é|está|tá|fica|sai|cobra|dá))?)\b|r\$\s*\d+(?:[.,]\d{2})?|\$\$+)/i;

/* =========================================================================
   1) BASE FLAGS (regex) — FONTE DA VERDADE
   ========================================================================= */
export function deriveFlagsFromText(text = "") {
    const normalizedText = normalizeTherapyTerms(text || "").toLowerCase().trim();

    const mentionsLinguinha =
        /\b(linguinha|fr[eê]nulo\s+lingual|freio\s+da\s+l[ií]ngua|freio\s+lingual)\b/i.test(normalizedText);

    const wantsPartnershipOrResume =
        /\b(curr[ií]cul|curriculo|curriculum|cv)\b/i.test(normalizedText) ||
        /\b(parceria|parcerias|credenciamento|prestador|vaga|trabalhar\s+com\s+voc[eê]s)\b/i.test(normalizedText) ||
        /\b(sou|me\s+chamo)\b.*\b(musicoterap|psicopedagog|fonoaudi[oó]log[oa]?|psic[oó]log[oa]?|fisioterap|terapeuta\s+ocupacional|\bto\b|neuropsic)/i.test(normalizedText);

    const ageGroup = extractAgeGroup(normalizedText);

    // 🔥 NOVO: Detecção de endereço/localização
    // 🔧 CORREÇÃO: Capturar "vocês são de [qualquer cidade]" não só Anápolis
    const asksAddress = /\b(onde\s+(fica|é|está|ficam|são|é\s+que)\s+(a\s+)?(cl[ií]nica|consult[oó]rio|voc[eê]s))|\b(qual\s+(o\s+)?endere[çc]o|endere[çc]o\s+(de\s+)?voc[eê]s)|\b(como\s+(chego|chegar|chega)|localiza[çc][aã]o|onde\s+est[aã]o)|\b(voc[eê]s\s+(s[aã]o|ficam)\s+(de\s+|em\s+|onde))|\b(s[aã]o\s+de\s+\w+|ficam\s+em\s+\w+)|\b(an[áa]polis|goi[aá]nia|bras[ií]lia|formosa|endere[çc]o|local)/i.test(normalizedText);

    return {
        text,
        normalizedText,

        ageGroup,
        asksPrice: PRICE_REGEX.test(normalizedText),
        insistsPrice: /(s[oó]|apenas)\s*o\s*pre[çc]o|fala\s*o\s*valor|me\s*diz\s*o\s*pre[çc]o/i.test(normalizedText),
        asksAddress,
        asksLocation: asksAddress, // sinônimo

        wantsSchedule:
            /\b(agendar|marcar|agendamento|remarcar|consultar)\b/i.test(normalizedText) ||
            /\b(teria\s+vaga|tem\s+vaga|tem\s+hor[áa]rio|conseguir\s+um\s+hor[áa]rio)\b/i.test(normalizedText) ||
            /\b(hor[áa]rio\s+pra\s+(consulta|avalia[çc][aã]o))\b/i.test(normalizedText) ||
            /\b(quero\s+(uma?\s+)?consult|preciso\s+marc|posso\s+(agendar|marc)|quando\s+posso\s+(ir|marc))\b/i.test(normalizedText) ||
            /\b(tem\s+disponibilidade|dispon[ií]vel\s+(essa|pr[oó]xima)\s+semana)\b/i.test(normalizedText),

        mentionsUrgency:
            /\b(urgente|urg[êe]ncia|o\s+quanto\s+antes|logo|r[aá]pido|n[aã]o\s+pode\s+esperar|muito\s+tempo\s+esperando)\b/i.test(normalizedText) ||
            /\b(preciso\s+(muito|urgente)|caso\s+urgente|emerg[êe]ncia)\b/i.test(normalizedText),
        confirmsData:
            /\b(isso|isso\s+mesmo|exato|correto|certo|confirmo|pode\s+ser|ta\s+bom|beleza)\b/i.test(normalizedText) &&
            normalizedText.length < 30,
        refusesOrDenies: [
            // Recusa direta
            /n[aã]o\s+(quero|preciso|vou|obrigad[oa]?)/i,
            /n[aã]o,?\s+obrigad[oa]/i,
            /(obrigad[oa]|valeu|agrade[çc]o),?\s+(mas\s+)?n[aã]o/i,
            // Adiamento
            /deixa\s+(pra\s+l[aá]|quieto)/i,
            /depois\s+(eu\s+vejo|a\s+gente\s+v[eê]|conversamos|falamos|te\s+(chamo|procuro))/i,
            /(agora|no\s+momento|por\s+enquanto)\s+n[aã]o(\s+d[aá])?/i,
            /mais\s+tarde/i,
            /(talvez|quem\s+sabe)\s+depois/i,
            // Indecisão
            /(vou|preciso|deixa\s+eu)\s+pensar/i,
            /(vou|ainda\s+vou)\s+ver\s+(ainda|isso)?/i,
            /(ainda\s+)?n[aã]o\s+sei(\s+ainda)?/i,
            /n[aã]o\s+tenho\s+(certeza|interesse)/i,
            // Rejeição indireta
            /n[aã]o\s+[eé]\s+(pra\s+mim|o\s+que\s+(procuro|preciso)|bem\s+isso)/i,
            /(mudei|mudar)\s+de\s+ideia/i,
            /(resolvi|decidi|prefiro|melhor|acho\s+(que|melhor))\s+n[aã]o/i,
            /sem\s+interesse/i,
            /n[aã]o\s+me\s+interessa/i,
            // Objeção financeira suave
            /(t[aá]|ficou|est[aá])\s+(caro|puxado|dif[ií]cil|complicado)/i,
            /(fora|n[aã]o\s+cabe)\s+(d?o\s+)?(meu\s+)?or[çc]amento/i,
            /n[aã]o\s+tenho\s+condi[çc][õo]es/i,
            // Frases curtas de recusa
            /^n[aã]o\.?$/i,
            /^agora\s+n[aã]o\.?$/i,
            /^depois\.?$/i,
        ].some(r => r.test(normalizedText)),

        wantsMoreOptions:
            /\b(outr[oa]s?\s+(hor[aá]rio|op[çc][aã]o)|nenhum[a]?\s+dessas?|n[aã]o\s+serve|diferente|mais\s+opções?)\b/i.test(normalizedText) ||
            /\b(outro\s+dia|outra\s+data|semana\s+que\s+vem)\b/i.test(normalizedText),
        mentionsCDL:
            /\b(cdl|desconto|promo[çc][aã]o|cupom|c[oó]digo)\b/i.test(normalizedText),
        wantsReschedule: /\b(reagendar|remarcar|mudar\s+hor[aá]rio|trocar\s+hor[aá]rio|alterar\s+data)\b/i.test(normalizedText),
        wantsCancel: [
            // Pedidos diretos
            /(quero|preciso|pode|tem\s+como|d[aá]\s+pra)\s+(cancelar|desmarcar)/i,
            /cancela\s+(pra\s+mim|por\s+favor|a[ií])?/i,
            /(vou\s+ter\s+que|tenho\s+que|preciso)\s+(cancelar|desmarcar)/i,
            // Impossibilidade
            /n[aã]o\s+vou\s+(poder|mais|conseguir)\s*(ir)?/i,
            /n[aã]o\s+(consigo|posso|tenho\s+como)\s+ir/i,
            /n[aã]o\s+(vai|tem\s+como)\s+(dar|rolar)/i,
            /n[aã]o\s+(d[aá]|rola)\s+mais/i,
            /(impossivel|imposs[ií]vel)\s+(ir|comparecer)/i,
            /n[aã]o\s+vai\s+ser\s+poss[ií]vel/i,
            // Imprevistos
            /(surgiu|tive|aconteceu|deu)\s+(um\s+)?(imprevisto|problema|pepino)/i,
            /infelizmente\s+(n[aã]o\s+vou|tenho\s+que\s+cancelar)/i,
            // Saúde
            /(estou|t[oô]|fiquei)\s+(doente|mal|ruim)/i,
            /(meu\s+filho|minha\s+filha|a\s+crian[çc]a)\s+(ficou|est[aá]|t[aá])\s+(doente|mal)/i,
            /passei\s+mal/i,
            /n[aã]o\s+(estou|t[oô])\s+bem/i,
        ].some(r => r.test(normalizedText)),

        asksPayment: /(pagamento|pix|cart[aã]o|dinheiro|parcel)/i.test(normalizedText),
        asksPlans: /(ipasgo|unimed|amil|plano|conv[eê]nio)/i.test(normalizedText),
        asksDuration: /(quanto\s*tempo|dura[çc][aã]o|dura\s*quanto)/i.test(normalizedText),

        mentionsSpeechTherapy: /(fono|fala|linguagem|gagueira|atraso)/i.test(normalizedText),
        asksPsychopedagogy: /(psicopedagog|dificuldade.*aprendiz)/i.test(normalizedText),
        asksCAA: /(caa|comunica[çc][aã]o.*alternativa|prancha.*comunica[çc][aã]o|pecs)/i.test(normalizedText),
        asksAgeMinimum: /(idade.*m[ií]nima|a\s*partir|beb[eê])/i.test(normalizedText),
        asksRescheduling: /(cancelar|reagendar|remarcar|adiar)/i.test(normalizedText),

        givingUp: [
            // Desistência explícita
            /desist(i|o|ir|imos|iu)?/i,
            /(vou|quero)\s+desistir/i,
            /cansei(\s+de\s+esperar)?/i,
            /cansad[oa]\s+de\s+esperar/i,
            /n[aã]o\s+(vou|quero)\s+esperar(\s+mais)?/i,
            /n[aã]o\s+(aguento|suporto)\s+mais/i,
            // Abandono
            /(esquece|deixa\s+pra\s+l[aá]|deixa\s+quieto)/i,
            /n[aã]o\s+(vale|compensa|preciso\s+mais)/i,
            /(muito|demais)\s+(complicado|dif[ií]cil|demorado)/i,
            /(complicou|dificultou)(\s+demais)?/i,
            /(demora|demorado)\s+(muito|demais)/i,
            /perd(i|eu|emos)\s+(o\s+interesse|a\s+paci[eê]ncia)/i,
            // Foi pra concorrência
            /(encontrei|achei|fui\s+em|vou\s+em)\s+(outr[oa]|outro\s+lugar)/i,
            /(marquei|agendei|fechei)\s+(em\s+)?outr[oa]/i,
            /j[aá]\s+(resolvi|consegui)\s+em\s+outro/i,
            /vou\s+procurar\s+outr[oa]/i,
            // Irritação/saturação
            /(t[oô]|estou)\s+de\s+saco\s+cheio/i,
            /chega|para|basta/i,
            /n[aã]o\s+tenho\s+paci[eê]ncia/i,
            // Pedido pra parar contato
            /parem?\s+de\s+(me\s+)?(ligar|chamar|mandar)/i,
            /n[aã]o\s+(me\s+)?(mand|envi)(em?|a)\s+mais/i,
            /(tire|remove|tira)\s+(meu\s+)?(n[uú]mero|contato)/i,
            /n[aã]o\s+quero\s+mais\s+receber/i,
            /me\s+(tire|remove)\s+da\s+lista/i,
        ].some(r => r.test(normalizedText)),

        talksAboutTypeOfAssessment: /(avalia[çc][aã]o|teste|laudo|relat[oó]rio)/i.test(normalizedText),
        hasMedicalReferral: /(pedido|encaminhamento|requisi[çc][aã]o)\s+m[eé]dic/i.test(normalizedText),

        wantsHumanAgent:
            /(falar\s+com\s+atendente|falar\s+com\s+uma\s+pessoa|falar\s+com\s+humano|quero\s+atendente|quero\s+falar\s+com\s+algu[eé]m|quero\s+falar\s+com\s+a\s+secret[aá]ria)/i.test(normalizedText),

        alreadyScheduled: [
            // Confirmações diretas
            /j[aá]\s+(est[aá]|t[aá]|ta|foi)\s+(agendad[oa]|marcad[oa]|confirmad[oa])/i,
            /j[aá]\s+(agendei|marquei|agendamos|marcamos|confirmei|confirmamos)/i,
            /j[aá]\s+tenho\s+(agendamento|consulta|hor[aá]rio|data|vaga)/i,
            /j[aá]\s+(temos|tenho)\s+(tudo\s+)?(certo|confirmado|marcado)/i,
            // Terceiros agendando
            /consegui(u|mos|ram)?\s+(agendar|marcar)/i,
            /(minha?|meu)\s+(esposa|mulher|m[aã]e|irm[aã]|marido|pai|filho|filha)\s+(j[aá]\s+)?(conseguiu|agendou|marcou)/i,
            /a\s+gente\s+j[aá]\s+(agendou|marcou|confirmou)/i,
            // Confirmações pós-agendamento
            /agendamento\s+(confirmado|feito|realizado|ok)/i,
            /tudo\s+(certo|confirmado|ok|certinho)\s*,?\s*j[aá]?/i,
            /j[aá]\s+est[aá]\s+tudo\s+(certo|confirmado|ok|certinho)/i,
            /(fechado|fechou|combinado|beleza),?\s*(t[aá]|est[aá])?\s*(agendad|marcad)?/i,
            // Expectativa de comparecer
            /nos\s+vemos\s+(dia|amanh[aã]|l[aá]|segunda|ter[çc]a|quarta|quinta|sexta|s[aá]bado)/i,
            /te\s+vejo\s+(dia|amanh[aã]|l[aá]|segunda|ter[çc]a|quarta|quinta|sexta|s[aá]bado)/i,
            /a\s+gente\s+se\s+v[eê]\s+(dia|amanh[aã]|l[aá])/i,
            /vou\s+(dia|amanh[aã]|segunda|ter[çc]a|quarta|quinta|sexta|s[aá]bado)/i,
            /estarei\s+(a[ií]|l[aá])\s+(dia|amanh[aã])/i,
            // Variações coloquiais
            /(pronto|ok|beleza),?\s*(j[aá]\s+)?(agendei|marquei|confirmei)/i,
            /deu\s+certo\s+(agendar|marcar)/i,
            /j[aá]\s+(resolvi|resolvemos|resolvido)/i,
            /recebi\s+(a\s+)?confirma[çc][aã]o/i,
            /t[aá]\s+(agendadinho|marcadinho|certinho)/i,
            /(vaga|hor[aá]rio)\s+(garantid[oa]|confirmad[oa])/i,
            /j[aá]\s+(me\s+)?confirmaram/i,
        ].some(r => r.test(normalizedText)),

        asksDays: /(quais\s+os\s+dias\s+de\s+atendimento|dias\s+de\s+atendimento|atende\s+quais\s+dias)/i.test(normalizedText),
        asksTimes: /(quais\s+os\s+hor[aá]rios|e\s+hor[aá]rios|tem\s+hor[aá]rio|quais\s+hor[aá]rios\s+de\s+atendimento)/i.test(normalizedText),

        mentionsAdult:
            ageGroup === "adulto" ||
            /\b(adulto|adultos|maior\s*de\s*18|pra\s*mim|para\s*mim)\b/i.test(normalizedText),

        mentionsTeen:
            ageGroup === "adolescente" ||
            /\b(adolescente|adolesc[êe]ncia|pré[-\s]*adolescente)\b/i.test(normalizedText),

        mentionsChild:
            ageGroup === "crianca" ||
            /\b(crian[çc]a|meu\s*filho|minha\s*filha|meu\s*bb|minha\s*bb|beb[eê]|pequenininh[ao])\b/i.test(normalizedText) ||
            mentionsLinguinha,
        mentionsTEA_TDAH: /(tea|autismo|autista|tdah|d[eé]ficit\s+de\s+aten[cç][aã]o|hiperativ)/i.test(normalizedText),

        mentionsTOD:
            /\b(tod|transtorno\s+oposito|transtorno\s+opositor|desafiador|desafia\s+tudo|muita\s+birra|agressiv[ao])\b/i.test(normalizedText),
        mentionsABA: /\baba\b|an[aá]lise\s+do\s+comportamento\s+aplicada/i.test(normalizedText),
        mentionsMethodPrompt: /m[eé]todo\s+prompt/i.test(normalizedText),
        mentionsDenver: /\b(denver|early\s*start\s*denver|esdm)\b/i.test(normalizedText),
        mentionsBobath: /\bbobath\b/i.test(normalizedText),

        // aqui fica só 1 lugar pro “bye/thanks”
        saysThanks: /\b(obrigad[ao]s?|obg|obgd|brigad[ao]s?|valeu|vlw|agrade[cç]o)\b/i.test(normalizedText),
        saysBye: /\b(tchau|até\s+mais|até\s+logo|até\s+amanhã|até)\b/i.test(normalizedText),

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
        wantsPartnershipOrResume
    };
    
    // Log dos flags detectados
    logFlags(text, flags);
    
    return flags;
}

// 1️⃣ Extração de idade e definição de faixa
function extractAgeGroup(text = "") {
    const normalized = text.toLowerCase();

    // anos
    const yearsMatch = normalized.match(/(\d{1,2})\s*anos?/);
    const years = yearsMatch ? parseInt(yearsMatch[1], 10) : null;

    // meses (ex.: "18 meses")
    const monthsMatch = normalized.match(/(\d{1,2})\s*mes(?:es)?/);
    const months = monthsMatch ? parseInt(monthsMatch[1], 10) : null;

    // caso "1 ano e 8 meses"
    const yearsAndMonths = normalized.match(/(\d{1,2})\s*anos?.*?(\d{1,2})\s*mes(?:es)?/);
    if (yearsAndMonths) {
        const y = parseInt(yearsAndMonths[1], 10);
        // criança / adolescente / adulto pela parte em anos já resolve
        if (y <= 12) return "crianca";
        if (y <= 17) return "adolescente";
        return "adulto";
    }

    if (Number.isFinite(years)) {
        if (years <= 12) return "crianca";
        if (years <= 17) return "adolescente";
        return "adulto";
    }

    // só meses -> criança
    if (Number.isFinite(months)) return "crianca";

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
    logger.debug('DETECT_ALL_FLAGS_START', { 
        textPreview: rawText?.substring(0, 50),
        leadId: lead?._id?.toString(),
        stage: context?.stage,
        messageCount: context?.messageCount
    });
    
    const baseFlags = deriveFlagsFromText(rawText || "");
    const t = baseFlags.normalizedText;
    if (context?.urgency?.level) baseFlags.urgencyLevel = context.urgency.level;
    if (context?.mode) baseFlags.mode = context.mode;

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
        /(?:^|\s)(manh[ãa]|tarde|noite|qualquer|tanto faz)(?:\s|$|[.,!?])/i.test(t) ||
        /(?:^|\s)(seg(unda)?|ter([çc]a)?|qua(rta)?|qui(nta)?|sex(ta)?|s[aá]bado|dom(ingo)?)(?:\s|$|[.,!?])/i.test(t);

    // respostas curtas de tempo relativo (ex.: "próxima", "semana que vem")
    const answersRelativeTime =
        /\b(pr[oó]xim[ao]s?|pr[oó]xima\s+semana|semana\s+que\s+vem|nos\s+pr[oó]ximos?\s+dias)\b/.test(t);


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

    const hasMenu =
        !!lead?.pendingSchedulingSlots?.primary;

    const wantsSchedulingNow =
        baseFlags.wantsSchedule ||
        (
            hasMenu &&
            (
                (answersPeriodOrDay || answersRelativeTime) ||
                isAffirmative
            )
        );

    const topic = resolveTopicFromFlags(baseFlags, rawText);
    const teaStatus = computeTeaStatus(baseFlags, rawText);

    const result = {
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
        answersRelativeTime,
        isAffirmative,
        inSchedulingFlow,
        wantsSchedulingNow,

        // classificação
        topic,
        teaStatus,
    };
    
    // Log das flags adicionais detectadas
    const additionalFlags = {
        userProfile,
        isNewLead,
        visitLeadHot,
        visitLeadCold,
        inSchedulingFlow,
        wantsSchedulingNow,
        topic,
        teaStatus
    };
    
    logger.debug('DETECT_ALL_FLAGS_RESULT', {
        textPreview: rawText?.substring(0, 40),
        ...additionalFlags,
        totalFlagCount: Object.keys(result).filter(k => result[k] === true).length
    });
    
    return result;
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
