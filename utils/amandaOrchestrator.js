import Anthropic from "@anthropic-ai/sdk";
import 'dotenv/config';
import { analyzeLeadMessage } from "../services/intelligence/leadIntelligence.js";
import enrichLeadContext from "../services/leadContext.js";
import { getManual } from './amandaIntents.js';
import { buildDynamicSystemPrompt, buildUserPromptWithValuePitch } from './amandaPrompt.js';
import { detectAllFlags } from './flagsDetector.js';
import { buildEquivalenceResponse } from './responseBuilder.js';
import {
    detectAllTherapies,
    getTDAHResponse,
    isAskingAboutEquivalence,
    isTDAHQuestion
} from './therapyDetector.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 🔧 CONFIGURAÇÃO DO MODELO
const AI_MODEL = "claude-opus-4-5-20251101";

const PURE_GREETING_REGEX =
    /^(oi|ol[aá]|boa\s*(tarde|noite|dia)|bom\s*dia)[\s!,.]*$/i;

// 🔥 Novo: pedido genérico de "agendar avaliação" sem detalhes
const GENERIC_SCHEDULE_EVAL_REGEX =
    /\b(agendar|marcar|agendamento|quero\s+agendar|gostaria\s+de\s+agendar)\b.*\b(avalia[çc][aã]o)\b/i;


// 🧭 STATE MACHINE SIMPLES DE FUNIL
function nextStage(
    currentStage,
    {
        flags = {},
        intent = {},
        extracted = {},
        score = 50,
        isFirstMessage = false,
        messageCount = 0,
        lead = {},
    } = {}
) {
    let stage = currentStage || 'novo';

    // Já é paciente? não desce mais no funil
    if (stage === 'paciente' || lead.isPatient) {
        return 'paciente';
    }

    // 1️⃣ Sinais fortes de agendamento → vai pra interessado_agendamento
    if (
        flags.wantsSchedule ||
        intent.primary === 'agendar_urgente' ||
        intent.primary === 'agendar_avaliacao'
    ) {
        return 'interessado_agendamento';
    }

    // 2️⃣ Lead claramente em modo "ver preço"
    if (
        stage === 'novo' &&
        (flags.asksPrice || intent.primary === 'informacao_preco')
    ) {
        return 'pesquisando_preco';
    }

    // 3️⃣ Se já perguntou preço antes e continua engajando → engajado
    if (
        (stage === 'pesquisando_preco' || stage === 'novo') &&
        (score >= 70 || messageCount >= 4)
    ) {
        return 'engajado';
    }

    // 4️⃣ Se está em engajado e vem alguma intenção de agendar → sobe
    if (
        stage === 'engajado' &&
        (flags.wantsSchedule ||
            intent.primary === 'agendar_avaliacao' ||
            intent.primary === 'agendar_urgente')
    ) {
        return 'interessado_agendamento';
    }

    // 5️⃣ Se nada bate, mantém
    return stage;
}


/**
 * 🎯 ORQUESTRADOR COM CONTEXTO INTELIGENTE
 */
export async function getOptimizedAmandaResponse({ content, userText, lead = {}, context = {} }) {
    const text = userText || content || "";
    const normalized = text.toLowerCase().trim();

    console.log(`🎯 [ORCHESTRATOR] Processando: "${text}"`);

    // ✅ CONTEXTO INTELIGENTE (busca de leadContext.js)
    const enrichedContext = lead._id
        ? await enrichLeadContext(lead._id)
        : {
            stage: 'novo',
            isFirstContact: true,
            messageCount: 0,
            conversationHistory: [],
            conversationSummary: null,
            shouldGreet: true
        };

    // 🧩 FLAGS GERAIS (inclui thanks/bye/atendente, TEA, etc.)
    const flags = detectAllFlags(text, lead, enrichedContext);

    // 👶👨‍🦳 TRIAGEM OBRIGATÓRIA QUANDO SÓ FALA "AGENDAR AVALIAÇÃO"
    const isFirstMessageEarly =
        enrichedContext.isFirstContact ||
        !enrichedContext.messageCount ||
        enrichedContext.messageCount <= 1 ||
        (Array.isArray(enrichedContext.conversationHistory) &&
            enrichedContext.conversationHistory.length <= 1);

    const hasAnyAgeOrArea =
        flags.mentionsAdult ||
        flags.mentionsChild ||
        flags.mentionsTeen ||
        !!flags.therapyArea ||
        !!enrichedContext.therapyArea ||
        (enrichedContext.mentionedTherapies &&
            enrichedContext.mentionedTherapies.length > 0);

    const isGenericScheduleEval =
        flags.wantsSchedule &&
        GENERIC_SCHEDULE_EVAL_REGEX.test(text) &&
        !hasAnyAgeOrArea;

    if (isFirstMessageEarly && isGenericScheduleEval) {
        return "Que bom que você quer agendar! Só pra eu te orientar certinho: é pra você ou pra alguma criança/familiar? E hoje a maior preocupação é mais com a fala, com o comportamento, com a aprendizagem ou outra coisa? 💚";
    }


    const isVisitFunnel =
        (flags.isNewLead || enrichedContext.stage === 'novo') &&
        (flags.visitLeadHot || flags.visitLeadCold || enrichedContext.messageCount <= 2) &&
        !flags.asksPlans; // ❌ não entra em funil se estiver perguntando de plano/convênio


    // Se for claramente início de funil + foco em visita, já empurra instruções extras
    if (isVisitFunnel && !flags.asksPrice && !flags.wantsHumanAgent && !flags.asksPlans) {
        const aiResponse = await callVisitFunnelAI({
            text,
            lead,
            context: enrichedContext,
            flags,
        });
        const scoped = enforceClinicScope(aiResponse, text);
        return ensureSingleHeart(scoped);
    }

    // 🧠 NOVO: análise do lead pra stage/score/urgência
    let analysis = null;
    try {
        analysis = await analyzeLeadMessage({
            text,
            lead,
            history: enrichedContext.conversationHistory || [],
        });
    } catch (err) {
        console.warn('⚠️ leadIntelligence falhou no orchestrator:', err.message);
    }

    const extracted = analysis?.extracted || {};
    const intent = analysis?.intent || {};
    const score = analysis?.score ?? lead.conversionScore ?? 50;

    // 🧭 CALCULA PRÓXIMO STAGE A PARTIR DA INTELIGÊNCIA
    const currentStage =
        enrichedContext.stage ||
        lead.stage ||
        'novo';

    const messageCount = enrichedContext.messageCount || 0;

    const newStage = nextStage(currentStage, {
        flags,
        intent,
        extracted,
        score,
        isFirstMessage: enrichedContext.isFirstContact,
        messageCount,
        lead,
    });

    if (newStage !== currentStage) {
        console.log('🔁 [STAGE] Transição de stage:', {
            from: currentStage,
            to: newStage,
            score,
            intent: intent.primary,
            urgencia: extracted.urgencia,
            bloqueioDecisao: extracted.bloqueioDecisao,
        });

        // 🔧 AQUI seria o ponto ideal pra persistir no banco, ex:
        // await LeadModel.findByIdAndUpdate(lead._id, { stage: newStage });
    }

    // Usa SEMPRE esse contexto já com stage atualizado pro resto do fluxo
    const contextWithStage = {
        ...enrichedContext,
        stage: newStage,
    };

    // 👋 É a PRIMEIRA mensagem (ou bem início)?
    const isFirstMessage =
        contextWithStage.isFirstContact ||
        !contextWithStage.messageCount ||
        contextWithStage.messageCount <= 1 ||
        (Array.isArray(contextWithStage.conversationHistory) &&
            contextWithStage.conversationHistory.length <= 1);


    // 👋 Saudação "pura", sem dúvida junto
    const isPureGreeting = PURE_GREETING_REGEX.test(normalized);

    // 0️⃣ PEDIU ATENDENTE HUMANA → responde SEMPRE, mesmo se for 1ª msg
    if (flags?.wantsHumanAgent) {
        console.log('👤 [ORQUEST] Lead pediu atendente humana');
        return "Claro, vou pedir para uma atendente da clínica assumir o seu atendimento e te responder aqui mesmo em instantes, tudo bem? 💚";
    }

    // 🔚 ENCERRAMENTO "PURO" (obrigado, tchau etc.) → só se NÃO for a 1ª msg
    const pureClosingRegex =
        /^(obrigad[ao]s?|obg|obgd|vale[u]?|vlw|agrade[cç]o|tchau|falou|até\s+mais|até\s+logo|boa\s+noite|boa\s+tarde|bom\s+dia)[\s!,.]*$/i;

    const isPureClosing =
        !isFirstMessage &&
        (flags?.saysThanks || flags?.saysBye) &&
        pureClosingRegex.test(normalized) &&
        !flags?.asksPrice &&
        !flags?.wantsSchedule &&
        !flags?.asksAddress &&
        !flags?.asksPlans &&
        !flags?.asksAreas &&
        !flags?.asksTimes &&
        !flags?.asksDays;

    if (isPureClosing) {
        console.log('🙏 [ORQUEST] Mensagem de encerramento detectada');
        return "Eu que agradeço, qualquer coisa é só chamar 💚";
    }

    const LINGUINHA_REGEX =
        /\b(teste\s+da\s+linguinha|linguinha|fr[eê]nulo\s+lingual|freio\s+da\s+l[ií]ngua|freio\s+lingual)\b/i;
    if (LINGUINHA_REGEX.test(normalized) && !flags.mentionsAdult) {
        return "Fazemos sim! O fono avalia o frênulo e como a língua se movimenta pra mamar, engolir e futuramente falar. Geralmente esse exame é pra bebês e crianças. Ele ou ela está com quantos meses? 💚";
    }

    if (flags?.alreadyScheduled) {
        // Se quiser, pode tentar pegar nome do paciente do lead ou do histórico.
        const nomePaciente = lead?.patientName || lead?.name || null;

        if (nomePaciente) {
            return `Que bom que vocês já conseguiram agendar, isso é um passo importante pro acompanhamento do(a) ${nomePaciente}! Se surgir qualquer dúvida até lá, é só chamar 💚`;
        }

        return "Que bom que vocês já conseguiram deixar o atendimento agendado, isso ajuda muito na continuidade do tratamento. Se surgir qualquer dúvida até lá, é só chamar 💚";
    }

    // ===== 1. TDAH - RESPOSTA ESPECÍFICA =====
    if (isTDAHQuestion(text)) {
        console.log('🧠 [TDAH] Pergunta sobre tratamento TDAH detectada');
        const base = getTDAHResponse(lead?.name);
        const scoped = enforceClinicScope(base, text);
        return ensureSingleHeart(scoped);
    }

    // ===== 2. TERAPIAS ESPECÍFICAS =====
    const therapies = detectAllTherapies(text);

    if (therapies.length > 0) {
        console.log(`🎯 [TERAPIAS] Detectadas: ${therapies.map(t => t.id).join(', ')}`);

        console.log(`🏁 [FLAGS]`, {
            asksPrice: flags.asksPrice,
            wantsSchedule: flags.wantsSchedule,
            userProfile: flags.userProfile
        });

        const aiResponse = await callClaudeWithTherapyData({
            therapies,
            flags: {
                ...flags,
                conversationSummary: contextWithStage.conversationSummary || ''
            },
            userText: text,
            lead,
            context: contextWithStage
        });


        const scoped = enforceClinicScope(aiResponse, text);
        return ensureSingleHeart(scoped);
    }

    // ===== 3. EQUIVALÊNCIA =====
    if (isAskingAboutEquivalence(text)) {
        const base = buildEquivalenceResponse();
        const scoped = enforceClinicScope(base, text);
        return ensureSingleHeart(scoped);
    }

    // ===== 4. MANUAL =====
    const manualResponse = tryManualResponse(normalized, contextWithStage, flags);
    if (manualResponse) {
        console.log(`✅ [ORCHESTRATOR] Resposta do manual`);
        const scoped = enforceClinicScope(manualResponse, text);
        return ensureSingleHeart(scoped);
    }

    // ===== 5. IA COM CONTEXTO =====
    console.log(`🤖 [ORCHESTRATOR] IA | Stage: ${contextWithStage.stage} | Msgs: ${contextWithStage.messageCount}`);
    try {
        const aiResponse = await callAmandaAIWithContext(
            text,
            lead,
            {
                ...contextWithStage,
                conversationSummary: contextWithStage.conversationSummary || ''
            },
            flags
        );

        const scoped = enforceClinicScope(aiResponse, text);
        return ensureSingleHeart(scoped);
    } catch (error) {
        console.error(`❌ [ORCHESTRATOR] Erro na IA:`, error.message);
        return "Vou verificar e já te retorno, por favor um momento 💚";
    }
}

/**
 * 🔥 FUNÇÃO DE FUNIL DE VISITA
 */
async function callVisitFunnelAI({ text, lead, context, flags }) {
    // 🔥 NOVO: Monta contexto para System Prompt dinâmico
    const systemContext = {
        isHotLead: flags.visitLeadHot,
        isColdLead: flags.visitLeadCold,
        negativeScopeTriggered: /audiometria|bera|rpg|pilates/i.test(text),
    };
    const dynamicSystemPrompt = buildDynamicSystemPrompt(systemContext);

    const messages = [];

    if (context.conversationSummary) {
        messages.push({
            role: 'user',
            content: `📋 CONTEXTO ANTERIOR:\n\n${context.conversationSummary}\n\n---\n\nMensagens recentes abaixo:`
        });
        messages.push({
            role: 'assistant',
            content: 'Entendi o contexto. Vou seguir o funil de VISITA PRESENCIAL.'
        });
    }

    if (context.conversationHistory?.length) {
        const safeHistory = context.conversationHistory.map(msg => ({
            role: msg.role || 'user',
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        }));
        messages.push(...safeHistory);
    }

    const visitPrompt = `
${text}

🎯 MODO VISITA PRESENCIAL ATIVO
- Lead ${flags.visitLeadHot ? 'QUENTE (quer resolver logo)' : 'FRIO (ainda pesquisando)'}.
- Seu objetivo é conduzir para VISITA PRESENCIAL na clínica, seguindo:

1) PRIMEIRO CONTATO
- Pergunte nome da criança, idade e o que motivou a busca (se isso ainda não estiver claro no histórico).
- Classifique mentalmente como lead quente ou frio.

2) LEAD QUENTE
- Ofereça a ideia da visita presencial como passo natural ("vir conhecer o espaço e conversar com a equipe").
- Dê SEMPRE uma escolha binária que AVANÇA:
  • "Prefere deixar encaminhada uma visita essa semana ou na próxima?"
  • "Melhor período pra vocês costuma ser manhã ou tarde?"

3) LEAD FRIO
- Normalize a pesquisa ("muita gente começa só pesquisando").
- Ofereça VISITA sem compromisso:
  • "Podemos deixar encaminhada uma visita gratuita, sem compromisso, só pra você conhecer o espaço e tirar dúvidas."
- Feche com pergunta binária:
  • "Faz mais sentido já deixar essa visita combinada ou prefere só receber mais informações por enquanto?"

4) OBJECÕES (usar se aparecerem):
- Plano de saúde, valor, falta de tempo, outra clínica, filho pequeno/suspeita de TEA:
  • Acolha.
  • Responda de forma simples.
  • Puxe de volta para a VISITA como próximo passo.

REGRAS:
- Máximo 2 frases + 1 pergunta binária.
- Fale sempre como recepcionista acolhedora.
- NÃO repita perguntas que já tenham sido respondidas no histórico.
- Termine com 1 💚.
`;

    messages.push({ role: 'user', content: visitPrompt });

    const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 200,
        temperature: 0.6,
        system: [
            {
                type: "text",
                text: dynamicSystemPrompt,
                cache_control: { type: "ephemeral" }
            }
        ],
        messages
    });

    return response.content[0]?.text?.trim() || "Posso te ajudar a escolher um dia pra visitar a clínica? 💚";
}



/**
 * 📖 MANUAL
 */
function tryManualResponse(normalizedText, context = {}, flags = {}) {
    const { isFirstContact, messageCount = 0 } = context;

    // 🌍 ENDEREÇO / LOCALIZAÇÃO
    if (/\b(endere[cç]o|onde fica|local|mapa|como chegar)\b/.test(normalizedText)) {
        return getManual('localizacao', 'endereco');
    }

    // 💳 CASO ESPECÍFICO: "mas queria pelo plano", "preferia pelo plano"
    if (/\b(queria|preferia|quero)\b.*\b(plano|conv[eê]nio|unimed|ipasgo|amil)\b/i.test(normalizedText)) {
        return "Entendo, muita gente prefere usar o plano mesmo. Hoje na Fono Inova todos os atendimentos são particulares, ainda não temos credenciamento com Unimed ou outros convênios. Se em algum momento isso mudar, posso te avisar por aqui, combinado? 💚";
    }

    // 🩺 PERGUNTA GERAL SOBRE PLANO/CONVÊNIO
    if (/\b(plano|conv[eê]nio|unimed|ipasgo|amil)\b/.test(normalizedText)) {
        // usa a chave CERTA do MANUAL_AMANDA
        return getManual('planos_saude', 'credenciamento');
    }

    // 💰 PREÇO GENÉRICO (sem dizer área na mensagem atual)
    if (/\b(pre[cç]o|valor|quanto.*custa)\b/.test(normalizedText) &&
        !/\b(neuropsic|fono|psico|terapia|fisio|musico)\b/.test(normalizedText)) {

        // tenta descobrir a área pelo contexto TODO (histórico + flags)
        const area = inferAreaFromContext(normalizedText, context, flags);

        // se conseguiu inferir, responde já adaptado por área
        if (area === "psicologia") {
            return "Na psicologia, a avaliação inicial é R$ 220; depois o pacote mensal costuma ficar em torno de R$ 640 (1x/semana). Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚";
        }

        if (area === "fonoaudiologia") {
            return "Na fonoaudiologia, a avaliação inicial é R$ 220; depois o pacote mensal sai em torno de R$ 720 (1x/semana). Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚";
        }

        if (area === "terapia_ocupacional") {
            return "Na terapia ocupacional, a avaliação inicial é R$ 220; o pacote mensal fica em torno de R$ 720 (1x/semana). Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚";
        }

        if (area === "fisioterapia") {
            return "Na fisioterapia, a avaliação inicial é R$ 220; o pacote mensal costuma ficar em torno de R$ 640 (1x/semana). Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚";
        }

        if (area === "psicopedagogia") {
            return "Na psicopedagogia, a anamnese inicial é R$ 200 e o pacote mensal sai em torno de R$ 640 (1x/semana). Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚";
        }

        if (area === "neuropsicologia") {
            // aqui você pode ser mais neutro, e deixar o resto com o fluxo de neuro se quiser
            return "Na neuropsicologia trabalhamos com avaliação completa em formato de pacote de sessões; o valor total hoje é R$ 2.500 em até 6x, ou R$ 2.300 à vista. Prefere deixar essa avaliação encaminhada pra começar em qual turno, manhã ou tarde? 💚";
        }

        // fallback: não conseguiu inferir área ➜ usa texto genérico do manual (já sem 'para criança ou adulto')
        return getManual('valores', 'avaliacao');
    }

    // 👋 SAUDAÇÃO PURA
    if (PURE_GREETING_REGEX.test(normalizedText)) {
        // Se é realmente primeiro contato -> usa saudação completa
        if (isFirstContact || !messageCount) {
            return getManual('saudacao');
        }

        // Se já é conversa em andamento → saudação curta, sem se reapresentar
        return "Oi! Que bom falar com você de novo 😊 Me conta, deu tudo certo com o agendamento ou ficou mais alguma dúvida? 💚";
    }


    // 💼 CURRÍCULO / VAGA / TRABALHO
    if (/\b(curr[ií]culo|curriculo|cv\b|vaga|trabalhar|emprego|trampo)\b/.test(normalizedText)) {
        return (
            "Que bom que você tem interesse em trabalhar com a gente! 🥰\n\n" +
            "Os currículos são recebidos **exclusivamente por e-mail**.\n" +
            "Por favor, envie seu currículo para **clinicafonoinova@gmail.com**, " +
            "colocando no assunto a área em que você tem interesse.\n\n" +
            "Se quiser conhecer melhor nosso trabalho, é só acompanhar a clínica também no Instagram: **@clinicafonoinova** 💚"
        );
    }

    // 📱 INSTAGRAM / REDES
    if (/\b(insta(gram)?|rede[s]?\s+social(is)?|perfil\s+no\s+instagram)\b/.test(normalizedText)) {
        return (
            "Claro! Você pode acompanhar nosso trabalho no Instagram pelo perfil " +
            "**@clinicafonoinova**. 💚"
        );
    }

    return null;
}

/**
 * 🔍 HELPER: Infere área pelo contexto
 */
function inferAreaFromContext(normalizedText, context = {}, flags = {}) {
    const t = normalizedText.toLowerCase();

    // puxa histórico recente
    const historyText = Array.isArray(context.conversationHistory)
        ? context.conversationHistory
            .map(msg =>
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content)
            )
            .join(" \n ")
            .toLowerCase()
        : "";

    const combined = `${t} ${historyText}`;

    // se algum serviço seu já preencheu isso:
    if (flags.therapyArea) return flags.therapyArea;
    if (context.therapyArea) return context.therapyArea;

    // tenta inferir por palavra-chave
    if (/\bpsicolog|psicologia\b/.test(combined)) return "psicologia";
    if (/\bfono|fonoaudiolog\b/.test(combined)) return "fonoaudiologia";
    if (/\b(terapia\s+ocupacional|to)\b/.test(combined)) return "terapia_ocupacional";
    if (/\bfisio|fisioterap\b/.test(combined)) return "fisioterapia";
    if (/\bpsicopedagog\b/.test(combined)) return "psicopedagogia";
    if (/\bneuropsicolog\b/.test(combined)) return "neuropsicologia";

    return null;
}


/**
 * 🤖 IA COM DADOS DE TERAPIAS + HISTÓRICO COMPLETO + CACHE MÁXIMO
 */
async function callClaudeWithTherapyData({ therapies, flags, userText, lead, context }) {
    const { getTherapyData } = await import('./therapyDetector.js');
    const { getLatestInsights } = await import('../services/amandaLearningService.js');

    const insights = await getLatestInsights();

    const therapiesInfo = therapies.map(t => {
        const data = getTherapyData(t.id);
        return `${t.name.toUpperCase()}: ${data.explanation} | Preço: ${data.price}`;
    }).join('\n');

    const {
        stage,
        messageCount,
        isPatient,
        needsUrgency,
        daysSinceLastContact,
        conversationHistory,
        conversationSummary,
        shouldGreet,
    } = context;

    // 🔥 NOVO: Monta contexto para System Prompt dinâmico
    const systemContext = {
        isHotLead: flags.visitLeadHot || stage === 'interessado_agendamento',
        isColdLead: flags.visitLeadCold || stage === 'novo',
        negativeScopeTriggered: /audiometria|bera|rpg|pilates/i.test(userText),
    };
    const dynamicSystemPrompt = buildDynamicSystemPrompt(systemContext);

    // 🧠 PERFIL DE IDADE A PARTIR DO HISTÓRICO
    let ageContextNote = "";
    if (conversationHistory && conversationHistory.length > 0) {
        const historyText = conversationHistory
            .map(msg => typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content))
            .join(" \n ")
            .toLowerCase();

        const ageMatch = historyText.match(/(\d{1,2})\s*anos\b/);
        if (ageMatch) {
            const detectedAge = parseInt(ageMatch[1], 10);
            if (!isNaN(detectedAge)) {
                const detectedAgeGroup =
                    detectedAge < 12 ? "criança" :
                        detectedAge < 18 ? "adolescente" :
                            "adulto";

                ageContextNote += `\nPERFIL_IDADE: já foi informado no histórico que o paciente é ${detectedAgeGroup} e tem ${detectedAge} anos. NÃO pergunte a idade novamente; use essa informação.`;
            }
        }

        if (/crian[çc]a|meu filho|minha filha|minha criança|minha crianca/.test(historyText)) {
            ageContextNote += `\nPERFIL_IDADE: o histórico deixa claro que o caso é de CRIANÇA. NÃO pergunte novamente se é para criança ou adulto; apenas siga a partir dessa informação.`;
        }
    }

    // 💸 INSIGHTS APRENDIDOS (respostas de preço que funcionaram melhor)
    let learnedContext = '';
    if (insights?.data?.effectivePriceResponses && flags.asksPrice) {
        const scenario = stage === 'novo' ? 'first_contact' : 'engaged';
        const bestResponse = insights.data.effectivePriceResponses.find(r => r.scenario === scenario);
        if (bestResponse) {
            learnedContext = `\n💡 PADRÃO DE SUCESSO: "${bestResponse.response}"`;
        }
    }

    const patientStatus = isPatient ? `\n⚠️ PACIENTE ATIVO - Tom próximo!` : '';
    const urgencyNote = needsUrgency ? `\n🔥 ${daysSinceLastContact} dias sem falar - reative com calor!` : '';

    // 🧠 ANÁLISE INTELIGENTE DO LEAD (SPRINT 2)
    let intelligenceNote = '';
    try {
        const analysis = await analyzeLeadMessage({
            text: userText,
            lead,
            history: conversationHistory || []
        });

        if (analysis?.extracted) {
            const { idade, urgencia, queixa } = analysis.extracted;
            const { primary, sentiment } = analysis.intent || {};

            intelligenceNote = `\n📊 PERFIL INTELIGENTE:`;
            if (idade) intelligenceNote += `\n- Idade: ${idade} anos`;
            if (queixa) intelligenceNote += `\n- Queixa: ${queixa}`;
            if (urgencia) intelligenceNote += `\n- Urgência: ${urgencia}`;
            if (primary) intelligenceNote += `\n- Intenção: ${primary}`;
            if (sentiment) intelligenceNote += `\n- Sentimento: ${sentiment}`;

            // 🔥 Alerta de urgência alta
            if (urgencia === 'alta') {
                intelligenceNote += `\n🔥 ATENÇÃO: Caso de urgência ALTA detectado - priorize contexto temporal!`;
            }

            console.log('🧠 [INTELLIGENCE]', analysis.extracted);
        }
    } catch (err) {
        console.warn('⚠️ leadIntelligence falhou (não crítico):', err.message);
    }

    // 🧠 MONTA MENSAGENS (declarado ANTES para ser usado pelo bloco de preço)
    const messages = [];

    if (conversationSummary) {
        messages.push({
            role: 'user',
            content: `📋 CONTEXTO DE CONVERSAS ANTERIORES:\n\n${conversationSummary}\n\n---\n\nAs mensagens abaixo são a continuação RECENTE desta conversa:`
        });
        messages.push({
            role: 'assistant',
            content: 'Entendi o contexto completo. Vou continuar a conversa de forma natural, lembrando de tudo que foi discutido.'
        });
    }

    if (conversationHistory && conversationHistory.length > 0) {
        const safeHistory = conversationHistory.map(msg => ({
            role: msg.role || 'user',
            content: typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify(msg.content),
        }));

        messages.push(...safeHistory);
    }

    // 🎯 SE PEDIR PREÇO, USA buildUserPromptWithValuePitch
    if (flags.asksPrice) {
        const enrichedFlags = {
            ...flags,
            conversationSummary: context.conversationSummary || '',
            topic: therapies[0]?.id || 'avaliacao_inicial',
            text: userText,
            ageGroup: ageContextNote.includes('criança') ? 'crianca' :
                ageContextNote.includes('adolescente') ? 'adolescente' :
                    ageContextNote.includes('adulto') ? 'adulto' : null
        };

        const pricePrompt = buildUserPromptWithValuePitch(enrichedFlags);

        console.log('💰 [PRICE PROMPT] Usando buildUserPromptWithValuePitch');

        // Adiciona o prompt de preço às mensagens
        messages.push({
            role: 'user',
            content: pricePrompt
        });

        const response = await anthropic.messages.create({
            model: AI_MODEL,
            max_tokens: 200,
            temperature: 0.7,
            system: [
                {
                    type: "text",
                    text: dynamicSystemPrompt,
                    cache_control: { type: "ephemeral" }
                }
            ],
            messages
        });

        return response.content[0]?.text?.trim() || "Como posso te ajudar? 💚";
    }

    // 🧠 PREPARA PROMPT ATUAL (lógica normal se NÃO for preço)
    const currentPrompt = `${userText}

📊 CONTEXTO DESTA MENSAGEM:
TERAPIAS DETECTADAS:
${therapiesInfo}

FLAGS: Preço=${flags.asksPrice} | Agendar=${flags.wantsSchedule}
ESTÁGIO: ${stage} (${messageCount} msgs totais)${patientStatus}${urgencyNote}${learnedContext}${ageContextNote}${intelligenceNote}

🎯 INSTRUÇÕES CRÍTICAS:
1. ${shouldGreet ? '✅ Pode cumprimentar naturalmente se fizer sentido' : '🚨 NÃO USE SAUDAÇÕES (Oi/Olá) - conversa está ativa'}
2. ${conversationSummary ? '🧠 Você TEM o resumo completo acima - USE esse contexto!' : '📜 Leia TODO o histórico de mensagens acima antes de responder'}
3. 🚨 NÃO PERGUNTE o que JÁ foi informado/discutido (idade, se é criança/adulto, área principal etc.)
4. Responda de forma acolhedora, focando na dúvida real.
5. Máximo 2–3 frases, tom natural e humano, como uma recepcionista experiente.
6. Exatamente 1 💚 no final.`;

    // Adiciona a mensagem atual ao histórico
    messages.push({
        role: 'user',
        content: currentPrompt
    });

    const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 200,
        temperature: 0.7,
        system: [
            {
                type: "text",
                text: dynamicSystemPrompt,
                cache_control: { type: "ephemeral" }
            }
        ],
        messages
    });

    return response.content[0]?.text?.trim() || "Como posso te ajudar? 💚";
}


/**
 * 🤖 IA COM CONTEXTO INTELIGENTE + CACHE MÁXIMO
 */
async function callAmandaAIWithContext(userText, lead, context, flagsFromOrchestrator = {}) {
    const { getLatestInsights } = await import('../services/amandaLearningService.js');

    const {
        stage = 'novo',
        messageCount = 0,
        mentionedTherapies = [],
        isPatient = false,
        needsUrgency = false,
        daysSinceLastContact = 0,
        conversationHistory = [],
        conversationSummary = null,
        shouldGreet = true
    } = context;

    // 🧩 FLAGS SÓ PRA ENTENDER PERFIL (criança/ado/adulto)
    const flags = flagsFromOrchestrator || detectAllFlags(userText, lead, context);

    // 🔥 NOVO: Monta contexto para System Prompt dinâmico
    const systemContext = {
        isHotLead: flags.visitLeadHot || stage === 'interessado_agendamento',
        isColdLead: flags.visitLeadCold || stage === 'novo',
        negativeScopeTriggered: /audiometria|bera|rpg|pilates/i.test(userText),
    };
    const dynamicSystemPrompt = buildDynamicSystemPrompt(systemContext);

    // 🎯 CONTEXTO DE TERAPIAS (AGORA EXISTE therapiesContext)
    const therapiesContext = mentionedTherapies.length > 0
        ? `\n🎯 TERAPIAS DISCUTIDAS: ${mentionedTherapies.join(', ')}`
        : '';

    // 🧠 PERFIL DE IDADE A PARTIR DO HISTÓRICO
    let historyAgeNote = "";
    if (conversationHistory && conversationHistory.length > 0) {
        const historyText = conversationHistory
            .map(msg => typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content))
            .join(" \n ")
            .toLowerCase();

        const ageMatch = historyText.match(/(\d{1,2})\s*anos\b/);
        if (ageMatch) {
            const age = parseInt(ageMatch[1], 10);
            if (!isNaN(age)) {
                const group =
                    age < 12 ? "criança" :
                        age < 18 ? "adolescente" :
                            "adulto";

                historyAgeNote += `\nPERFIL_IDADE_HISTÓRICO: já foi informado que o paciente é ${group} e tem ${age} anos. NÃO pergunte a idade novamente.`;
            }
        }

        if (/crian[çc]a|meu filho|minha filha|minha criança|minha crianca/.test(historyText)) {
            historyAgeNote += `\nPERFIL_IDADE_HISTÓRICO: o histórico mostra que o caso é de CRIANÇA. NÃO volte a perguntar se é para criança ou adulto.`;
        }
    }

    let ageProfileNote = '';
    if (flags.mentionsChild) {
        ageProfileNote = 'PERFIL: criança (fale com o responsável, não pergunte de novo se é criança ou adulto).';
    } else if (flags.mentionsTeen) {
        ageProfileNote = 'PERFIL: adolescente.';
    } else if (flags.mentionsAdult) {
        ageProfileNote = 'PERFIL: adulto falando de si.';
    }

    let stageInstruction = '';
    switch (stage) {
        case 'novo':
            stageInstruction = 'Seja acolhedora. Pergunte necessidade antes de preços.';
            break;
        case 'pesquisando_preco':
            stageInstruction = 'Lead já perguntou valores. Use VALOR→PREÇO→ENGAJAMENTO.';
            break;
        case 'engajado':
            stageInstruction = `Lead trocou ${messageCount} msgs. Seja mais direta.`;
            break;
        case 'interessado_agendamento':
            stageInstruction =
                'Lead quer agendar! Seu objetivo agora é COLETAR os dados mínimos para enviar pra equipe: ' +
                'nome completo, telefone e preferência de período (manhã ou tarde). ' +
                'Se ainda faltar alguma dessas informações, foque em confirmar o que JÁ recebeu ' +
                'e peça APENAS o que está faltando, em 1-2 frases, sem dizer que já encaminhou. ' +
                'Só diga que vai encaminhar os dados para a equipe QUANDO já tiver nome + telefone + período. ' +
                'Nesse momento, faça uma única frase de confirmação (sem repetir isso a cada mensagem).';
            break;
        case 'paciente':
            stageInstruction = 'PACIENTE ATIVO! Tom próximo.';
            break;
    }

    const patientNote = isPatient ? `\n⚠️ PACIENTE - seja próxima!` : '';
    const urgencyNote = needsUrgency ? `\n🔥 ${daysSinceLastContact} dias sem contato - reative!` : '';

    // 🧠 ANÁLISE INTELIGENTE DO LEAD (SPRINT 2)
    let intelligenceNote = '';
    try {
        const analysis = await analyzeLeadMessage({
            text: userText,
            lead,
            history: conversationHistory || []
        });

        if (analysis?.extracted) {
            const { idade, urgencia, queixa } = analysis.extracted;
            intelligenceNote = `\n📊 PERFIL: Idade ${idade || '?'} | Urgência ${urgencia || 'normal'} | Queixa ${queixa || 'geral'}`;

            if (urgencia === 'alta') {
                intelligenceNote += `\n🔥 URGÊNCIA ALTA DETECTADA!`;
            }
        }
    } catch (err) {
        console.warn('⚠️ leadIntelligence falhou (não crítico):', err.message);
    }

    const insights = await getLatestInsights();
    let openingsNote = '';
    let closingNote = '';

    if (insights?.data?.bestOpeningLines?.length) {
        const examples = insights.data.bestOpeningLines
            .slice(0, 3)
            .map(o => `- "${o.text}"`)
            .join('\n');

        openingsNote = `\n💡 EXEMPLOS DE ABERTURA QUE FUNCIONARAM:\n${examples}`;
    }

    if (insights?.data?.successfulClosingQuestions?.length) {
        const examples = insights.data.successfulClosingQuestions
            .slice(0, 5)
            .map(q => `- "${q.question}"`)
            .join('\n');

        closingNote = `\n💡 PERGUNTAS DE FECHAMENTO QUE LEVARAM A AGENDAMENTO:\n${examples}\nUse esse estilo (sem copiar exatamente).`;
    }

    const currentPrompt = `${userText}

CONTEXTO:
LEAD: ${lead?.name || 'Desconhecido'} | ESTÁGIO: ${stage} (${messageCount} msgs)${therapiesContext}${patientNote}${urgencyNote}${intelligenceNote}
${ageProfileNote ? `PERFIL_IDADE: ${ageProfileNote}` : ''}${historyAgeNote}
${openingsNote}${closingNote}

INSTRUÇÃO: ${stageInstruction}

REGRAS:
- ${shouldGreet ? 'Pode cumprimentar' : '🚨 NÃO use Oi/Olá - conversa ativa'}
- ${conversationSummary ? '🧠 USE o resumo acima' : '📜 Leia histórico acima'}
- 🚨 NÃO pergunte o que já foi dito (principalmente idade, se é criança/adulto e a área principal da terapia)
- Em fluxos de AGENDAMENTO:
  - Se ainda não tiver nome, telefone ou período definidos, confirme o que JÁ tem e peça só o que falta.
  - NÃO diga que vai encaminhar pra equipe enquanto faltar alguma dessas informações.
  - Depois que tiver nome + telefone + período, faça UMA única mensagem dizendo que vai encaminhar os dados.
- 1-3 frases, tom humano
- 1 pergunta engajadora (quando fizer sentido)
- 1 💚 final`;

    // 🧠 MONTA MENSAGENS COM CACHE MÁXIMO
    const messages = [];

    if (conversationSummary) {
        messages.push({
            role: 'user',
            content: `📋 CONTEXTO ANTERIOR:\n\n${conversationSummary}\n\n---\n\nMensagens recentes abaixo:`
        });
        messages.push({
            role: 'assistant',
            content: 'Entendi o contexto. Continuando...'
        });
    }

    if (conversationHistory && conversationHistory.length > 0) {
        const safeHistory = conversationHistory.map(msg => ({
            role: msg.role || 'user',
            content: typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify(msg.content),
        }));

        messages.push(...safeHistory);
    }

    messages.push({
        role: 'user',
        content: currentPrompt
    });

    const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 150,
        temperature: 0.6,
        system: [
            {
                type: "text",
                text: dynamicSystemPrompt,
                cache_control: { type: "ephemeral" }
            }
        ],
        messages
    });

    return response.content[0]?.text?.trim() || "Como posso te ajudar? 💚";
}



/**
 * 🎨 HELPER
 */
function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";
    const clean = text.replace(/💚/g, '').trim();
    return `${clean} 💚`;
}

/**
 * 🔒 REGRA DE ESCOPO DA CLÍNICA
 */
function enforceClinicScope(aiText = "", userText = "") {
    if (!aiText) return aiText;

    const t = aiText.toLowerCase();
    const u = (userText || "").toLowerCase();
    const combined = `${u} ${t}`;

    const isHearingExamContext =
        /(exame\s+de\s+au(diç|diçã|dição)|exame\s+auditivo|audiometria|bera|peate|emiss(ões)?\s+otoac[úu]stic)/i.test(
            combined
        );

    // 🚑 NOVO: contexto de frênulo / teste da linguinha
    const isFrenuloOrLinguinha =
        /\b(fr[eê]nulo|freio\s+lingual|fr[eê]nulo\s+lingual|teste\s+da\s+linguinha|linguinha)\b/i.test(
            combined
        );

    const mentionsRPGorPilates = /\brpg\b|pilates/i.test(combined);

    // 🔊 Só bloqueia exame auditivo se NÃO for caso de frênulo/linguinha
    if (isHearingExamContext && !isFrenuloOrLinguinha) {
        return (
            "Aqui na Clínica Fono Inova nós **não realizamos exames de audição** " +
            "(como audiometria ou BERA/PEATE). Nosso foco é na **avaliação e terapia fonoaudiológica**. " +
            "Podemos agendar uma avaliação para entender melhor o caso e, se necessário, te orientar " +
            "sobre onde fazer o exame com segurança. 💚"
        );
    }

    if (mentionsRPGorPilates) {
        return (
            "Na Fono Inova, a Fisioterapia é voltada para **atendimento terapêutico clínico**, " +
            "e não trabalhamos com **RPG ou Pilates**. Se você quiser, podemos agendar uma avaliação " +
            "para entender direitinho o caso e indicar a melhor forma de acompanhamento. 💚"
        );
    }

    return aiText;
}

export default getOptimizedAmandaResponse;