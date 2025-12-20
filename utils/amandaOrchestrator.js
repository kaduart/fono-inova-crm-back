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
    detectNegativeScopes,
    getPriceLinesForDetectedTherapies
} from "./therapyDetector.js";
import { urgencyScheduler } from "../services/intelligence/UrgencyScheduler.js";

import Followup from "../models/Followup.js";
import Leads from "../models/Leads.js";
import { callOpenAIFallback } from "../services/aiAmandaService.js";
import {
    autoBookAppointment,
    findAvailableSlots,
    formatDatePtBr,
    formatSlot,
    pickSlotFromUserReply
} from "../services/amandaBookingService.js";

import { handleInboundMessageForFollowups } from "../services/responseTrackingService.js";
import {
    buildDynamicSystemPrompt,
    buildUserPromptWithValuePitch,
    calculateUrgency,
    getManual,
} from "./amandaPrompt.js";
import { logBookingGate, mapFlagsToBookingProduct } from "./bookingProductMapper.js";
import { extractPreferredDateFromText } from "./dateParser.js";
import { buildContextPack } from "../services/intelligence/ContextPack.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const recentResponses = new Map();
const AI_MODEL = "claude-opus-4-5-20251101";

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
            messages: normalizeClaudeMessages(messages),
        });

        // 🔹 Aqui já normaliza pra STRING
        const text =
            resp?.content
                ?.filter((b) => b?.type === "text" && typeof b?.text === "string")
                ?.map((b) => b.text)
                ?.join("")
                ?.trim() || null;

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

    if (stage === "paciente" || lead.isPatient) {
        return "paciente";
    }

    const hasArea = !!(flags.therapyArea ||
        extracted?.therapyArea ||
        lead?.autoBookingContext?.mappedTherapyArea ||
        lead?.therapyArea
    );

    const hasProfile =
        !!(
            flags.mentionsChild ||
            flags.mentionsTeen ||
            flags.mentionsAdult ||
            extracted?.idade ||
            extracted?.age
        );

    if (
        flags.wantsSchedulingNow ||
        flags.wantsSchedule ||
        intent.primary === "agendar_urgente" ||
        intent.primary === "agendar_avaliacao"
    ) {
        // Se ainda não sabemos área e/ou perfil, primeiro TRIAR
        if (!hasArea || !hasProfile) return "triagem_agendamento";
        return "interessado_agendamento";
    }

    if (
        stage === "novo" &&
        (flags.asksPrice || intent.primary === "informacao_preco")
    ) {
        return "pesquisando_preco";
    }

    if (
        (stage === "pesquisando_preco" || stage === "novo") &&
        (score >= 70 || messageCount >= 4)
    ) {
        return "engajado";
    }

    if (
        stage === "engajado" &&
        (flags.wantsSchedule ||
            intent.primary === "agendar_avaliacao" ||
            intent.primary === "agendar_urgente")
    ) {
        return "interessado_agendamento";
    }

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

    const SCHEDULING_REGEX =
        /\b(agendar|marcar|consulta|atendimento|avalia[cç][aã]o)\b|\b(qual\s+dia|qual\s+hor[áa]rio|tem\s+hor[áa]rio|dispon[ií]vel|disponivel|essa\s+semana)\b/i;

    function hasAgeOrProfileNow(txt = "", flags = {}, ctx = {}) {
        const t = String(txt || "");
        const hasYears = /\b\d{1,2}\s*anos?\b/i.test(t);
        const hasMonths = /\b\d{1,2}\s*(mes|meses)\b/i.test(t);
        const mentionsBaby =
            /\b(beb[eê]|rec[eé]m[-\s]*nascid[oa]|rn)\b/i.test(t) || hasMonths;

        // Se for bebê e ainda não tem perfil, trate como "criança"
        if (
            mentionsBaby &&
            !flags.mentionsChild &&
            !flags.mentionsTeen &&
            !flags.mentionsAdult
        ) {
            flags.mentionsChild = true;
            if (!ctx.ageGroup) ctx.ageGroup = "crianca";
        }

        return !!(
            flags.mentionsChild ||
            flags.mentionsTeen ||
            flags.mentionsAdult ||
            ctx.ageGroup ||
            hasYears ||
            hasMonths
        );
    }

    function buildTriageSchedulingMessage({
        flags = {},
        bookingProduct = {},
        ctx = {},
    } = {}) {
        const knownArea =
            bookingProduct?.therapyArea ||
            flags?.therapyArea ||
            lead?.autoBookingContext?.mappedTherapyArea ||
            lead?.therapyArea;

        const needsArea = !knownArea;
        const needsProfile = !(
            flags.mentionsChild ||
            flags.mentionsTeen ||
            flags.mentionsAdult ||
            ctx.ageGroup
        );

        if (needsArea && needsProfile) {
            return "Oi! 😊 Pra eu te ajudar certinho: é pra qual área (Fono, Psicologia, TO, Fisioterapia ou Neuropsicológica) e qual a idade (meses ou anos)?";
        }
        if (needsArea) {
            return "Perfeito 😊 É pra qual área: Fono, Psicologia, TO, Fisioterapia ou Neuropsicológica?";
        }
        return "Perfeito 😊 Qual a idade do paciente (em meses ou anos)?";

    }

    // ✅ Wrappers defensivos (pra não quebrar se helpers não estiverem no arquivo/import)
    function safeCalculateUrgency(flags, txt) {
        try {
            if (typeof calculateUrgency === "function") return calculateUrgency(flags, txt);
        } catch (_) { }
        return { pitch: "" };
    }
    function safeGetPriceLinesForDetectedTherapies(detectedTherapies, opts = {}) {
        try {
            if (typeof getPriceLinesForDetectedTherapies === "function") {
                return getPriceLinesForDetectedTherapies(detectedTherapies, opts) || [];
            }
        } catch (_) { }
        return [];
    }

    console.log(`🎯 [ORCHESTRATOR] Processando: "${text}"`);

    // ➕ integrar inbound do chat com followups
    if (lead?._id) {
        handleInboundMessageForFollowups(lead._id).catch((err) =>
            console.warn("[FOLLOWUP-REALTIME] erro:", err.message),
        );
    }

    // 🔁 Fluxo: pendência de dados do paciente (pós-escolha de horário)
    if (lead?.pendingPatientInfoForScheduling && lead?._id) {
        console.log("📝 [ORCHESTRATOR] Lead está pendente de dados do paciente");

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
                console.log("🚀 [ORCHESTRATOR] Tentando agendar após coletar dados do paciente");

                const bookingResult = await autoBookAppointment({
                    lead: leadForInfo,
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
                    const humanTime = String(chosenSlot.time || "").slice(0, 5);

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
            console.warn(`[ORCHESTRATOR] Resposta duplicada bloqueada para ${messageId}`);
            return null;
        }
        recentResponses.set(messageId, Date.now());

        if (recentResponses.size > 100) {
            const oldest = [...recentResponses.entries()].sort((a, b) => a[1] - b[1])[0];
            recentResponses.delete(oldest[0]);
        }
    }

    const baseContext = lead?._id
        ? await enrichLeadContext(lead._id)
        : {
            stage: "novo",
            isFirstContact: true,
            messageCount: 0,
            conversationHistory: [],
            conversationSummary: null,
            shouldGreet: true,
        };

    // 1) ContextPack (com guard)
    const contextPack = lead?._id ? await buildContextPack(lead._id).catch(() => null) : null;

    // 2) Merge final do contexto (ContextPack entra ANTES das flags)
    const enrichedContext = {
        ...baseContext,
        ...context,
        ...(contextPack ? { mode: contextPack.mode, urgency: contextPack.urgency } : {}),
    };

    if (contextPack?.mode) console.log("[AmandaAI] ContextPack mode:", contextPack.mode);

    // 4) flags já enxergam mode/urgency
    const flags = detectAllFlags(text, lead, enrichedContext);

    // 🧮 Normaliza contagem de mensagens
    const historyLen = Array.isArray(enrichedContext.conversationHistory)
        ? enrichedContext.conversationHistory.length
        : enrichedContext.messageCount || 0;

    const msgCount = historyLen + 1;
    enrichedContext.messageCount = msgCount;

    // ✅ Se já tem slots pendentes e o lead respondeu escolhendo
    if (
        lead?._id &&
        (lead?.pendingSchedulingSlots?.primary || enrichedContext?.pendingSchedulingSlots?.primary)
    ) {
        const rawSlots =
            lead?.pendingSchedulingSlots ||
            enrichedContext?.pendingSchedulingSlots ||
            lead?.autoBookingContext?.lastOfferedSlots ||
            null;

        const safeRawSlots = rawSlots && typeof rawSlots === "object" ? rawSlots : {};
        const slotsCtx = {
            ...safeRawSlots,
            all: [
                safeRawSlots.primary,
                ...(safeRawSlots.alternativesSamePeriod || []),
                ...(safeRawSlots.alternativesOtherPeriod || []),
            ].filter(Boolean),
        };

        const onlyOne = slotsCtx.all.length === 1 ? slotsCtx.all[0] : null;
        const isYes = /\b(sim|confirmo|pode|ok|pode\s+ser|fechado|beleza)\b/i.test(text);
        const isNo = /\b(n[aã]o|nao|prefiro\s+outro|outro\s+hor[aá]rio)\b/i.test(text);

        if (onlyOne && isYes) {
            await Leads.findByIdAndUpdate(lead._id, {
                $set: { pendingChosenSlot: onlyOne, pendingPatientInfoForScheduling: true },
            }).catch(() => { });
            return "Perfeito! Pra eu confirmar, me manda **nome completo** e **data de nascimento** (ex: João Silva, 12/03/2015) 💚";
        }

        if (onlyOne && isNo) {
            return "Sem problema! Você prefere **manhã ou tarde** e qual **dia da semana** fica melhor? 💚";
        }

        const hasLetterChoice =
            /(?:^|\s)([A-F])(?:\s|$|[).,;!?])/i.test(text) ||
            /\bop[çc][aã]o\s*([A-F])\b/i.test(text);

        const looksLikeChoice =
            hasLetterChoice ||
            /\b(\d{1,2}:\d{2})\b/.test(text) ||
            /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/i.test(text) ||
            /\b(manh[ãa]|cedo|tarde|noite)\b/i.test(text);

        const { message: menuMsg, optionsText } = buildSlotMenuMessage(slotsCtx);

        if (!looksLikeChoice) {
            return menuMsg;
        }

        let chosen = pickSlotFromUserReply(text, slotsCtx, { strict: true });

        // Dedução: pediu período inexistente -> oferece o mais cedo
        if (!chosen) {
            const preferPeriod =
                /\b(manh[ãa]|cedo)\b/i.test(text)
                    ? "manha"
                    : /\b(tarde)\b/i.test(text)
                        ? "tarde"
                        : /\b(noite)\b/i.test(text)
                            ? "noite"
                            : null;

            const slotHour = (s) => {
                const h = parseInt(String(s?.time || "").slice(0, 2), 10);
                return Number.isFinite(h) ? h : null;
            };

            const matchesPeriod = (s, p) => {
                const h = slotHour(s);
                if (h === null) return false;
                if (p === "manha") return h < 12;
                if (p === "tarde") return h >= 12 && h < 18;
                if (p === "noite") return h >= 18;
                return true;
            };

            const sortKey = (s) => `${s.date}T${String(s.time).slice(0, 5)}`;
            const earliest = slotsCtx.all
                .slice()
                .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))[0];

            if (preferPeriod && earliest) {
                const hasPreferred = slotsCtx.all.some((s) => matchesPeriod(s, preferPeriod));
                if (!hasPreferred) {
                    await Leads.findByIdAndUpdate(lead._id, {
                        $set: { pendingChosenSlot: earliest, pendingPatientInfoForScheduling: true },
                    }).catch(() => { });

                    const prefLabel =
                        preferPeriod === "manha" ? "de manhã" : preferPeriod === "tarde" ? "à tarde" : "à noite";

                    return `Entendi que você prefere ${prefLabel}. Hoje não tenho vaga ${prefLabel}; o mais cedo disponível é **${formatSlot(
                        earliest,
                    )}**.\n\nPra eu confirmar, me manda **nome completo** e **data de nascimento** (ex: João Silva, 12/03/2015) 💚`;
                }
            }

            return `Não consegui identificar qual você escolheu 😅\n\n${optionsText}\n\nResponda A-F ou escreva o dia e a hora 💚`;
        }

        await Leads.findByIdAndUpdate(lead._id, {
            $set: { pendingChosenSlot: chosen, pendingPatientInfoForScheduling: true },
        }).catch(() => { });

        return "Perfeito! Pra eu confirmar esse horário, me manda **nome completo** e **data de nascimento** (ex: João Silva, 12/03/2015) 💚";
    }

    // 🔎 Data explícita no texto
    const parsedDateStr = extractPreferredDateFromText(text);
    if (parsedDateStr) flags.preferredDate = parsedDateStr;

    // ✅ bookingMapper sabe que estamos no fluxo de agendamento
    flags.inSchedulingFlow = Boolean(
        lead?.pendingSchedulingSlots?.primary ||
        enrichedContext?.pendingSchedulingSlots?.primary ||
        lead?.pendingChosenSlot ||
        lead?.pendingPatientInfoForScheduling ||
        lead?.autoBookingContext?.lastOfferedSlots?.primary ||
        lead?.autoBookingContext?.mappedTherapyArea ||
        enrichedContext?.stage === "interessado_agendamento" ||
        lead?.stage === "interessado_agendamento",
    );

    const bookingProduct = mapFlagsToBookingProduct({ ...flags, text }, lead);

    if (!flags.therapyArea && bookingProduct?.therapyArea) {
        flags.therapyArea = bookingProduct.therapyArea;
    }

    // ✅ Persistência: não trocar de área depois
    const resolvedTherapyArea =
        flags.therapyArea || lead?.autoBookingContext?.mappedTherapyArea || lead?.therapyArea || null;

    if (resolvedTherapyArea) {
        enrichedContext.therapyArea = resolvedTherapyArea;
        if (lead?._id && lead?.therapyArea !== resolvedTherapyArea) {
            Leads.findByIdAndUpdate(lead._id, { $set: { therapyArea: resolvedTherapyArea } }).catch(
                () => { },
            );
        }
    }

    const stageFromContext = enrichedContext.stage || lead?.stage || "novo";

    const isPurePriceQuestion =
        flags.asksPrice &&
        !flags.mentionsPriceObjection &&
        !flags.wantsSchedule &&
        !flags.wantsSchedulingNow;

    // ✅ prioridade máxima pra preço
    if (isPurePriceQuestion) {
        let detectedTherapies = detectAllTherapies(text);

        if (!detectedTherapies?.length) {
            if (flags.asksPsychopedagogy || /dificuldade.*(escola|aprendiz)/i.test(text)) {
                detectedTherapies = [{ id: "neuropsychological", name: "Neuropsicopedagogia" }];
            } else if (flags.mentionsSpeechTherapy) {
                detectedTherapies = [{ id: "speech", name: "Fonoaudiologia" }];
            } else if (flags.mentionsTEA_TDAH || /aten[cç][aã]o|hiperativ/i.test(text)) {
                detectedTherapies = [{ id: "neuropsychological", name: "Neuropsicologia" }];
            } else if (/comportamento|emo[cç][aã]o|ansiedad/i.test(text)) {
                detectedTherapies = [{ id: "psychology", name: "Psicologia" }];
            } else if (/motor|coordena[cç][aã]o|sensorial|rotina/i.test(text)) {
                detectedTherapies = [{ id: "occupational", name: "Terapia Ocupacional" }];
            } else {
                detectedTherapies = [];
            }
        }

        const priceLines = safeGetPriceLinesForDetectedTherapies(detectedTherapies, { max: 2 });
        const urgency = safeCalculateUrgency(flags, text);
        const priceText = (priceLines || []).join(" ").trim();

        return ensureSingleHeart(`${urgency?.pitch ? urgency.pitch + " " : ""}${priceText} Prefere agendar essa semana ou na próxima?`);
    }

    logBookingGate(flags, bookingProduct);

    // 🧠 Análise inteligente (uma vez)
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

    const wantsPlan = /\b(unimed|plano|conv[eê]nio|ipasgo|amil)\b/i.test(text);
    const isHardPlanCondition =
        /\b(s[oó]\s*se|apenas\s*se|somente\s*se|quero\s+continuar\s+se)\b.*\b(unimed|plano|conv[eê]nio)\b/i.test(
            text,
        );

    if (wantsPlan && lead?.acceptedPrivateCare !== true) {
        if (isHardPlanCondition) {
            if (lead?._id)
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: { insuranceHardNo: true, acceptedPrivateCare: false },
                }).catch(() => { });
        }

        return ensureSingleHeart(
            "Atendemos no particular e emitimos recibo/nota pra você tentar reembolso no plano. Quer que eu já te mostre os horários disponíveis? 💚",
        );
    }

    // 🔀 Atualiza estágio
    const newStage = nextStage(stageFromContext, {
        flags,
        intent: analysis?.intent || {},
        extracted: analysis?.extracted || {},
        score: analysis?.score ?? lead?.conversionScore ?? 50,
        isFirstMessage: enrichedContext.isFirstContact,
        messageCount: msgCount,
        lead,
    });

    enrichedContext.stage = newStage;

    const isSchedulingLikeText = GENERIC_SCHEDULE_EVAL_REGEX.test(normalized) || SCHEDULING_REGEX.test(normalized);
    const wantsScheduling = flags.wantsSchedule || flags.wantsSchedulingNow || isSchedulingLikeText;

    // 🦴🍼 Gate osteopata (físio bebê)
    const babyContext =
        /\b\d{1,2}\s*(mes|meses)\b/i.test(text) || /\b(beb[eê]|rec[eé]m[-\s]*nascid[oa]|rn)\b/i.test(text);

    const therapyAreaForGate =
        enrichedContext.therapyArea ||
        flags.therapyArea ||
        bookingProduct?.therapyArea ||
        lead?.autoBookingContext?.mappedTherapyArea ||
        lead?.therapyArea ||
        null;

    const shouldOsteoGate =
        Boolean(lead?._id) &&
        wantsScheduling &&
        babyContext &&
        therapyAreaForGate === "fisioterapia" &&
        !lead?.autoBookingContext?.osteopathyOk;

    if (shouldOsteoGate) {
        const mentionsOsteo = /\b(osteopata|osteopatia|osteo)\b/i.test(text);

        const saidYes =
            (/\b(sim|s\b|ja|j[aá]|passou|consultou|avaliou|foi)\b/i.test(text) && mentionsOsteo) ||
            /\b(osteop)\w*\s+(indicou|encaminhou|orientou)\b/i.test(text) ||
            /\bfoi\s+o\s+osteop\w*\s+que\s+indicou\b/i.test(text);

        const saidNo =
            (/\b(n[aã]o|nao|ainda\s+n[aã]o|ainda\s+nao|nunca)\b/i.test(text) &&
                (mentionsOsteo || /\bpassou\b/i.test(text))) ||
            /\b(n[aã]o|nao)\s+passou\b/i.test(text);

        const gatePending = Boolean(lead?.autoBookingContext?.osteopathyGatePending);

        if (gatePending) {
            if (saidYes) {
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: { "autoBookingContext.osteopathyOk": true },
                    $unset: { "autoBookingContext.osteopathyGatePending": "" },
                }).catch(() => { });
            } else if (saidNo) {
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: { "autoBookingContext.osteopathyOk": false },
                    $unset: { "autoBookingContext.osteopathyGatePending": "" },
                }).catch(() => { });

                return ensureSingleHeart(
                    "Perfeito 😊 Só pra alinhar: no caso de bebê, a triagem inicial precisa ser com nosso **Osteopata**. Depois da avaliação dele (e se ele indicar), a gente já encaminha pra Fisioterapia certinho. Você quer agendar a avaliação com o Osteopata essa semana ou na próxima?",
                );
            } else {
                return ensureSingleHeart(
                    "Só pra eu te direcionar certinho: o bebê **já passou pelo Osteopata** e foi ele quem indicou a Fisioterapia? 💚",
                );
            }
        } else {
            if (!mentionsOsteo) {
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: { "autoBookingContext.osteopathyGatePending": true },
                }).catch(() => { });

                return ensureSingleHeart(
                    "Só pra eu te direcionar certinho: o bebê **já passou pelo Osteopata** e foi ele quem indicou a Fisioterapia? 💚",
                );
            }

            if (saidYes) {
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: { "autoBookingContext.osteopathyOk": true },
                    $unset: { "autoBookingContext.osteopathyGatePending": "" },
                }).catch(() => { });
            }
        }
    }
    const RESCHEDULE_REGEX =
        /\b(remarcar|reagendar|novo\s+hor[aá]rio|trocar\s+hor[aá]rio)\b/i;
    // 🔎 Resistência a agendar
    const RESISTS_SCHEDULING_REGEX =
        /\b(s[oó]\s+pesquisando|s[oó]\s+estou\s+pesquisando|mais\s+pra\s+frente|depois\s+eu\s+vejo|agora\s+n[aã]o\s+consigo|por\s+enquanto\s+n[aã]o|s[oó]\s+queria\s+saber\s+os\s+valores?)\b/i;

    const isResistingScheduling =
        flags.visitLeadCold ||
        RESISTS_SCHEDULING_REGEX.test(normalized) ||
        analysis?.intent?.primary === "apenas_informacao" ||
        analysis?.intent?.primary === "pesquisa_preco";

    const shouldUseVisitFunnel =
        msgCount >= 4 &&
        isResistingScheduling &&
        !flags.wantsSchedule &&
        !flags.wantsSchedulingNow &&
        (newStage === "novo" || newStage === "pesquisando_preco" || newStage === "engajado") &&
        !enrichedContext.pendingSchedulingSlots &&
        !lead?.pendingPatientInfoForScheduling;

    const hasProfile =
        hasAgeOrProfileNow(text, flags, enrichedContext) ||
        /\b(meu|minha)\s+(filh[oa]|crian[çc]a)\b/i.test(text);

    if (/\b(meu|minha)\s+(filh[oa]|crian[çc]a)\b/i.test(text)) {
        flags.mentionsChild = true;
    }

    const hasArea = !!(
        bookingProduct?.therapyArea ||
        flags?.therapyArea ||
        lead?.autoBookingContext?.mappedTherapyArea ||
        lead?.therapyArea
    );

    if (bookingProduct?.product === "multi_servico") {
        return ensureSingleHeart(
            "Perfeito! Só confirmando: você quer **Fisioterapia** e **Teste da Linguinha**, certo? Quer agendar **primeiro qual dos dois**? 💚",
        );
    }

    if (RESCHEDULE_REGEX.test(normalized)) {
        return ensureSingleHeart(
            "Claro! Vamos remarcar 😊 Você prefere **manhã ou tarde** e qual **dia da semana** fica melhor pra você? 💚"
        );
    }

    const shouldForceTriage =
        wantsScheduling &&
        (!hasArea || !hasProfile) &&
        !enrichedContext?.pendingSchedulingSlots &&
        !lead?.pendingPatientInfoForScheduling;

    if (shouldForceTriage) {
        return ensureSingleHeart(
            buildTriageSchedulingMessage({ flags, bookingProduct, ctx: enrichedContext }),
        );
    }

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

    // 1) Manual
    const manualAnswer = tryManualResponse(normalized, enrichedContext, flags);
    if (manualAnswer) return ensureSingleHeart(manualAnswer);

    // 2) TDAH
    if (isTDAHQuestion(text)) {
        try {
            const tdahAnswer = await getTDAHResponse(text);
            if (tdahAnswer) return ensureSingleHeart(tdahAnswer);
        } catch (err) {
            console.warn("[ORCHESTRATOR] Erro em getTDAHResponse, seguindo fluxo normal:", err.message);
        }
    }

    // 3) Equivalência
    if (isAskingAboutEquivalence(text)) {
        const equivalenceAnswer = buildEquivalenceResponse();
        return ensureSingleHeart(equivalenceAnswer);
    }

    // 4) Detecção de terapias
    let therapies = [];
    try {
        therapies = detectAllTherapies(text) || [];
    } catch (err) {
        console.warn("[ORCHESTRATOR] Erro em detectAllTherapies:", err.message);
        therapies = [];
    }

    // 🎯 Busca slots quando quer agendar
    const therapyAreaForSlots =
        bookingProduct?.therapyArea ||
        flags?.therapyArea ||
        lead?.autoBookingContext?.mappedTherapyArea ||
        lead?.therapyArea ||
        enrichedContext?.therapyArea ||
        null;

    const specialtiesForSlots =
        (bookingProduct?.specialties?.length ? bookingProduct.specialties : null) ||
        lead?.autoBookingContext?.mappedSpecialties ||
        [];

    const hasAreaNow = !!therapyAreaForSlots;
    const hasProfileNow = hasAgeOrProfileNow(text, flags, enrichedContext);

    const shouldFetchSlots =
        Boolean(lead?._id) &&
        wantsScheduling &&
        hasAreaNow &&
        hasProfileNow &&
        !enrichedContext?.pendingSchedulingSlots?.primary &&
        !lead?.pendingSchedulingSlots?.primary &&
        !lead?.pendingPatientInfoForScheduling;

    if (shouldFetchSlots) {
        if (!therapyAreaForSlots) {
            console.log("⚠️ [ORCHESTRATOR] quer agendar mas sem therapyArea (triagem faltando)");
            return ensureSingleHeart(
                buildTriageSchedulingMessage({ flags, bookingProduct, ctx: enrichedContext }),
            );
        }

        let preferredPeriod = null;
        if (/\b(manh[ãa]|cedo)\b/i.test(text)) preferredPeriod = "manha";
        else if (/\b(tarde)\b/i.test(text)) preferredPeriod = "tarde";
        else if (/\b(noite)\b/i.test(text)) preferredPeriod = "noite";

        let preferredDay = null;
        const dayMatch = text.toLowerCase().match(/\b(segunda|ter[çc]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/);
        if (dayMatch) {
            const dayMap = {
                domingo: "sunday",
                segunda: "monday",
                "terça": "tuesday",
                terca: "tuesday",
                quarta: "wednesday",
                quinta: "thursday",
                sexta: "friday",
                "sábado": "saturday",
                sabado: "saturday",
            };
            preferredDay = dayMap[dayMatch[1]] || null;
        }

        const preferredSpecificDate = flags.preferredDate || null;

        console.log("🔍 [ORCHESTRATOR] Buscando slots para:", {
            therapyArea: therapyAreaForSlots,
            specialties: specialtiesForSlots,
            preferredPeriod,
            preferredDay,
            preferredSpecificDate,
        });

        try {
            const availableSlots = await findAvailableSlots({
                therapyArea: therapyAreaForSlots,
                specialties: specialtiesForSlots,
                preferredDay,
                preferredPeriod,
                preferredDate: preferredSpecificDate,
                daysAhead: 30,
            });

            if (!availableSlots?.primary) {
                return "No momento não achei horários certinhos pra essa área. Me diga: prefere manhã ou tarde, e qual dia da semana fica melhor? 💚";
            }

            // ======================================================
            // 🎯 Urgência (Amanda 2.0)
            // ======================================================
            const urgencyLevel =
                contextPack?.urgency?.level || enrichedContext?.urgency?.level || "NORMAL";

            if (urgencyLevel && availableSlots) {
                try {
                    const flatSlots = [
                        availableSlots.primary,
                        ...(availableSlots.alternativesSamePeriod || []),
                        ...(availableSlots.alternativesOtherPeriod || []),
                    ].filter(Boolean);

                    const prioritized = urgencyScheduler(flatSlots, urgencyLevel).slice(0, 6);

                    if (prioritized.length) {
                        availableSlots.primary = prioritized[0];
                        availableSlots.alternativesSamePeriod = prioritized.slice(1, 4);
                        availableSlots.alternativesOtherPeriod = prioritized.slice(4, 6);
                    }


                    console.log(`🔎 Urgência aplicada (${urgencyLevel}) → ${prioritized.length} slots priorizados`);
                } catch (err) {
                    console.error("Erro ao aplicar urgência:", err);
                }
            }

            await Leads.findByIdAndUpdate(lead._id, {
                $set: {
                    pendingSchedulingSlots: availableSlots,
                    urgencyApplied: urgencyLevel,
                    "autoBookingContext.active": true,
                    "autoBookingContext.mappedTherapyArea": therapyAreaForSlots,
                    "autoBookingContext.mappedSpecialties": specialtiesForSlots,
                    "autoBookingContext.mappedProduct": bookingProduct?.product,
                    "autoBookingContext.lastOfferedSlots": availableSlots,
                },
            }).catch(() => { });

            enrichedContext.pendingSchedulingSlots = availableSlots;

            // ✅ Fonte única de menu A..F
            const { message: menuMsg, optionsText, ordered, letters } = buildSlotMenuMessage(availableSlots);

            if (!menuMsg || !ordered?.length) {
                // fallback seguro (não mata o fluxo)
                return ensureSingleHeart(
                    "No momento não encontrei horários disponíveis. Quer me dizer se prefere manhã ou tarde, e qual dia da semana fica melhor? 💚"
                );
            }

            // ✅ allowed baseado no que realmente existe
            const allowed = letters.slice(0, ordered.length).join(", ");

            // (Opcional) se você usa isso em alguma instrução pro LLM depois, deixa
            enrichedContext.bookingSlotsForLLM = {
                primary: availableSlots?.primary ? formatSlot(availableSlots.primary) : null,
                alternativesSamePeriod: (availableSlots?.alternativesSamePeriod || []).map(formatSlot),
                alternativesOtherPeriod: (availableSlots?.alternativesOtherPeriod || []).map(formatSlot),
                preferredDate: preferredSpecificDate,
            };

            console.log("✅ [ORCHESTRATOR] Slots encontrados:", {
                primary: availableSlots?.primary ? formatSlot(availableSlots.primary) : null,
                alternatives: availableSlots?.alternativesSamePeriod?.length || 0,
            });

            const urgencyPrefix =
                urgencyLevel === "ALTA"
                    ? "Entendo a urgência do caso. Separei os horários mais próximos pra você 👇\n\n"
                    : urgencyLevel === "MEDIA"
                        ? "Pra não atrasar o cuidado, organizei boas opções de horário 👇\n\n"
                        : "";

            // ✅ Retorno único e consistente (garante 1 💚)
            return ensureSingleHeart(
                `${urgencyPrefix}Tenho esses horários no momento:\n\n${optionsText}\n\nQual você prefere? (${allowed})`
            );

        } catch (err) {
            console.error("❌ [ORCHESTRATOR] Erro ao buscar slots:", err?.message || err);
            return "Tive um probleminha ao checar os horários agora 😕 Você prefere **manhã ou tarde** e qual **dia da semana** fica melhor? 💚";
        }
    }

    // IA com terapias
    if (Array.isArray(therapies) && therapies.length > 0) {
        try {
            const therapyAnswer = await callClaudeWithTherapyData({
                therapies,
                flags,
                userText: text,
                lead,
                context: enrichedContext,
                analysis,
            });

            const scoped = enforceClinicScope(therapyAnswer, text);
            return ensureSingleHeart(scoped);
        } catch (err) {
            console.error("[ORCHESTRATOR] Erro em callClaudeWithTherapyData, caindo no fluxo geral:", err);
        }
    }

    // Fluxo geral
    const genericAnswer = await callAmandaAIWithContext(text, lead, enrichedContext, flags, analysis);

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
    const askedLocation = /\b(endere[cç]o|onde fica|local|mapa|como chegar)\b/.test(normalizedText);
    const askedPrice =
        /(pre[çc]o|preco|valor(es)?|quanto\s+custa|custa\s+quanto|qual\s+o\s+valor|qual\s+[eé]\s+o\s+valor)/i.test(normalizedText);

    // ✅ Pergunta “valor + onde fica” na mesma mensagem → responde os dois
    if (askedLocation && askedPrice) {
        const area = inferAreaFromContext(normalizedText, context, flags);
        const addr = getManual("localizacao", "endereco");

        if (!area) {
            return (
                addr +
                "\n\nSobre valores: me diz se é pra **Fono**, **Psicologia**, **TO**, **Fisioterapia** ou **Neuropsicológica** que eu já te passo certinho."
            );
        }

        return addr + "\n\n" + getManual("valores", "avaliacao");
    }

    if (askedLocation) {
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

        if (!area) {
            return "Pra te passar o valor certinho, seria pra Fono, Psicologia, TO, Fisioterapia ou Neuropsicológica? 💚";
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
        { id: "fonoaudiologia", regex: /\b(fono|fonoaudiolog(?:ia|o)?)\b/ },
        { id: "terapia_ocupacional", regex: /\b(terapia\s+ocupacional|t\.?\s*o\.?)\b/ },
        { id: "fisioterapia", regex: /\bfisio|fisioterap\b/ },
        { id: "psicopedagogia", regex: /\bpsicopedagog\b/ },
        { id: "psicologia", regex: /\b(psicolog(?:ia|o)?)(?!\s*pedagog|.*neuro)\b/i },
        { id: "neuropsicologia", regex: /\bneuropsicolog(?:ia|o)?\b/i },
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
    const { mentionsOrelhinha } = detectNegativeScopes(userText);

    if (mentionsOrelhinha) {
        // IMPORTANTE: não “empurra” linguinha se não foi citado
        const detected = detectAllTherapies(userText);
        const hasLinguinha = detected.some(t => t.id === "tongue_tie");

        return hasLinguinha
            ? "O teste da orelhinha (triagem auditiva/TAN) nós não realizamos aqui. O Teste da Linguinha a gente faz sim (R$ 150). Quer agendar pra essa semana ou pra próxima? 💚"
            : "O teste da orelhinha (triagem auditiva/TAN) nós não realizamos aqui. Mas podemos te ajudar com avaliação e terapias (Fono, Psico, TO, Fisio…). O que você está buscando exatamente: avaliação, terapia ou um exame específico? 💚";
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

        const prompt = buildUserPromptWithValuePitch(enrichedFlags);
        console.log("💰 [PRICE PROMPT] Usando buildUserPromptWithValuePitch");

        messages.push({
            role: "user",
            content: prompt + learnedContext + intelligenceNote + patientStatus + urgencyNote,
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
        context.therapyArea ||
        flags.therapyArea ||
        lead?.autoBookingContext?.mappedTherapyArea ||
        lead?.therapyArea;

    const hasAgeOrProfile =
        flags.mentionsChild ||
        flags.mentionsTeen ||
        flags.mentionsAdult ||
        context.ageGroup ||
        /\d+\s*anos?\b/i.test(userText);

    let scheduleInfoNote = "";

    if (stage === "interessado_agendamento") {
        // canal WhatsApp: já temos o telefone do lead
        scheduleInfoNote =
            "No WhatsApp, considere que o telefone de contato principal já é o número desta conversa. " +
            "Para agendar, você precisa garantir: nome completo do paciente e um dia/período preferido. " +
            "Só peça outro telefone se a pessoa fizer questão de deixar um número diferente.";

        if (!therapyAreaForScheduling && !hasAgeOrProfile) {
            scheduleInfoNote +=
                " Ainda faltam: área principal (fono, psico, TO etc.) e se é criança/adolescente/adulto.";
        } else if (!therapyAreaForScheduling) {
            scheduleInfoNote +=
                " Ainda falta descobrir a área principal (fono, psico, TO etc.).";
        } else if (!hasAgeOrProfile) {
            scheduleInfoNote +=
                " Ainda falta deixar claro se é criança, adolescente ou adulto.";
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

        case "triagem_agendamento":
            stageInstruction =
                "Lead quer agendar, mas ainda falta TRIAGEM. Faça 1–2 perguntas no máximo para descobrir: " +
                "1) qual área (fono/psico/TO/fisio/neuropsico) e 2) para quem (criança/adolescente/adulto). " +
                "Não ofereça horários e não fale de valores agora. Seja direta e humana.";
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
                    "do paciente: nome completo e data de nascimento. " +
                    "Considere que o telefone de contato principal é o número desta conversa (WhatsApp); " +
                    "só peça outro telefone se a pessoa quiser deixar um número diferente.";
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
                                    - Em fluxos de AGENDAMENTO (WhatsApp):
                                    - Considere que o telefone de contato principal já é o número desta conversa.
                                    - Garanta que você tenha: nome completo do paciente + dia/período preferido.
                                    - Só peça outro telefone se a pessoa quiser deixar um número diferente.
                                    - Depois que tiver esses dados, faça UMA única mensagem dizendo que vai encaminhar o agendamento pra equipe.

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

function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";

    let clean = text.replace(/💚/g, "").trim();

    // 1) Remove vocativo tipo "Obrigada, Carlos" / "Obrigado, João" no começo
    clean = clean.replace(
        /^(obrigad[oa]\s*,?\s+[a-zÀ-ú]+(?:\s+[a-zÀ-ú]+)*)/i,
        (match) => {
            // Normaliza pra um agradecimento neutro
            return /obrigada/i.test(match) ? "Obrigada" : "Obrigado";
        }
    );

    // 2) Também dá pra limpar "Oi, Carlos" no começo, se quiser
    clean = clean.replace(
        /^(oi|olá|ola)\s*,?\s+[a-zÀ-ú]+(?:\s+[a-zÀ-ú]+)*/i,
        (match, oi) => {
            // vira só "Oi" / "Olá"
            return oi.charAt(0).toUpperCase() + oi.slice(1).toLowerCase();
        }
    );

    clean = clean.trim();

    return `${clean} 💚`;
}

function normalizeClaudeMessages(messages = []) {
    return messages.map((m) => ({
        role: m.role,
        content:
            typeof m.content === "string"
                ? [{ type: "text", text: m.content }]
                : m.content,
    }));
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
        /(teste\s+da\s+orelhinha|triagem\s+auditiva(\s+neonatal)?|\bTAN\b|emiss(ões|oes)?\s+otoac(u|ú)stic(as)?|exame\s+auditivo|audiometria|bera|peate)/i
            .test(combined);

    const isFrenuloOrLinguinha =
        /\b(fr[eê]nulo|freio\s+lingual|fr[eê]nulo\s+lingual|teste\s+da\s+linguinha|linguinha)\b/i.test(
            combined,
        );
    const mentionsOrelhinha =
        /(teste\s+da\s+orelhinha|triagem\s+auditiva(\s+neonatal)?|\bTAN\b)/i.test(combined);

    if (mentionsOrelhinha) {
        return (
            "O teste da orelhinha (triagem auditiva) nós **não realizamos** aqui. " +
            "A gente realiza o **Teste da Linguinha (R$150)**, e se você quiser eu já te passo horários pra agendar 💚"
        );
    }
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
