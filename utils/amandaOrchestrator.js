import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { analyzeLeadMessage } from "../services/intelligence/leadIntelligence.js";
import enrichLeadContext from "../services/leadContext.js";
import { detectAllFlags } from "./flagsDetector.js";
import { buildEquivalenceResponse } from "./responseBuilder.js";
import {
    detectAllTherapies,
    getTDAHResponse,
    isAskingAboutEquivalence,
    isTDAHQuestion,
} from "./therapyDetector.js";

import Followup from "../models/Followup.js";
import Leads from "../models/Leads.js";
import { callOpenAIFallback } from "../services/aiAmandaService.js";
import {
    autoBookAppointment,
    findAvailableSlots,
    formatDatePtBr,
    formatSlot
} from "../services/amandaBookingService.js";
import { handleInboundMessageForFollowups } from "../services/responseTrackingService.js";
import {
    buildDynamicSystemPrompt,
    buildUserPromptWithValuePitch,
    getManual,
} from "./amandaPrompt.js";
import { logBookingGate, mapFlagsToBookingProduct } from "./bookingProductMapper.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const recentResponses = new Map();

async function runAnthropicWithFallback({ systemPrompt, messages, maxTokens, temperature }) {
    try {
        const resp = await anthropic.messages.create({
            model: AI_MODEL,
            max_tokens: maxTokens,
            temperature,
            system: [
                {
                    type: "text",
                    text: systemPrompt,
                    cache_control: { type: "ephemeral" },
                },
            ],
            messages,
        });

        // 🔹 Aqui já normaliza pra STRING
        const text =
            resp?.content?.[0]?.text?.trim?.() ||
            null;

        return text;
    } catch (err) {
        console.error("[ORCHESTRATOR] Erro Anthropic, usando fallback OpenAI:", err.message);
        try {
            // callOpenAIFallback já devolve string
            return await callOpenAIFallback({
                systemPrompt,
                messages,
                maxTokens,
                temperature,
            });
        } catch (err2) {
            console.error("[ORCHESTRATOR] Erro também no fallback OpenAI:", err2.message);
            return null;
        }
    }
}

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
    } = {},
) {
    let stage = currentStage || "novo";

    // Já é paciente? não desce mais no funil
    if (stage === "paciente" || lead.isPatient) {
        return "paciente";
    }

    // 1️⃣ Sinais fortes de agendamento → vai pra interessado_agendamento
    if (
        flags.wantsSchedulingNow ||  // ex.: "a tarde", "sexta", "sim" respondendo proposta
        flags.wantsSchedule ||
        intent.primary === "agendar_urgente" ||
        intent.primary === "agendar_avaliacao"
    ) {
        return "interessado_agendamento";
    }

    // 2️⃣ Lead claramente em modo "ver preço"
    if (
        stage === "novo" &&
        (flags.asksPrice || intent.primary === "informacao_preco")
    ) {
        return "pesquisando_preco";
    }

    // 3️⃣ Se já perguntou preço antes e continua engajando → engajado
    if (
        (stage === "pesquisando_preco" || stage === "novo") &&
        (score >= 70 || messageCount >= 4)
    ) {
        return "engajado";
    }

    // 4️⃣ Se está em engajado e vem alguma intenção de agendar → sobe
    if (
        stage === "engajado" &&
        (flags.wantsSchedule ||
            intent.primary === "agendar_avaliacao" ||
            intent.primary === "agendar_urgente")
    ) {
        return "interessado_agendamento";
    }

    // 5️⃣ Se nada bate, mantém
    return stage;
}

/**
 * 🎯 ORQUESTRADOR COM CONTEXTO INTELIGENTE
 */
export async function getOptimizedAmandaResponse({
    content,
    userText,
    lead = {},
    context = {},
    messageId = null,
}) {
    const text = userText || content || "";
    const normalized = text.toLowerCase().trim();
    const SCHEDULING_REGEX = /\b(agendar|marcar|consulta|atendimento|avalia[cç][aã]o)\b|\b(qual\s+dia|qual\s+hor[áa]rio|tem\s+hor[áa]rio|dispon[ií]vel|disponivel|essa\s+semana)\b/i;

    console.log(`🎯 [ORCHESTRATOR] Processando: "${text}"`);

    // ➕ NOVO: integrar inbound do chat com followups
    if (lead?._id) {
        handleInboundMessageForFollowups(lead._id).catch((err) =>
            console.warn("[FOLLOWUP-REALTIME] erro:", err.message),
        );
    }

    // 🔁 Fluxo de pendência de dados do paciente (pós-escolha de horário)
    if (lead.pendingPatientInfoForScheduling && lead._id) {
        console.log("📝 [ORCHESTRATOR] Lead está pendente de dados do paciente");

        // 🔄 Recarrega o lead fresco do banco
        const freshLead = await Leads.findById(lead._id).lean().catch(() => null);
        const leadForInfo = freshLead || lead;

        const patientInfo = extractPatientInfoFromLead(leadForInfo, text);

        if (patientInfo.fullName && patientInfo.birthDate) {
            const chosenSlot =
                leadForInfo.pendingChosenSlot ||
                leadForInfo.pendingSchedulingSlots?.primary ||
                leadForInfo.autoBookingContext?.lastOfferedSlots?.primary;

            await Leads.findByIdAndUpdate(lead._id, {
                $unset: {
                    pendingPatientInfoForScheduling: "",
                    pendingChosenSlot: "",
                },
                $set: {
                    "patientInfo.fullName": patientInfo.fullName,
                    "patientInfo.birthDate": patientInfo.birthDate,
                    "patientInfo.phone": patientInfo.phone,
                    "patientInfo.email": patientInfo.email,
                },
            }).catch(() => { });

            if (chosenSlot) {
                console.log(
                    "🚀 [ORCHESTRATOR] Tentando agendar após coletar dados do paciente",
                );

                const bookingResult = await autoBookAppointment({
                    lead,
                    chosenSlot,
                    patientInfo,
                });

                if (bookingResult.success) {
                    await Leads.findByIdAndUpdate(lead._id, {
                        $set: {
                            status: "agendado",
                            stage: "paciente",
                            patientId: bookingResult.patientId,
                        },
                        $unset: {
                            pendingSchedulingSlots: "",
                            pendingChosenSlot: "",
                            autoBookingContext: "",
                        },
                    }).catch(() => { });

                    await Followup.updateMany(
                        { lead: lead._id, status: "scheduled" },
                        {
                            $set: {
                                status: "canceled",
                                canceledReason: "agendamento_confirmado_amanda",
                            },
                        },
                    ).catch(() => { });

                    const humanDate = formatDatePtBr(chosenSlot.date);
                    const humanTime = chosenSlot.time.slice(0, 5);

                    return `Perfeito! ✅ Agendado para ${humanDate} às ${humanTime} com ${chosenSlot.doctorName}. Qualquer coisa é só me avisar 💚`;
                } else if (bookingResult.code === "TIME_CONFLICT") {
                    return "Esse horário acabou de ser preenchido 😕 A equipe vai te enviar novas opções em instantes 💚";
                } else {
                    return "Tive um probleminha ao confirmar. A equipe vai te responder por aqui em instantes 💚";
                }
            } else {
                return "Obrigada pelos dados! A equipe vai te enviar as melhores opções de horário em instantes 💚";
            }
        } else {
            return "Não consegui pegar certinho. Me manda: Nome completo e data de nascimento (ex: João Silva, 12/03/2015)? 💚";
        }
    }

    // 🔁 Anti-resposta duplicada por messageId
    if (messageId) {
        const lastResponse = recentResponses.get(messageId);
        if (lastResponse && Date.now() - lastResponse < 5000) {
            console.warn(
                `[ORCHESTRATOR] Resposta duplicada bloqueada para ${messageId}`,
            );
            return null;
        }
        recentResponses.set(messageId, Date.now());

        if (recentResponses.size > 100) {
            const oldest = [...recentResponses.entries()].sort((a, b) => a[1] - b[1])[
                0
            ];
            recentResponses.delete(oldest[0]);
        }
    }

    const baseContext = lead._id
        ? await enrichLeadContext(lead._id)
        : {
            stage: "novo",
            isFirstContact: true,
            messageCount: 0,
            conversationHistory: [],
            conversationSummary: null,
            shouldGreet: true,
        };

    const enrichedContext = {
        ...baseContext,
        ...context,
    };

    // 🧩 FLAGS GERAIS
    const flags = detectAllFlags(text, lead, enrichedContext);


    const bookingProduct = mapFlagsToBookingProduct({ ...flags, text }, lead);

    if (!flags.therapyArea && bookingProduct.therapyArea) {
        flags.therapyArea = bookingProduct.therapyArea;
    }

    const isPurePriceQuestion =
        flags.asksPrice &&
        !flags.mentionsPriceObjection &&
        !flags.wantsSchedule &&
        !flags.wantsSchedulingNow;

    // prioridade máxima pra pergunta de preço
    if (isPurePriceQuestion) {
        const manualAnswer = tryManualResponse(normalized, enrichedContext, flags);

        if (manualAnswer) {
            return ensureSingleHeart(manualAnswer);
        }

        // fallback: usa o value pitch dinâmico
        const enrichedFlags = {
            ...flags,
            text,
            conversationSummary: enrichedContext.conversationSummary || "",
        };

        const systemContext = buildSystemContext(flags, text, newStage);
        const dynamicSystemPrompt = buildDynamicSystemPrompt(systemContext);
        const pricePrompt = buildUserPromptWithValuePitch(enrichedFlags);

        const messages = [{ role: "user", content: pricePrompt }];

        const textResp = await runAnthropicWithFallback({
            systemPrompt: dynamicSystemPrompt,
            messages,
            maxTokens: 300,
            temperature: 0.7,
        });

        return ensureSingleHeart(
            textResp || "A avaliação inicial é R$ 220; ela é o primeiro passo pra entender direitinho o que o seu filho precisa. Prefere essa semana ou a próxima? 💚",
        );
    }

    logBookingGate(flags);

    // 🧠 Análise inteligente da mensagem (uma vez só aqui em cima)
    let analysis = null;
    try {
        analysis = await analyzeLeadMessage({
            text,
            lead,
            history: enrichedContext.conversationHistory || [],
        });
    } catch (err) {
        console.warn("[ORCHESTRATOR] leadIntelligence falhou no orquestrador:", err.message);
    }

    // 🔀 Atualiza estágio do funil usando nextStage
    const stageFromContext = enrichedContext.stage || lead.stage || "novo";

    const newStage = nextStage(stageFromContext, {
        flags,
        intent: analysis?.intent || {},
        extracted: analysis?.extracted || {},
        score: analysis?.score ?? lead.conversionScore ?? 50,
        isFirstMessage: enrichedContext.isFirstContact,
        messageCount: enrichedContext.messageCount || 1,
        lead,
    });

    enrichedContext.stage = newStage;

    // 👀 Detecta mensagens "de agendamento" / avaliação / visita
    const isSchedulingLike =
        GENERIC_SCHEDULE_EVAL_REGEX.test(normalized) ||
        SCHEDULING_REGEX.test(normalized) ||
        flags.wantsSchedule ||
        flags.wantsSchedulingNow;

    // Contagem de mensagens da conversa (pra sua regra da "quarta vez")
    const msgCount = enrichedContext.messageCount || 1;

    // Usar funil de AVALIAÇÃO → VISITA APENAS:
    // - quando é mensagem de agendamento
    // - a partir da 4ª mensagem
    // - em estágios de lead (não paciente nem já agendando com slots)
    const shouldUseVisitFunnel =
        isSchedulingLike &&
        msgCount >= 4 && // 👈 AQUI: só depois da terceira resposta (na quarta)
        (newStage === "novo" || newStage === "pesquisando_preco" || newStage === "engajado") &&
        !enrichedContext.pendingSchedulingSlots &&
        !lead.pendingPatientInfoForScheduling;

    if (shouldUseVisitFunnel) {
        const visitAnswer = await callVisitFunnelAI({
            text,
            lead,
            context: enrichedContext,
            flags,
        });

        const scopedVisit = enforceClinicScope(visitAnswer, text);
        return ensureSingleHeart(scopedVisit);
    }

    // 1) FAQ / respostas 100% manuais (endereço, convênio, currículo, etc.)
    const manualAnswer = tryManualResponse(normalized, enrichedContext, flags);
    if (manualAnswer) {
        return ensureSingleHeart(manualAnswer);
    }

    // 2) Fluxo especial de TDAH (perguntas tipo "meu filho tem TDAH?")
    if (isTDAHQuestion(text)) {
        try {
            const tdahAnswer = await getTDAHResponse(text);
            if (tdahAnswer) {
                return ensureSingleHeart(tdahAnswer);
            }
        } catch (err) {
            console.warn("[ORCHESTRATOR] Erro em getTDAHResponse, seguindo fluxo normal:", err.message);
        }
    }

    // 3) Fluxo de equivalência de terapias
    //    (ex.: "qual a diferença entre fono e psicopedagogia?", "neuropsico x psicopedagogia")
    if (isAskingAboutEquivalence(text)) {
        const equivalenceAnswer = buildEquivalenceResponse();
        return ensureSingleHeart(equivalenceAnswer);
    }

    // 4) Detecção de terapias mencionadas explicitamente
    //    (fono, TO, fisio, psicologia, neuropsico etc.)
    let therapies = [];
    try {
        therapies = detectAllTherapies(text) || [];
    } catch (err) {
        console.warn("[ORCHESTRATOR] Erro em detectAllTherapies:", err.message);
        therapies = [];
    }

    // 🎯 BUSCA SLOTS QUANDO LEAD QUER AGENDAR
    if (
        (flags.wantsSchedule || flags.wantsSchedulingNow) &&
        !enrichedContext.pendingSchedulingSlots &&
        !lead.pendingPatientInfoForScheduling
    ) {
        // Detecta período preferido da mensagem
        let preferredPeriod = null;
        if (/\b(manh[ãa]|cedo)\b/i.test(text)) preferredPeriod = "manha";
        else if (/\b(tarde)\b/i.test(text)) preferredPeriod = "tarde";
        else if (/\b(noite)\b/i.test(text)) preferredPeriod = "noite";

        // Detecta dia preferido
        let preferredDay = null;
        const dayMatch = text.toLowerCase().match(
            /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/
        );
        if (dayMatch) {
            const dayMap = {
                domingo: "sunday", segunda: "monday", "terça": "tuesday", "terca": "tuesday",
                quarta: "wednesday", quinta: "thursday", sexta: "friday", "sábado": "saturday", sabado: "saturday"
            };
            preferredDay = dayMap[dayMatch[1]] || null;
        }

        console.log("🔍 [ORCHESTRATOR] Buscando slots para:", {
            therapyArea: bookingProduct.therapyArea,
            specialties: bookingProduct.specialties,
            preferredPeriod,
            preferredDay,
        });

        try {
            const slots = await findAvailableSlots({
                therapyArea: bookingProduct.therapyArea,
                specialties: bookingProduct.specialties,
                preferredDay,
                preferredPeriod,
                daysAhead: 30,
            });

            if (slots?.blocked && slots?.reason === "recesso") {
                return ensureSingleHeart(
                    "Estaremos em recesso do dia 19/12 até 05/01, mas já posso deixar sua avaliação agendada pro início de janeiro! Prefere a primeira semana de janeiro pela manhã ou tarde?"
                );
            }

            if (slots?.primary) {
                enrichedContext.pendingSchedulingSlots = slots;

                // Salva no lead para persistir entre mensagens
                if (lead._id) {
                    await Leads.findByIdAndUpdate(lead._id, {
                        $set: {
                            pendingSchedulingSlots: slots,
                            therapyArea: bookingProduct.therapyArea,
                        },
                    }).catch(() => { });
                }

                console.log("✅ [ORCHESTRATOR] Slots encontrados:", {
                    primary: formatSlot(slots.primary),
                    alternatives: slots.alternativesSamePeriod?.length || 0,
                });
            } else {
                console.log("⚠️ [ORCHESTRATOR] Nenhum slot disponível encontrado");
            }
        } catch (err) {
            console.error("❌ [ORCHESTRATOR] Erro ao buscar slots:", err.message);
        }
    }

    if (Array.isArray(therapies) && therapies.length > 0) {
        try {
            const therapyAnswer = await callClaudeWithTherapyData({
                therapies,
                flags,
                userText: text,
                lead,
                context: enrichedContext,
                analysis, // 👈 reaproveita a inteligência já calculada
            });

            const scoped = enforceClinicScope(therapyAnswer, text);
            return ensureSingleHeart(scoped);
        } catch (err) {
            console.error("[ORCHESTRATOR] Erro em callClaudeWithTherapyData, caindo no fluxo geral:", err);
        }
    }

    // 5) Fluxo geral (funil, preço, engajamento, agendamento, etc.)
    const genericAnswer = await callAmandaAIWithContext(
        text,
        lead,
        enrichedContext,
        flags,
        analysis
    );

    const finalScoped = enforceClinicScope(genericAnswer, text);
    return ensureSingleHeart(finalScoped);
}

/**
 * Extrai nome + data de nascimento do lead ou da mensagem atual
 */
function extractPatientInfoFromLead(lead, lastMessage) {
    let fullName = lead.patientInfo?.fullName || lead.name;
    let birthDate = lead.patientInfo?.birthDate;
    const phone = lead.contact?.phone || lead.phone;
    const email = lead.contact?.email || lead.email;

    if (!fullName || !birthDate) {
        const nameMatch = lastMessage.match(
            /(?:meu nome [eé]|me chamo|sou)\s+([a-zà-úA-ZÀ-Ú\s]+)/i,
        );
        if (nameMatch) {
            fullName = nameMatch[1].trim();
        }

        const dateMatch = lastMessage.match(
            /\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/,
        );
        if (dateMatch) {
            const [, day, month, year] = dateMatch;
            birthDate = `${year}-${month}-${day}`;
        }
    }

    return {
        fullName: fullName || null,
        birthDate: birthDate || null,
        phone: phone || null,
        email: email || null,
    };
}

/**
 * 🔥 FUNIL INICIAL: AVALIAÇÃO → VISITA (se recusar)
 */
async function callVisitFunnelAI({ text, lead, context = {}, flags = {} }) {
    const stage = context.stage || lead?.stage || "novo";

    const systemContext = buildSystemContext(flags, text, stage);
    const dynamicSystemPrompt = buildDynamicSystemPrompt(systemContext);

    const messages = [];

    if (context.conversationSummary) {
        messages.push({
            role: "user",
            content: `📋 CONTEXTO ANTERIOR:\n\n${context.conversationSummary}\n\n---\n\nMensagens recentes abaixo:`,
        });
        messages.push({
            role: "assistant",
            content:
                "Entendi o contexto. Vou seguir o funil de AVALIAÇÃO INICIAL como primeiro passo e, se o lead não quiser avaliação agora, ofereço VISITA PRESENCIAL leve como alternativa.",
        });
    }

    if (context.conversationHistory?.length) {
        const safeHistory = context.conversationHistory.map((msg) => ({
            role: msg.role || "user",
            content:
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
        }));
        messages.push(...safeHistory);
    }

    const visitPrompt = `
${text}

🎯 MODO AVALIAÇÃO + VISITA ATIVO

REGRAS DO FUNIL INICIAL:

1) PRIMEIRA OPÇÃO: AVALIAÇÃO INICIAL
- Sempre tente primeiro AGENDAR UMA AVALIAÇÃO INICIAL presencial.
- Explique que a avaliação serve pra entender o desenvolvimento, organizar o caso e definir quais terapias são indicadas.
- Fale em DIA + PERÍODO (manhã/tarde), nunca invente horário exato.

2) SEGUNDA OPÇÃO: VISITA LEVE (QUANDO AVALIAÇÃO NÃO FOR ACEITA)
- Se a pessoa disser que:
  • "ainda está só pesquisando",
  • "ainda não quer se comprometer",
  • "por enquanto só quer conhecer o espaço" ou algo parecido,
  então ofereça uma VISITA PRESENCIAL leve, sem compromisso.
- Deixe claro que a visita é só pra conhecer a clínica e tirar dúvidas.

3) COMO FALAR NA PRÁTICA:
- Primeiro: convide para AVALIAÇÃO INICIAL.
- Se recusar ou enrolar muito: ofereça VISITA como alternativa mais leve.
- Exemplo:
  "Podemos agendar uma avaliação inicial pra entender direitinho o desenvolvimento."
  → Se recusar:
  "Sem problema! Se você preferir, podemos combinar só uma visita rápida pra vocês conhecerem o espaço e tirarem dúvidas pessoalmente."

4) LEMBRETE:
- Nunca prometa horário exato, só [dia/período].
- Só diga que vai encaminhar pra equipe confirmar depois que tiver: nome completo + telefone + dia/período.

Use sempre o tom acolhedor, simples e profissional da Amanda 💚
`.trim();

    messages.push({ role: "user", content: visitPrompt });

    const textResp = await runAnthropicWithFallback({
        systemPrompt: dynamicSystemPrompt,
        messages,
        maxTokens: 300,
        temperature: 0.6,
    });

    return (
        textResp ||
        "Posso te ajudar a escolher um dia pra visitar a clínica? 💚"
    );
}

/**
 * 📖 MANUAL
 */
function tryManualResponse(normalizedText, context = {}, flags = {}) {
    const { isFirstContact, messageCount = 0 } = context;

    // 🌍 ENDEREÇO / LOCALIZAÇÃO
    if (/\b(endere[cç]o|onde fica|local|mapa|como chegar)\b/.test(normalizedText)) {
        return getManual("localizacao", "endereco");
    }

    // 💳 "queria/queria pelo plano"
    if (
        /\b(queria|preferia|quero)\b.*\b(plano|conv[eê]nio|unimed|ipasgo|amil)\b/i.test(
            normalizedText,
        )
    ) {
        // Fonte única: manual
        return getManual("planos_saude", "credenciamento");
    }

    // 🩺 PERGUNTA GERAL SOBRE PLANO/CONVÊNIO
    if (/\b(plano|conv[eê]nio|unimed|ipasgo|amil)\b/.test(normalizedText)) {
        return getManual("planos_saude", "credenciamento");
    }

    // 💰 PREÇO GENÉRICO (sem área explícita)
    if (
        /(pre[çc]o|preco|valor(es)?|quanto\s+custa|custa\s+quanto|qual\s+o\s+valor|qual\s+é\s+o\s+valor)/i
            .test(normalizedText) &&
        !/\b(neuropsic|fono|fonoaudiolog|psicolog|psicopedagog|terapia|fisio|musico)/i
            .test(normalizedText)
    ) {
        const area = inferAreaFromContext(normalizedText, context, flags);

        if (area === "psicologia") {
            return "Na psicologia, a avaliação inicial é R$ 200; depois o pacote mensal costuma ficar em torno de R$ 640 (1x/semana). Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚";
        }

        if (area === "fonoaudiologia") {
            return (
                "Na fonoaudiologia, a avaliação inicial é R$ 200. " +
                "Depois, cada sessão de fonoterapia fica em torno de R$ 180; " +
                "o valor mensal vai depender da frequência — muita gente começa com 1 vez por semana. " +
                "Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚"
            );
        }

        if (area === "terapia_ocupacional") {
            return "Na terapia ocupacional, a avaliação inicial é R$ 220; o pacote mensal fica em torno de R$ 720 (1x/semana). Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚";
        }

        if (area === "fisioterapia") {
            return "Na fisioterapia, a avaliação inicial é R$ 200; o pacote mensal costuma ficar em torno de R$ 640 (1x/semana). Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚";
        }

        if (area === "psicopedagogia") {
            return "Na psicopedagogia, a anamnese inicial é R$ 200 e o pacote mensal sai em torno de R$ 640 (1x/semana). Prefere agendar essa avaliação pra essa semana ou pra próxima? 💚";
        }

        if (area === "neuropsicologia") {
            return "Na neuropsicologia trabalhamos com avaliação completa em formato de pacote de sessões; o valor total hoje é R$ 2.500 em até 6x, ou R$ 2.300 à vista. Prefere deixar essa avaliação encaminhada pra começar em qual turno, manhã ou tarde? 💚";
        }

        return getManual("valores", "avaliacao");
    }

    // 👋 SAUDAÇÃO PURA
    if (PURE_GREETING_REGEX.test(normalizedText)) {
        if (isFirstContact || !messageCount) {
            return getManual("saudacao");
        }

        return "Oi! Que bom falar com você de novo 😊 Me conta, deu tudo certo com o agendamento ou ficou mais alguma dúvida? 💚";
    }

    // 💼 CURRÍCULO / VAGA / TRABALHO
    if (
        /\b(curr[ií]culo|curriculo|cv\b|trabalhar|emprego|trampo)\b/.test(
            normalizedText,
        )
    ) {
        return (
            "Que bom que você tem interesse em trabalhar com a gente! 🥰\n\n" +
            "Os currículos são recebidos **exclusivamente por e-mail**.\n" +
            "Por favor, envie seu currículo para **contato@clinicafonoinova.com.br**, " +
            "colocando no assunto a área em que você tem interesse.\n\n" +
            "Se quiser conhecer melhor nosso trabalho, é só acompanhar a clínica também no Instagram: **@clinicafonoinova** 💚"
        );
    }

    // 📱 INSTAGRAM / REDES
    if (
        /\b(insta(gram)?|rede[s]?\s+social(is)?|perfil\s+no\s+instagram)\b/.test(
            normalizedText,
        )
    ) {
        return "Claro! Você pode acompanhar nosso trabalho no Instagram pelo perfil **@clinicafonoinova**. 💚";
    }

    return null;
}

/**
 * 🔍 HELPER: Infere área pelo contexto
 */
function inferAreaFromContext(normalizedText, context = {}, flags = {}) {
    const t = (normalizedText || "").toLowerCase();

    const historyArray = Array.isArray(context.conversationHistory)
        ? context.conversationHistory
        : [];

    const historyTexts = historyArray.map((msg) =>
        (typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content)
        ).toLowerCase(),
    );

    const AREA_DEFS = [
        { id: "fonoaudiologia", regex: /\bfono|fonoaudiolog\b/ },
        { id: "psicologia", regex: /\bpsicolog|psicologia\b/ },
        { id: "terapia_ocupacional", regex: /\b(terapia\s+ocupacional|[^a-z]to[^a-z])\b/ },
        { id: "fisioterapia", regex: /\bfisio|fisioterap\b/ },
        { id: "psicopedagogia", regex: /\bpsicopedagog\b/ },
        { id: "neuropsicologia", regex: /\bneuropsicolog\b/ },
    ];

    const detectAreaInText = (txt) => {
        if (!txt) return null;
        const found = AREA_DEFS.filter((a) => a.regex.test(txt)).map((a) => a.id);
        if (found.length === 1) return found[0];
        return null;
    };

    if (flags.therapyArea) return flags.therapyArea;
    if (context.therapyArea) return context.therapyArea;

    const areaNow = detectAreaInText(t);
    if (areaNow) return areaNow;

    const recentTexts = historyTexts.slice(-5).reverse();
    for (const txt of recentTexts) {
        const area = detectAreaInText(txt);
        if (area) return area;
    }

    const combined = [t, ...historyTexts].join(" ");
    const fallbackArea = detectAreaInText(combined);
    if (fallbackArea) return fallbackArea;

    return null;
}

/**
 * 🤖 IA COM DADOS DE TERAPIAS + HISTÓRICO COMPLETO
 */
async function callClaudeWithTherapyData({
    therapies,
    flags,
    userText,
    lead,
    context,
    analysis: passedAnalysis = null,
}) {
    const { getTherapyData } = await import("./therapyDetector.js");
    const { getLatestInsights } = await import(
        "../services/amandaLearningService.js"
    );

    const therapiesInfo = therapies
        .map((t) => {
            const data = getTherapyData(t.id);
            if (!data) {
                return `${t.name.toUpperCase()}: (sem dados cadastrados ainda)`;
            }
            return `${t.name.toUpperCase()}: ${data.explanation} | Preço: ${data.price}`;
        })
        .join("\n");

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

    const systemContext = buildSystemContext(flags, userText, stage);
    const dynamicSystemPrompt = buildDynamicSystemPrompt(systemContext);

    // 🧠 PERFIL DE IDADE PELO HISTÓRICO
    let ageContextNote = "";
    if (conversationHistory && conversationHistory.length > 0) {
        const historyText = conversationHistory
            .map((msg) =>
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
            )
            .join(" \n ")
            .toLowerCase();

        const ageMatch = historyText.match(/(\d{1,2})\s*anos\b/);
        if (ageMatch) {
            const detectedAge = parseInt(ageMatch[1], 10);
            if (!isNaN(detectedAge)) {
                const detectedAgeGroup =
                    detectedAge < 12 ? "criança" : detectedAge < 18 ? "adolescente" : "adulto";

                ageContextNote += `\nPERFIL_IDADE: já foi informado no histórico que o paciente é ${detectedAgeGroup} e tem ${detectedAge} anos. NÃO pergunte a idade novamente; use essa informação.`;
            }
        }

        if (/crian[çc]a|meu filho|minha filha|minha criança|minha crianca/.test(historyText)) {
            ageContextNote +=
                "\nPERFIL_IDADE: o histórico deixa claro que o caso é de CRIANÇA. NÃO pergunte novamente se é para criança ou adulto; apenas siga a partir dessa informação.";
        }
    }

    const patientStatus = isPatient
        ? "\n⚠️ PACIENTE ATIVO - Tom próximo!"
        : "";
    const urgencyNote = needsUrgency
        ? `\n🔥 ${daysSinceLastContact} dias sem falar - reative com calor!`
        : "";

    // 🧠 ANÁLISE INTELIGENTE (reaproveita se já veio)
    let analysis = passedAnalysis;
    let intelligenceNote = "";

    if (!analysis) {
        try {
            analysis = await analyzeLeadMessage({
                text: userText,
                lead,
                history: conversationHistory || [],
            });
        } catch (err) {
            console.warn("⚠️ leadIntelligence falhou (não crítico):", err.message);
        }
    }

    if (analysis?.extracted) {
        const { idade, urgencia, queixa } = analysis.extracted;
        const { primary, sentiment } = analysis.intent || {};

        intelligenceNote = "\n📊 PERFIL INTELIGENTE:";
        if (idade) intelligenceNote += `\n- Idade: ${idade} anos`;
        if (queixa) intelligenceNote += `\n- Queixa: ${queixa}`;
        if (urgencia) intelligenceNote += `\n- Urgência: ${urgencia}`;
        if (primary) intelligenceNote += `\n- Intenção: ${primary}`;
        if (sentiment) intelligenceNote += `\n- Sentimento: ${sentiment}`;
        if (urgencia === "alta") {
            intelligenceNote +=
                "\n🔥 ATENÇÃO: Caso de urgência ALTA detectado - priorize contexto temporal!";
        }
    }

    const messages = [];

    if (conversationSummary) {
        messages.push({
            role: "user",
            content: `📋 CONTEXTO DE CONVERSAS ANTERIORES:\n\n${conversationSummary}\n\n---\n\nAs mensagens abaixo são a continuação RECENTE desta conversa:`,
        });
        messages.push({
            role: "assistant",
            content:
                "Entendi o contexto completo. Vou continuar a conversa de forma natural, lembrando de tudo que foi discutido.",
        });
    }

    if (conversationHistory && conversationHistory.length > 0) {
        const safeHistory = conversationHistory.map((msg) => ({
            role: msg.role || "user",
            content:
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
        }));
        messages.push(...safeHistory);
    }

    // 💸 Se pediu PREÇO → usa value pitch + insights
    if (flags.asksPrice) {
        const insights = await getLatestInsights();
        let learnedContext = "";

        if (insights?.data?.effectivePriceResponses) {
            const scenario = stage === "novo" ? "first_contact" : "engaged";
            const bestResponse = insights.data.effectivePriceResponses.find(
                (r) => r.scenario === scenario,
            );
            if (bestResponse) {
                learnedContext = `\n💡 PADRÃO DE SUCESSO: "${bestResponse.response}"`;
            }
        }

        const enrichedFlags = {
            ...flags,
            conversationSummary: context.conversationSummary || "",
            topic: therapies[0]?.id || "avaliacao_inicial",
            text: userText,
            ageGroup: ageContextNote.includes("criança")
                ? "crianca"
                : ageContextNote.includes("adolescente")
                    ? "adolescente"
                    : ageContextNote.includes("adulto")
                        ? "adulto"
                        : null,
        };

        const pricePrompt = buildUserPromptWithValuePitch(enrichedFlags);

        console.log("💰 [PRICE PROMPT] Usando buildUserPromptWithValuePitch");

        messages.push({
            role: "user",
            content: pricePrompt + learnedContext + intelligenceNote + patientStatus + urgencyNote,
        });

        const textResp = await runAnthropicWithFallback({
            systemPrompt: dynamicSystemPrompt,
            messages,
            maxTokens: 300,
            temperature: 0.7,
        });

        return textResp || "Como posso te ajudar? 💚";
    }

    // 🧠 Fluxo NORMAL (não é pergunta de preço)
    const currentPrompt = `${userText}

📊 CONTEXTO DESTA MENSAGEM:
TERAPIAS DETECTADAS:
${therapiesInfo}

FLAGS: Preço=${flags.asksPrice} | Agendar=${flags.wantsSchedule}
ESTÁGIO: ${stage} (${messageCount} msgs totais)${patientStatus}${urgencyNote}${ageContextNote}${intelligenceNote}

🎯 INSTRUÇÕES CRÍTICAS:
1. ${shouldGreet ? "✅ Pode cumprimentar naturalmente se fizer sentido" : "🚨 NÃO USE SAUDAÇÕES (Oi/Olá) - conversa está ativa"}
2. ${conversationSummary ? "🧠 Você TEM o resumo completo acima - USE esse contexto!" : "📜 Leia TODO o histórico de mensagens acima antes de responder"}
3. 🚨 NÃO PERGUNTE o que JÁ foi informado/discutido (idade, se é criança/adulto, área principal etc.)
4. Responda de forma acolhedora, focando na dúvida real.
5. Máximo 2–3 frases, tom natural e humano, como uma recepcionista experiente.
6. Exatamente 1 💚 no final.`;

    messages.push({
        role: "user",
        content: currentPrompt,
    });

    const textResp = await runAnthropicWithFallback({
        systemPrompt: dynamicSystemPrompt,
        messages,
        maxTokens: 300,
        temperature: 0.7,
    });

    return textResp || "Como posso te ajudar? 💚";
}

/**
 * 🤖 IA COM CONTEXTO INTELIGENTE + CACHE MÁXIMO
 */
async function callAmandaAIWithContext(
    userText,
    lead,
    context,
    flagsFromOrchestrator = {},
    analysisFromOrchestrator = null,
) {
    const { getLatestInsights } = await import(
        "../services/amandaLearningService.js"
    );

    const {
        stage = "novo",
        messageCount = 0,
        mentionedTherapies = [],
        isPatient = false,
        needsUrgency = false,
        daysSinceLastContact = 0,
        conversationHistory = [],
        conversationSummary = null,
        shouldGreet = true,
    } = context;

    const flags = flagsFromOrchestrator || detectAllFlags(userText, lead, context);

    const therapyAreaForScheduling =
        context.therapyArea || flags.therapyArea || lead.therapyArea;

    const hasAgeOrProfile =
        flags.mentionsChild ||
        flags.mentionsTeen ||
        flags.mentionsAdult ||
        context.ageGroup ||
        /\d+\s*anos?\b/i.test(userText);

    let scheduleInfoNote = "";
    if (stage === "interessado_agendamento") {
        if (!therapyAreaForScheduling && !hasAgeOrProfile) {
            scheduleInfoNote =
                "FALTAM DADOS PARA AGENDAR: não sabemos ainda a área (fono, psico, TO, fisio etc.) nem se é criança/adolescente/adulto. Antes de falar em encaminhar pra equipe ou oferecer horários, faça UMA pergunta simples e natural para descobrir área e perfil.";
        } else if (!therapyAreaForScheduling) {
            scheduleInfoNote =
                "FALTAM DADOS PARA AGENDAR: não sabemos ainda a área (fono, psico, TO, fisio etc.). Antes de oferecer horários, pergunte de forma acolhedora para qual área a família está buscando ajuda.";
        } else if (!hasAgeOrProfile) {
            scheduleInfoNote =
                "FALTAM DADOS PARA AGENDAR: não sabemos se o caso é criança, adolescente ou adulto. Antes de oferecer horários, pergunte de forma natural pra quem é (criança/adulto) e, se fizer sentido, idade aproximada.";
        }
    }

    const systemContext = buildSystemContext(flags, userText, stage);
    const dynamicSystemPrompt = buildDynamicSystemPrompt(systemContext);

    const therapiesContext =
        mentionedTherapies.length > 0
            ? `\n🎯 TERAPIAS DISCUTIDAS: ${mentionedTherapies.join(", ")}`
            : "";

    // 🧠 PERFIL DE IDADE DO HISTÓRICO
    let historyAgeNote = "";
    if (conversationHistory && conversationHistory.length > 0) {
        const historyText = conversationHistory
            .map((msg) =>
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
            )
            .join(" \n ")
            .toLowerCase();

        const ageMatch = historyText.match(/(\d{1,2})\s*anos\b/);
        if (ageMatch) {
            const age = parseInt(ageMatch[1], 10);
            if (!isNaN(age)) {
                const group = age < 12 ? "criança" : age < 18 ? "adolescente" : "adulto";
                historyAgeNote += `\nPERFIL_IDADE_HISTÓRICO: já foi informado que o paciente é ${group} e tem ${age} anos. NÃO pergunte a idade novamente.`;
            }
        }

        if (/crian[çc]a|meu filho|minha filha|minha criança|minha crianca/.test(historyText)) {
            historyAgeNote +=
                "\nPERFIL_IDADE_HISTÓRICO: o histórico mostra que o caso é de CRIANÇA. NÃO volte a perguntar se é para criança ou adulto.";
        }
    }

    let ageProfileNote = "";
    if (flags.mentionsChild) {
        ageProfileNote =
            "PERFIL: criança (fale com o responsável, não pergunte de novo se é criança ou adulto).";
    } else if (flags.mentionsTeen) {
        ageProfileNote = "PERFIL: adolescente.";
    } else if (flags.mentionsAdult) {
        ageProfileNote = "PERFIL: adulto falando de si.";
    }

    let stageInstruction = "";
    switch (stage) {
        case "novo":
            stageInstruction = "Seja acolhedora. Pergunte necessidade antes de preços.";
            break;
        case "pesquisando_preco":
            stageInstruction =
                "Lead já perguntou valores. Use VALOR→PREÇO→ENGAJAMENTO.";
            break;
        case "engajado":
            stageInstruction = `Lead trocou ${messageCount} msgs. Seja mais direta.`;
            break;
        case "interessado_agendamento":
            if (flags.wantsSchedule || flags.choseSlot || context.pendingSchedulingSlots) {
                stageInstruction =
                    "Lead já demonstrou que QUER AGENDAR e a mensagem fala de horário/vaga/dia. " +
                    "O sistema já te mostra horários REAIS disponíveis: use apenas esses. " +
                    "Seu objetivo é ajudar a pessoa a escolher um dos horários e coletar os dados mínimos " +
                    "do paciente (nome completo, data de nascimento e telefone se ainda não tiver). " +
                    "Se ainda faltar alguma dessas infos, confirme o que JÁ tem e peça só o que falta em 1–2 frases. " +
                    "Não invente novos horários e não diga que 'vai ver com a equipe'; considere que você já está " +
                    "acessando a agenda em tempo real.";
            } else {
                stageInstruction =
                    "Esse lead já mostrou interesse em agendar em algum momento, mas a mensagem atual é mais " +
                    "dúvida do que pedido de horário. Responda a dúvida e, se fizer sentido, lembre de forma leve " +
                    "que dá pra agendar uma avaliação quando a família se sentir pronta, sem pressionar.";
            }
            break;

        case "paciente":
            stageInstruction = "PACIENTE ATIVO! Tom próximo.";
            break;
    }

    const patientNote = isPatient ? "\n⚠️ PACIENTE - seja próxima!" : "";
    const urgencyNote = needsUrgency
        ? `\n🔥 ${daysSinceLastContact} dias sem contato - reative!`
        : "";

    // 🧠 ANÁLISE INTELIGENTE (reaproveita se veio do orquestrador)
    let analysis = analysisFromOrchestrator;
    let intelligenceNote = "";
    if (!analysis) {
        try {
            analysis = await analyzeLeadMessage({
                text: userText,
                lead,
                history: conversationHistory || [],
            });
        } catch (err) {
            console.warn("⚠️ leadIntelligence falhou (não crítico):", err.message);
        }
    }

    if (analysis?.extracted) {
        const { idade, urgencia, queixa } = analysis.extracted;
        intelligenceNote = `\n📊 PERFIL: Idade ${idade || "?"} | Urgência ${urgencia || "normal"
            } | Queixa ${queixa || "geral"}`;
        if (urgencia === "alta") {
            intelligenceNote += "\n🔥 URGÊNCIA ALTA DETECTADA!";
        }
    }

    const insights = await getLatestInsights();
    let openingsNote = "";
    let closingNote = "";

    if (insights?.data?.bestOpeningLines?.length) {
        const examples = insights.data.bestOpeningLines
            .slice(0, 3)
            .map((o) => `- "${o.text}"`)
            .join("\n");

        openingsNote = `\n💡 EXEMPLOS DE ABERTURA QUE FUNCIONARAM:\n${examples}`;
    }

    if (insights?.data?.successfulClosingQuestions?.length) {
        const examples = insights.data.successfulClosingQuestions
            .slice(0, 5)
            .map((q) => `- "${q.question}"`)
            .join("\n");

        closingNote = `\n💡 PERGUNTAS DE FECHAMENTO QUE LEVARAM A AGENDAMENTO:\n${examples}\nUse esse estilo (sem copiar exatamente).`;
    }

    let slotsInstruction = "";

    if (context.pendingSchedulingSlots?.primary) {
        const slots = context.pendingSchedulingSlots;

        const allSlots = (slots.all && slots.all.length
            ? slots.all
            : [
                slots.primary,
                ...(slots.alternativesSamePeriod || []),
            ]
        ).filter(Boolean);

        const periodStats = { morning: 0, afternoon: 0, evening: 0 };

        for (const s of allSlots) {
            const hour = parseInt(s.time.slice(0, 2), 10);
            if (hour < 12) periodStats.morning++;
            else if (hour < 18) periodStats.afternoon++;
            else periodStats.evening++;
        }

        const slotsText = [
            `1️⃣ ${formatSlot(slots.primary)}`,
            ...slots.alternativesSamePeriod.slice(0, 2).map((s, i) =>
                `${i + 2}️⃣ ${formatSlot(s)}`,
            ),
        ].join("\n");

        slotsInstruction = `
🎯 HORÁRIOS REAIS DISPONÍVEIS:
${slotsText}

PERÍODOS:
- Manhã: ${periodStats.morning}
- Tarde: ${periodStats.afternoon}
- Noite: ${periodStats.evening}

REGRAS CRÍTICAS:
- Se o paciente pedir "de manhã" e Manhã = 0:
  → Explique que, pra essa área, no momento as vagas estão concentradas nos horários acima
    (normalmente à tarde/noite) e ofereça 1–3 opções reais.
- Só diga que "tem de manhã" se Manhã > 0.
- Ofereça no máximo 2-3 desses horários.
- NÃO invente horário diferente.
- Fale sempre "dia + horário" (ex.: quinta às 14h).
- Pergunte qual o lead prefere.
`;
    } else if (stage === "interessado_agendamento") {
        slotsInstruction = `
⚠️ Ainda não conseguimos buscar horários disponíveis.
- Se o usuário escolher um período (manhã/tarde), use isso
- Diga que vai verificar com a equipe os melhores horários
- NÃO invente horário específico
`;
    }

    const currentPrompt = `${userText}

                                    CONTEXTO:
                                    LEAD: ${lead?.name || "Desconhecido"} | ESTÁGIO: ${stage} (${messageCount} msgs)${therapiesContext}${patientNote}${urgencyNote}${intelligenceNote}
                                    ${ageProfileNote ? `PERFIL_IDADE: ${ageProfileNote}` : ""}${historyAgeNote}
                                    ${scheduleInfoNote ? `\n${scheduleInfoNote}` : ""}${openingsNote}${closingNote}

                                    INSTRUÇÕES:
                                    - ${stageInstruction}
                                    ${slotsInstruction ? `- ${slotsInstruction}` : ""}

                                    REGRAS:
                                    - ${shouldGreet ? "Pode cumprimentar" : "🚨 NÃO use Oi/Olá - conversa ativa"}
                                    - ${conversationSummary ? "🧠 USE o resumo acima" : "📜 Leia histórico acima"}
                                    - 🚨 NÃO pergunte o que já foi dito (principalmente idade, se é criança/adulto e a área principal)
                                    - Em fluxos de AGENDAMENTO:
                                    - Se ainda não tiver nome, telefone ou período definidos, confirme o que JÁ tem e peça só o que falta.
                                    - NÃO diga que vai encaminhar pra equipe enquanto faltar alguma dessas informações.
                                    - Depois que tiver nome + telefone + período, faça UMA única mensagem dizendo que vai encaminhar os dados.
                                    - 1-3 frases, tom humano
                                    - 1 💚 final`;

    const messages = [];

    if (conversationSummary) {
        messages.push({
            role: "user",
            content: `📋 CONTEXTO ANTERIOR:\n\n${conversationSummary}\n\n---\n\nMensagens recentes abaixo:`,
        });
        messages.push({
            role: "assistant",
            content: "Entendi o contexto. Continuando...",
        });
    }

    if (conversationHistory && conversationHistory.length > 0) {
        const safeHistory = conversationHistory.map((msg) => ({
            role: msg.role || "user",
            content:
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
        }));
        messages.push(...safeHistory);
    }

    messages.push({
        role: "user",
        content: currentPrompt,
    });

    const textResp = await runAnthropicWithFallback({
        systemPrompt: dynamicSystemPrompt,
        messages,
        maxTokens: 300,
        temperature: 0.6,
    });

    return textResp || "Como posso te ajudar? 💚";
}

/**
 * 🎨 HELPER
 */
function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";
    const clean = text.replace(/💚/g, "").trim();
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
            combined,
        );

    const isFrenuloOrLinguinha =
        /\b(fr[eê]nulo|freio\s+lingual|fr[eê]nulo\s+lingual|teste\s+da\s+linguinha|linguinha)\b/i.test(
            combined,
        );

    const mentionsRPGorPilates = /\brpg\b|pilates/i.test(combined);

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

    // 🆕 ROUQUIDÃO PÓS-CIRURGIA
    const isPostSurgeryVoice =
        /\b(rouquid[aã]o|perda\s+de\s+voz|voz\s+rouca|afonia)\b/i.test(combined) &&
        /\b(p[oó]s[-\s]?(cirurgia|operat[oó]rio)|ap[oó]s\s+(a\s+)?cirurgia|depois\s+da\s+cirurgia|intuba[çc][aã]o|entuba[çc][aã]o|cirurgia\s+de\s+tireoide)\b/i.test(combined);

    if (isPostSurgeryVoice) {
        return (
            "Aqui na Fono Inova **não trabalhamos com reabilitação vocal pós-cirúrgica** " +
            "(como após intubação ou cirurgia de tireoide). " +
            "Nosso foco é em casos de rouquidão por uso excessivo da voz, " +
            "alterações vocais em professores, cantores, etc. " +
            "Se precisar de indicação de especialista pra esse caso, posso tentar te ajudar! 💚"
        );
    }

    return aiText;
}


const buildSystemContext = (flags, text = "", stage = "novo") => ({
    // Funil
    isHotLead: flags.visitLeadHot || stage === "interessado_agendamento",
    isColdLead: flags.visitLeadCold || stage === "novo",

    // Escopo negativo
    negativeScopeTriggered: /audiometria|bera|rpg|pilates/i.test(text),

    // 🛡️ OBJEÇÕES
    priceObjectionTriggered:
        flags.mentionsPriceObjection ||
        /outra\s+cl[ií]nica|mais\s+(barato|em\s+conta)|encontrei.*barato|vou\s+fazer\s+l[aá]|n[aã]o\s+precisa\s+mais|muito\s+caro|caro\s+demais/i.test(
            text,
        ),

    insuranceObjectionTriggered:
        flags.mentionsInsuranceObjection ||
        /queria\s+(pelo|usar)\s+plano|s[oó]\s+atendo\s+por\s+plano|particular\s+[eé]\s+caro|pelo\s+conv[eê]nio/i.test(
            text,
        ),

    timeObjectionTriggered:
        flags.mentionsTimeObjection ||
        /n[aã]o\s+tenho\s+tempo|sem\s+tempo|correria|agenda\s+cheia/i.test(text),

    otherClinicObjectionTriggered:
        flags.mentionsOtherClinicObjection ||
        /j[aá]\s+(estou|tô)\s+(vendo|fazendo)|outra\s+cl[ií]nica|outro\s+profissional/i.test(
            text,
        ),

    teaDoubtTriggered:
        flags.mentionsDoubtTEA ||
        /ser[aá]\s+que\s+[eé]\s+tea|suspeita\s+de\s+(tea|autismo)|muito\s+novo\s+pra\s+saber/i.test(
            text,
        ),
});

export default getOptimizedAmandaResponse;
