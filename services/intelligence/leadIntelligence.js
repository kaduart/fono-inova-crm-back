/**
 * 🧠 Extrai dados estruturados da mensagem
 */
export function extractStructuredData(text) {
    const t = text.toLowerCase();

    const data = {
        idade: null,
        idadeRange: null,
        parentesco: null,
        queixa: null,
        especialidade: null,
        urgencia: 'normal',
        planoSaude: null,
        disponibilidade: null,
        contextoExterno: null,
        queixaDetalhada: [],

        proximaAcaoDeclarada: null,
        bloqueioDecisao: null,
        mencionaTerceiro: null,
    };

    // IDADE
    const ageMatch = t.match(/(\d+)\s*anos?/);
    if (ageMatch) {
        data.idade = parseInt(ageMatch[1]);
        if (data.idade <= 3) data.idadeRange = 'bebe_1a3';
        else if (data.idade <= 6) data.idadeRange = 'infantil_4a6';
        else if (data.idade <= 12) data.idadeRange = 'escolar_7a12';
        else if (data.idade <= 17) data.idadeRange = 'adolescente_13a17';
        else data.idadeRange = 'adulto_18plus';
    }

    if (/\b(beb[eê]|rec[eé]m\s*nascido|meses?)\b/.test(t)) {
        data.idadeRange = 'bebe_1a3';
    }

    // PARENTESCO
    if (/\b(meu|minha)\s+(filho|filha)\b/.test(t)) {
        data.parentesco = 'filho';
    } else if (/\bpara\s+mim\b|eu\s+preciso/.test(t)) {
        data.parentesco = 'proprio';
    }

    // QUEIXA
    const queixas = {
        'atraso_fala': /\b(n[aã]o\s+fala|atraso\s+fala|demora\s+falar|fala\s+(poucas|algumas)\s+palavras|s[oó]\s+fala\s+algumas|poucas\s+palavras)\b/, 'troca_letras': /\b(troca\s+letra|fala\s+errado)\b/,
        'gagueira': /\b(gagueira|gaguejar)\b/,
        'tea': /\b(tea|autis|espectro)\b/,
        'tdah': /\b(tdah|hiperativ|d[eé]ficit\s+aten)\b/,
        'dificuldade_aprendizagem': /\b(dificuldade\s+escolar|n[aã]o\s+aprende)\b/,
        'ansiedade': /\b(ansiedade|ansiosa)\b/,
        'comportamento': /\b(birra|agressiv)\b/,
        'freio_lingual': /\b(fr[eê]nulo|freio\s+lingual|fr[eê]nulo\s+lingual|teste\s+da\s+linguinha|linguinha)\b/,
    };

    for (const [key, regex] of Object.entries(queixas)) {
        if (regex.test(t)) {
            if (!data.queixa) data.queixa = key;  // primeira vira principal
            data.queixaDetalhada.push(key);
        }
    }

    // ESPECIALIDADE
    const especialidades = {
        'fonoaudiologia': /\b(fono|fala|linguagem)\b/,
        'psicologia': /\b(psic[oó]log|emocional)\b/,
        'terapia_ocupacional': /\b(terapia\s+ocupacional|to\b)\b/,
        'neuropsicologia': /\b(neuropsicol)\b/,
        'psicopedagogia': /\b(psicopedagog)\b/
    };

    for (const [key, regex] of Object.entries(especialidades)) {
        if (regex.test(t)) {
            data.especialidade = key;
            break;
        }
    }

    // URGÊNCIA
    if (/\b(urgente|urge|preciso\s+r[aá]pido)\b/.test(t)) {
        data.urgencia = 'alta';
    } else if (/\b(priorit[áa]ri|assim\s+que\s+poss)\b/.test(t)) {
        data.urgencia = 'media';
    }

    // 🔥 NOVO: Urgência baseada em idade + queixa
    if (data.idadeRange === 'bebe_1a3' && (data.queixa === 'atraso_fala' || data.queixa === 'freio_lingual')) {
        data.urgencia = 'alta';
    }
    if (data.idadeRange === 'infantil_4a6' && data.queixa === 'freio_lingual') {
        data.urgencia = 'media'; // por exemplo
    }


    // CONTEXTO EXTERNO
    if (/\b(escola|professora)\b/.test(t)) {
        data.contextoExterno = 'escola_solicitou';
    } else if (/\b(m[eé]dic|pediatra)\b/.test(t)) {
        data.contextoExterno = 'medico_solicitou';
    }

    // PLANO DE SAÚDE
    const planoMatch = t.match(/\b(unimed|ipasgo|amil)\b/);
    if (planoMatch) data.planoSaude = planoMatch[1];

    // DISPONIBILIDADE
    if (/\b(manh[aã])\b/.test(t)) data.disponibilidade = 'manha';
    else if (/\b(tarde)\b/.test(t)) data.disponibilidade = 'tarde';
    else if (/\b(noite)\b/.test(t)) data.disponibilidade = 'noite';

    // COMPROMISSOS / PROXIMA AÇÃO

    // falar com marido/esposa/família
    if (!data.bloqueioDecisao && /\b(falar|conversar)\s+com\s+(meu\s+marido|minha\s+esposa|meu\s+esposo|minha\s+mulher|minha\s+companheira|meu\s+companheiro|meus?\s+pais|minha\s+m[aã]e|meu\s+pai|fam[ií]lia)\b/.test(t)) {
        data.bloqueioDecisao = 'consultar_terceiro';
        data.mencionaTerceiro = 'familia';
        data.proximaAcaoDeclarada = 'consultar_familia';
    }

    // falar com escola / coordenação
    if (!data.bloqueioDecisao && /\b(falar|ver)\s+com\s+(a\s+escola|a\s+professora|a\s+coordena[cç][aã]o)\b/.test(t)) {
        data.bloqueioDecisao = 'consultar_escola';
        data.mencionaTerceiro = 'escola';
        data.proximaAcaoDeclarada = 'consultar_escola';
    }

    // "vou ver o preço", "vou ver as contas"
    if (!data.bloqueioDecisao && /\b(vou\s+ver|ver\s+certinho|ver\s+melhor)\b.*\b(pre[çc]o|valor|contas?|or[cç]amento)\b/.test(t)) {
        data.bloqueioDecisao = 'avaliar_preco';
        data.proximaAcaoDeclarada = 'avaliar_preco';
    }

    // "vou olhar agenda", "vou ver horário", "vou organizar rotina"
    if (!data.bloqueioDecisao && /\b(vou\s+ver|vou\s+olhar|vou\s+organizar)\b.*\b(agenda|hor[aá]rio|rotina)\b/.test(t)) {
        data.bloqueioDecisao = 'ajustar_rotina';
        data.proximaAcaoDeclarada = 'ajustar_rotina';
    }

    // pensar
    if (!data.bloqueioDecisao && /\b(pensar\s+melhor|decidir\s+melhor|depois\s+eu\s+vejo|vou\s+pensar)\b/.test(t)) {
        data.bloqueioDecisao = 'refletir';
        data.proximaAcaoDeclarada = 'pensar_melhor';
    }

    // ============================================================
    // 🚫 FORA DE ESCOPO (exames que a clínica não realiza)
    // ============================================================
    const outOfScopePatterns = /\baudiometria\b|\blimiar\b|\bbera\b|\bpeate\b|\bteste\s+da\s+orelhinha\b|\btriagem\s+auditiva\b|\blaudo\b|\bhiperacusia\b/i;

    if (outOfScopePatterns.test(t)) {
        data.foraEscopo = true;
        data.reason = "nao_oferecemos_exame";
    }


    return data;
}

/**
 * 🎯 Analisa intenção e sentimento
 */
export function analyzeIntent(text, extractedData) {
    const t = text.toLowerCase();

    const intent = {
        primary: null,
        secondary: [],
        confidence: 0,
        sentiment: 'neutral',
        needsHumanReview: false
    };

    // INTENÇÕES (ordem de prioridade)
    const intentions = [
        { name: 'agendar_urgente', patterns: [/\b(urgente|preciso\s+r[aá]pido).*(agend|marcar)/i], confidence: 0.95 },
        { name: 'agendar_avaliacao', patterns: [/\b(agend|marcar|quero\s+marcar)/i], confidence: 0.9 },
        { name: 'cancelar_reagendar', patterns: [/\b(cancelar|remarcar|adiar)/i], confidence: 0.95 },
        { name: 'informacao_preco', patterns: [/\b(pre[cç]o|valor|quanto)/i], confidence: 0.85 },
        { name: 'duvida_geral', patterns: [/\b(d[úu]vida|gostaria\s+de\s+saber)/i], confidence: 0.65 },
        { name: 'reclamacao', patterns: [/\b(reclamar|insatisfeit|problema)/i], confidence: 0.9 }
    ];

    for (const int of intentions) {
        for (const pattern of int.patterns) {
            if (pattern.test(t)) {
                intent.primary = int.name;
                intent.confidence = int.confidence;
                break;
            }
        }
        if (intent.primary) break;
    }

    if (!intent.primary) {
        intent.primary = 'duvida_geral';
        intent.confidence = 0.5;
    }

    // SENTIMENTOS
    if (/\b(preocupad|aflita?|urgente)\b/.test(t)) intent.sentiment = 'preocupado_urgente';
    else if (/\b(adorei|[oó]timo|perfeito)\b/.test(t)) intent.sentiment = 'positivo_engajado';
    else if (/\b(frustra|chateada?|caro)\b/.test(t)) intent.sentiment = 'frustrado_negativo';

    // REVISÃO HUMANA
    if (intent.sentiment === 'frustrado_negativo' || intent.primary === 'reclamacao') {
        intent.needsHumanReview = true;
    }
    if (extractedData.urgencia === 'alta') {
        intent.needsHumanReview = true;
    }

    return intent;
}

/**
 * 📊 Calcula score do lead (0-100)
 */
export function calculateLeadScore({ extracted, intent, history = [], responseTime = 0 }) {
    let score = 50; // Base

    // 1. URGÊNCIA (+20)
    if (extracted.urgencia === 'alta') score += 20;
    else if (extracted.urgencia === 'media') score += 10;

    // 2. INTENÇÃO (+25)
    if (intent.primary === 'agendar_urgente') score += 25;
    else if (intent.primary === 'agendar_avaliacao') score += 20;
    else if (intent.primary === 'informacao_preco') score += 10;

    // 3. CONTEXTO EXTERNO (+15)
    if (extracted.contextoExterno === 'escola_solicitou') score += 15;
    else if (extracted.contextoExterno === 'medico_solicitou') score += 12;

    // 4. DADOS COMPLETOS (+15)
    if (extracted.idade) score += 3;
    if (extracted.parentesco) score += 3;
    if (extracted.queixa) score += 5;
    if (extracted.especialidade) score += 4;

    // 5. TEMPO DE RESPOSTA (+10)
    if (responseTime < 2 * 60 * 1000) score += 10;
    else if (responseTime < 10 * 60 * 1000) score += 7;
    else if (responseTime > 48 * 60 * 60 * 1000) score -= 15;

    // 6. ENGAJAMENTO (+10)
    if (history.length > 3) score += 10;
    else if (history.length > 1) score += 5;

    // 7. SENTIMENTO (+10 / -10)
    if (intent.sentiment === 'positivo_engajado') score += 10;
    else if (intent.sentiment === 'preocupado_urgente') score += 8;
    else if (intent.sentiment === 'frustrado_negativo') score -= 10;

    score = Math.max(0, Math.min(100, score));
    return Math.round(score);
}

/**
 * 🔥 Segmenta lead
 */
export function segmentLead(score) {
    if (score >= 80) return { label: 'hot', emoji: '🔥', color: '#FF4444' };
    if (score >= 50) return { label: 'warm', emoji: '🟡', color: '#FFA500' };
    return { label: 'cold', emoji: '🧊', color: '#4A90E2' };
}

/**
 * 🧠 FUNÇÃO PRINCIPAL
 */
export async function analyzeLeadMessage({ text, lead, history = [] }) {
    const extracted = extractStructuredData(text);
    const intent = analyzeIntent(text, extracted);

    const responseTime = lead.lastInteractionAt
        ? Date.now() - new Date(lead.lastInteractionAt).getTime()
        : 0;

    const score = calculateLeadScore({ extracted, intent, history, responseTime });
    const segment = segmentLead(score);

    return { extractedInfo: extracted, intent, score, segment };
}

// 🔐 PRIORIDADE DA FALA ATUAL
export function mergeLiveExtractionOverDB(live, db) {
    return {
        ...db,
        ...Object.fromEntries(
            Object.entries(live || {}).filter(([_, v]) => v !== null && v !== undefined)
        ),
        _sourcePriority: "live"
    };
}
