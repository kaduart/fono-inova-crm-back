import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { analyzeLeadMessage } from "../services/intelligence/leadIntelligence.js";
import enrichLeadContext from "../services/leadContext.js";
import { detectAllFlags, deriveFlagsFromText, resolveTopicFromFlags } from "./flagsDetector.js";
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
const AI_MODEL = "claude-sonnet-4-20250514";

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

const GENERIC_SCHEDULE_EVAL_REGEX =
    /\b(agendar|marcar|agendamento|quero\s+agendar|gostaria\s+de\s+agendar)\b.*\b(avalia[çc][aã]o)\b/i;

// ============================================================================
// 🆕 HELPERS DE EXTRAÇÃO (ADICIONADOS PARA CORRIGIR O LOOP)
// ============================================================================

/**
 * Extrai idade da mensagem (aceita "4", "4 anos", "tem 4", "fez 4", "4 aninhos")
 */
function extractAgeFromText(text) {
    const t = (text || "").trim();

    // "4 anos", "4anos", "4 aninhos"
    const yearsMatch = t.match(/\b(\d{1,2})\s*(anos?|aninhos?)\b/i);
    if (yearsMatch) return { age: parseInt(yearsMatch[1]), unit: "anos" };

    // "7 meses", "7meses"
    const monthsMatch = t.match(/\b(\d{1,2})\s*(m[eê]s|meses)\b/i);
    if (monthsMatch) return { age: parseInt(monthsMatch[1]), unit: "meses" };

    // "tem 4", "fez 4", "completou 4"
    const fezMatch = t.match(/\b(?:tem|fez|completou)\s+(\d{1,2})\b/i);
    if (fezMatch) return { age: parseInt(fezMatch[1]), unit: "anos" };

    // Número puro "4" (só se for a mensagem inteira ou quase)
    const pureMatch = t.match(/^\s*(\d{1,2})\s*$/);
    if (pureMatch) return { age: parseInt(pureMatch[1]), unit: "anos" };

    return null;
}

/**
 * Extrai período da mensagem (normaliza para evitar problemas de encoding)
 */
function extractPeriodFromText(text) {
    // Normaliza removendo acentos para evitar problemas de encoding
    const t = (text || "").toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/\b(manha|cedo)\b/.test(t)) return "manha";
    if (/\b(tarde)\b/.test(t)) return "tarde";
    if (/\b(noite)\b/.test(t)) return "noite";
    return null;
}

/**
 * Calcula ageGroup a partir da idade
 */
function getAgeGroup(age, unit) {
    if (unit === "meses") return "crianca";
    if (age <= 12) return "crianca";
    if (age <= 17) return "adolescente";
    return "adulto";
}

/**
 * Formata opções de slots para exibição (A, B, C...)
 */
function buildSlotMenuMessage(slots) {
    const letters = ["A", "B", "C", "D", "E", "F"];
    const all = [
        slots?.primary,
        ...(slots?.alternativesSamePeriod || []),
        ...(slots?.alternativesOtherPeriod || []),
    ].filter(Boolean);

    if (!all.length) {
        return { message: null, optionsText: "", ordered: [], letters: [] };
    }

    const ordered = all.slice(0, 6);
    const optionsText = ordered.map((s, i) => `${letters[i]}) ${formatSlot(s)}`).join("\n");
    const usedLetters = letters.slice(0, ordered.length);

    const message = `Tenho esses horários:\n\n${optionsText}\n\nQual você prefere? (${usedLetters.join(", ")})`;

    return { message, optionsText, ordered, letters: usedLetters };
}

// ============================================================================
// 🧭 STATE MACHINE DE FUNIL
// ============================================================================

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
            extracted?.age ||
            lead?.patientInfo?.age ||
            lead?.ageGroup
        );

    if (
        flags.wantsSchedulingNow ||
        flags.wantsSchedule ||
        intent.primary === "agendar_urgente" ||
        intent.primary === "agendar_avaliacao"
    ) {
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

function hasAgeOrProfileNow(txt = "", flags = {}, ctx = {}, lead = {}) {
    const t = String(txt || "");
    const hasYears = /\b\d{1,2}\s*anos?\b/i.test(t);
    const hasMonths = /\b\d{1,2}\s*(mes|meses)\b/i.test(t);
    const mentionsBaby =
        /\b(beb[eê]|rec[eé]m[-\s]*nascid[oa]|rn)\b/i.test(t) || hasMonths;

    if (
        mentionsBaby &&
        !flags.mentionsChild &&
        !flags.mentionsTeen &&
        !flags.mentionsAdult
    ) {
        flags.mentionsChild = true;
        if (!ctx.ageGroup) ctx.ageGroup = "crianca";
    }

    // 🆕 VERIFICA TAMBÉM O LEAD (dados já salvos)
    return !!(
        lead?.patientInfo?.age ||
        lead?.ageGroup ||
        flags.mentionsChild ||
        flags.mentionsTeen ||
        flags.mentionsAdult ||
        ctx.ageGroup ||
        hasYears ||
        hasMonths ||
        extractAgeFromText(t)
    );
}

function buildTriageSchedulingMessage({
    flags = {},
    bookingProduct = {},
    ctx = {},
    lead = {},
} = {}) {
    const knownArea =
        bookingProduct?.therapyArea ||
        flags?.therapyArea ||
        lead?.autoBookingContext?.mappedTherapyArea ||
        lead?.therapyArea;

    // Verifica também dados já salvos no lead
    const knownProfile = !!(
        lead?.patientInfo?.age ||
        lead?.ageGroup ||
        flags.mentionsChild ||
        flags.mentionsTeen ||
        flags.mentionsAdult ||
        ctx.ageGroup
    );

    const knownPeriod = !!(
        lead?.pendingPreferredPeriod ||
        lead?.autoBookingContext?.preferredPeriod ||
        ctx.preferredPeriod
    );

    // 🆕 Verifica se já tem queixa/motivo registrado
    const knownComplaint = !!(
        lead?.complaint ||
        lead?.patientInfo?.complaint ||
        lead?.autoBookingContext?.complaint ||
        ctx.complaint
    );

    const needsArea = !knownArea;
    const needsProfile = !knownProfile;
    const needsPeriod = !knownPeriod;
    const needsComplaint = !knownComplaint && needsArea; // Só precisa de queixa se não tiver área

    // Ordem: perfil → queixa (para mapear área) → período
    if (needsProfile) {
        return "Perfeito 😊 Pra eu te orientar certinho, qual a idade do paciente?";
    }
    if (needsComplaint) {
        // 🆕 Pergunta a QUEIXA ao invés da área diretamente
        return "E o que você tem observado? Me conta um pouquinho o que te trouxe aqui 😊";
    }
    if (needsPeriod) {
        return "Qual período fica melhor pra vocês: manhã ou tarde?";
    }

    return "Me conta mais um detalhe pra eu te ajudar certinho 💚";
}

/**
 * 🆕 Mapeia queixa para área terapêutica usando detectores existentes
 */
function mapComplaintToTherapyArea(complaint) {
    if (!complaint) return null;

    // 1. Usa detectAllTherapies (do therapyDetector.js) - mais preciso
    const detectedTherapies = detectAllTherapies(complaint);
    if (detectedTherapies?.length > 0) {
        const primary = detectedTherapies[0];
        // Mapeia ID do therapyDetector para nome da área no banco
        const areaMap = {
            "neuropsychological": "neuropsicologia",
            "speech": "fonoaudiologia",
            "tongue_tie": "fonoaudiologia", // linguinha é fono
            "psychology": "psicologia",
            "occupational": "terapia_ocupacional",
            "physiotherapy": "fisioterapia",
            "music": "musicoterapia",
            "neuropsychopedagogy": "neuropsicologia",
            "psychopedagogy": "neuropsicologia", // psicopedagogia vai pra neuro
        };
        return areaMap[primary.id] || null;
    }

    // 2. Fallback: usa resolveTopicFromFlags (do flagsDetector.js)
    const flags = deriveFlagsFromText(complaint);
    const topic = resolveTopicFromFlags(flags, complaint);
    if (topic) {
        // Mapeia topic para área
        const topicMap = {
            "neuropsicologica": "neuropsicologia",
            "fono": "fonoaudiologia",
            "teste_linguinha": "fonoaudiologia",
            "psicologia": "psicologia",
            "terapia_ocupacional": "terapia_ocupacional",
            "fisioterapia": "fisioterapia",
            "musicoterapia": "musicoterapia",
            "psicopedagogia": "neuropsicologia",
        };
        return topicMap[topic] || null;
    }

    return null;
}

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

// ============================================================================
// 🎯 ORQUESTRADOR PRINCIPAL
// ============================================================================

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

    console.log(`🎯 [ORCHESTRATOR] Processando: "${text}"`);

    // ➕ integrar inbound do chat com followups
    if (lead?._id) {
        handleInboundMessageForFollowups(lead._id).catch((err) =>
            console.warn("[FOLLOWUP-REALTIME] erro:", err.message),
        );
    }

    // =========================================================================
    // 🆕 PASSO 0: REFRESH DO LEAD (SEMPRE BUSCA DADOS ATUALIZADOS)
    // =========================================================================
    if (lead?._id) {
        const freshLead = await Leads.findById(lead._id).lean().catch(() => null);
        if (freshLead) lead = freshLead;
    }

    // =========================================================================
    // 🆕 PASSO 1: FLUXO DE COLETA DE DADOS DO PACIENTE (PÓS-ESCOLHA DE SLOT)
    // =========================================================================
    if (lead?.pendingPatientInfoForScheduling && lead?._id) {
        console.log("📝 [ORCHESTRATOR] Lead está pendente de dados do paciente");

        const step = lead.pendingPatientInfoStep || "name";
        const chosenSlot = lead.pendingChosenSlot;

        // Extrai nome
        const extractName = (msg) => {
            const t = String(msg || "").trim();
            const m1 = t.match(/\b(nome|paciente)\s*[:\-]\s*([a-zÀ-ú\s]{3,80})/i);
            if (m1) return m1[2].trim();
            if (/^[a-zÀ-ú]{2,}\s+[a-zÀ-ú]{2,}/i.test(t) && t.length < 80) return t;
            return null;
        };

        // Extrai data de nascimento
        const extractBirth = (msg) => {
            const m = msg.match(/\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/);
            if (!m) return null;
            return `${m[3]}-${m[2]}-${m[1]}`;
        };

        if (step === "name") {
            const name = extractName(text);
            if (!name) {
                return ensureSingleHeart("Pra eu confirmar certinho: qual o **nome completo** do paciente?");
            }
            await Leads.findByIdAndUpdate(lead._id, {
                $set: { "patientInfo.fullName": name, pendingPatientInfoStep: "birth" }
            }).catch(() => { });
            return ensureSingleHeart("Obrigada! Agora me manda a **data de nascimento** (dd/mm/aaaa)");
        }

        if (step === "birth") {
            const birthDate = extractBirth(text);
            if (!birthDate) {
                return ensureSingleHeart("Me manda a **data de nascimento** no formato **dd/mm/aaaa**");
            }

            // Busca dados atualizados
            const updated = await Leads.findById(lead._id).lean().catch(() => null);
            const fullName = updated?.patientInfo?.fullName;
            const phone = updated?.contact?.phone;

            if (!fullName || !chosenSlot) {
                return ensureSingleHeart("Perfeito! Só mais um detalhe: confirma pra mim o **nome completo** do paciente?");
            }

            // Salva data de nascimento
            await Leads.findByIdAndUpdate(lead._id, {
                $set: { "patientInfo.birthDate": birthDate }
            }).catch(() => { });

            // 🆕 TENTA AGENDAR
            console.log("🚀 [ORCHESTRATOR] Tentando agendar após coletar dados do paciente");
            const bookingResult = await autoBookAppointment({
                lead: updated,
                chosenSlot,
                patientInfo: { fullName, birthDate, phone }
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
                        pendingPatientInfoForScheduling: "",
                        pendingPatientInfoStep: "",
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

                return ensureSingleHeart(`Perfeito! ✅ Agendado para ${humanDate} às ${humanTime} com ${chosenSlot.doctorName}. Qualquer coisa é só me avisar`);
            } else if (bookingResult.code === "TIME_CONFLICT") {
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: { pendingChosenSlot: null, pendingPatientInfoForScheduling: false }
                }).catch(() => { });
                return ensureSingleHeart("Esse horário acabou de ser preenchido 😕 A equipe vai te enviar novas opções em instantes");
            } else {
                return ensureSingleHeart("Tive um probleminha ao confirmar. A equipe vai te responder por aqui em instantes");
            }
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

    const contextPack = lead?._id ? await buildContextPack(lead._id).catch(() => null) : null;

    const enrichedContext = {
        ...baseContext,
        ...context,
        ...(contextPack ? { mode: contextPack.mode, urgency: contextPack.urgency } : {}),
    };

    if (contextPack?.mode) console.log("[AmandaAI] ContextPack mode:", contextPack.mode);

    const flags = detectAllFlags(text, lead, enrichedContext);

    const historyLen = Array.isArray(enrichedContext.conversationHistory)
        ? enrichedContext.conversationHistory.length
        : enrichedContext.messageCount || 0;

    const msgCount = historyLen + 1;
    enrichedContext.messageCount = msgCount;

    // 🔹 Captura a resposta ao período (quando Amanda perguntou "manhã ou tarde?")
    // 🔹 Captura a resposta ao período (quando Amanda perguntou "manhã ou tarde?")
    if (
        lead?._id &&
        lead?.autoBookingContext?.awaitingPeriodChoice &&
        !lead?.pendingSchedulingSlots?.primary
    ) {
        const preferredPeriod = extractPeriodFromText(text);

        if (preferredPeriod) {
            console.log("🎯 [ORCHESTRATOR] Usuário escolheu período:", preferredPeriod);

            // pega área do lead (sem inventar)
            const therapyArea =
                lead?.therapyArea ||
                lead?.autoBookingContext?.mappedTherapyArea ||
                flags?.therapyArea ||
                null;

            // se não tem área ainda, não dá pra buscar slots
            if (!therapyArea) {
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: { "autoBookingContext.awaitingPeriodChoice": false },
                }).catch(() => { });
                return ensureSingleHeart(
                    "Pra eu puxar os horários certinho: é pra qual área (Fono, Psicologia, TO, Fisio ou Neuropsico)?"
                );
            }

            // desarma “aguardando período” e salva o período real
            await Leads.findByIdAndUpdate(lead._id, {
                $set: {
                    "autoBookingContext.awaitingPeriodChoice": false,
                    "autoBookingContext.preferredPeriod": preferredPeriod,
                },
            }).catch(() => { });

            try {
                const slots = await findAvailableSlots({
                    therapyArea,
                    preferredPeriod,
                    daysAhead: 30,
                });

                // se achou slots, salva no lead pra ativar o PASSO 2
                if (slots?.primary) {
                    await Leads.findByIdAndUpdate(lead._id, {
                        $set: {
                            pendingSchedulingSlots: slots,
                            stage: "interessado_agendamento",
                            "autoBookingContext.lastOfferedSlots": slots,
                        },
                    }).catch(() => { });

                    const { message } = buildSlotMenuMessage(slots);
                    return ensureSingleHeart(message);
                }

                return ensureSingleHeart(
                    `Pra **${preferredPeriod === "manha" ? "manhã" : preferredPeriod === "tarde" ? "tarde" : "noite"}** não encontrei vaga agora 😕 Quer me dizer qual dia da semana fica melhor?`
                );
            } catch (err) {
                console.error("[ORCHESTRATOR] Erro ao buscar slots do período:", err.message);
                return ensureSingleHeart(
                    "Tive um probleminha ao checar os horários 😅 Você prefere **manhã** ou **tarde**?"
                );
            }
        }
    }

    // =========================================================================
    // 🆕 PASSO 2: PROCESSAMENTO DE ESCOLHA DE SLOT (QUANDO JÁ TEM SLOTS PENDENTES)
    // =========================================================================
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

        // 🆕 Usuário pediu outro período?
        const wantsDifferentPeriod = extractPeriodFromText(text);
        const currentPeriod = lead?.autoBookingContext?.preferredPeriod || null;

        if (wantsDifferentPeriod && wantsDifferentPeriod !== currentPeriod) {
            console.log(`🔄 [ORCHESTRATOR] Usuário quer período diferente: ${wantsDifferentPeriod}`);

            const therapyArea = lead?.therapyArea || lead?.autoBookingContext?.mappedTherapyArea;

            try {
                const newSlots = await findAvailableSlots({
                    therapyArea,
                    preferredPeriod: wantsDifferentPeriod,
                    daysAhead: 30,
                });

                if (newSlots?.primary) {
                    await Leads.findByIdAndUpdate(lead._id, {
                        $set: {
                            pendingSchedulingSlots: newSlots,
                            pendingPreferredPeriod: wantsDifferentPeriod,
                            pendingChosenSlot: null
                        }
                    }).catch(() => { });

                    const { optionsText } = buildSlotMenuMessage(newSlots);
                    const periodLabel = wantsDifferentPeriod === "manha" ? "manhã" : wantsDifferentPeriod === "tarde" ? "tarde" : "noite";
                    return ensureSingleHeart(`Perfeito! Pra **${periodLabel}**, tenho essas opções:\n\n${optionsText}\n\nQual você prefere? (A, B, C...)`);
                } else {
                    const periodLabel = wantsDifferentPeriod === "manha" ? "manhã" : wantsDifferentPeriod === "tarde" ? "tarde" : "noite";
                    const { optionsText } = buildSlotMenuMessage(rawSlots);
                    return ensureSingleHeart(`Pra **${periodLabel}** não encontrei vaga agora 😕 Tenho essas outras opções:\n\n${optionsText}\n\nAlguma serve pra você?`);
                }
            } catch (err) {
                console.error("[ORCHESTRATOR] Erro ao buscar novos slots:", err.message);
            }
        }

        if (onlyOne && isYes) {
            await Leads.findByIdAndUpdate(lead._id, {
                $set: { pendingChosenSlot: onlyOne, pendingPatientInfoForScheduling: true, pendingPatientInfoStep: "name" },
            }).catch(() => { });
            return ensureSingleHeart("Perfeito! Pra eu confirmar, me manda o **nome completo** do paciente");
        }

        if (onlyOne && isNo) {
            return ensureSingleHeart("Sem problema! Você prefere **manhã ou tarde**?");
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
            return ensureSingleHeart(menuMsg);
        }

        let chosen = pickSlotFromUserReply(text, slotsCtx, { strict: true });

        if (!chosen) {
            const preferPeriod = extractPeriodFromText(text);

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
                    // ✅ PATCH: Não chuta, oferece as opções disponíveis
                    const prefLabel =
                        preferPeriod === "manha" ? "de manhã" : preferPeriod === "tarde" ? "à tarde" : "à noite";

                    return ensureSingleHeart(
                        `Entendi que você prefere ${prefLabel} 😊 No momento não tenho vaga ${prefLabel}.\n\nTenho essas opções disponíveis:\n\n${optionsText}\n\nQual você prefere? (A, B, C...)`
                    );
                }
            }

            return ensureSingleHeart(`Não consegui identificar qual você escolheu 😅\n\n${optionsText}\n\nResponda A-F ou escreva o dia e a hora`);
        }

        await Leads.findByIdAndUpdate(lead._id, {
            $set: { pendingChosenSlot: chosen, pendingPatientInfoForScheduling: true, pendingPatientInfoStep: "name" },
        }).catch(() => { });

        return ensureSingleHeart("Perfeito! Pra eu confirmar esse horário, me manda o **nome completo** do paciente");
    }

    // 🔎 Data explícita no texto
    const parsedDateStr = extractPreferredDateFromText(text);
    if (parsedDateStr) flags.preferredDate = parsedDateStr;

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

    // 🧠 Análise inteligente
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
            "Atendemos no particular e emitimos recibo/nota pra você tentar reembolso no plano. Quer que eu já te mostre os horários disponíveis?",
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

    // ✅ PATCH: Se lead já tem dados parciais, está em fluxo de agendamento
    const isInSchedulingFlow = !!(
        lead?.patientInfo?.age ||
        lead?.ageGroup ||
        lead?.therapyArea ||
        lead?.autoBookingContext?.mappedTherapyArea ||
        lead?.pendingPreferredPeriod ||
        lead?.autoBookingContext?.awaitingPeriodChoice
    );

    const wantsScheduling = flags.wantsSchedule || flags.wantsSchedulingNow || isSchedulingLikeText || isInSchedulingFlow;

    console.log("[ORCHESTRATOR] wantsScheduling:", wantsScheduling, "| isInSchedulingFlow:", isInSchedulingFlow);

    if (wantsScheduling) {
        const detectedTherapies = detectAllTherapies(text);

        // ✅ PATCH: Considera dados JÁ SALVOS no lead + mensagem atual
        const hasAreaNow = detectedTherapies.length > 0 || flags.therapyArea || lead?.therapyArea || lead?.autoBookingContext?.mappedTherapyArea;
        const hasAgeNow = /\b\d{1,2}\s*(anos?|mes(es)?)\b/i.test(text) || lead?.patientInfo?.age || lead?.ageGroup;
        const hasPeriodNow = extractPeriodFromText(text) || lead?.pendingPreferredPeriod;

        console.log("[TRIAGEM INICIAL]", { hasAreaNow, hasAgeNow, hasPeriodNow, isInSchedulingFlow });

        // ✅ Se já tem período (mensagem atual ou salvo), vai direto pro PASSO 3 buscar slots
        if (hasPeriodNow && hasAreaNow && hasAgeNow) {
            console.log("[ORCHESTRATOR] ✅ Triagem completa no bloco inicial, delegando pro PASSO 3...");
            // Não retorna, deixa continuar pro PASSO 3 que busca slots
        }
        // 1️⃣ Nenhuma queixa detectada ainda E não está em fluxo
        else if (!hasAreaNow && !hasAgeNow && !isInSchedulingFlow) {
            return ensureSingleHeart("Claro! Pra eu entender direitinho, o que você tem notado ou qual a principal queixa do(a) paciente? 💚");
        }
        // 2️⃣ Queixa detectada → responder com empatia + área + pedir idade
        else if (hasAreaNow && !hasAgeNow) {
            const areaName = detectedTherapies[0]?.name || lead?.therapyArea || "área ideal";
            return ensureSingleHeart(
                `Entendi 💚 É super comum nessa fase! Nesse tipo de caso, o ideal é começar pela **${areaName}**, que ajuda bastante no desenvolvimento e acompanhamento.  
Pra eu te orientar direitinho: qual a idade do(a) paciente (em meses ou anos)?`
            );
        }
        // 3️⃣ Já tem área e idade, falta período → perguntar período
        else if (hasAreaNow && hasAgeNow && !hasPeriodNow) {
            const areaName = detectedTherapies[0]?.name || lead?.therapyArea || flags.therapyArea || "área indicada";
            return ensureSingleHeart(
                `Perfeito 💚 ${areaName} é realmente a área certa pra esse tipo de caso.  
Podemos ver juntos um horário pra avaliação? Você prefere **de manhã** ou **à tarde**?`
            );
        }
        // ✅ Se tem tudo, continua pro PASSO 3
    }

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
                    "Só pra eu te direcionar certinho: o bebê **já passou pelo Osteopata** e foi ele quem indicou a Fisioterapia?",
                );
            }
        } else {
            if (!mentionsOsteo) {
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: { "autoBookingContext.osteopathyGatePending": true },
                }).catch(() => { });

                return ensureSingleHeart(
                    "Só pra eu te direcionar certinho: o bebê **já passou pelo Osteopata** e foi ele quem indicou a Fisioterapia?",
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
        hasAgeOrProfileNow(text, flags, enrichedContext, lead) ||
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
            "Perfeito! Só confirmando: você quer **Fisioterapia** e **Teste da Linguinha**, certo? Quer agendar **primeiro qual dos dois**?",
        );
    }

    if (RESCHEDULE_REGEX.test(normalized)) {
        return ensureSingleHeart(
            "Claro! Vamos remarcar 😊 Você prefere **manhã ou tarde** e qual **dia da semana** fica melhor pra você?"
        );
    }

    // =========================================================================
    // 🆕 PASSO 3: TRIAGEM - SALVA DADOS IMEDIATAMENTE E VERIFICA O QUE FALTA
    // =========================================================================
    if (wantsScheduling && lead?._id && !lead?.pendingPatientInfoForScheduling) {
        console.log("[TRIAGEM] Verificando dados necessários...");

        // 🆕 SALVA DADOS DETECTADOS IMEDIATAMENTE
        const updateData = {};

        // ✅ PATCH: Salva período em pendingPreferredPeriod (FONTE ÚNICA)
        const periodDetected = extractPeriodFromText(text);
        if (periodDetected && !lead?.pendingPreferredPeriod) {
            updateData.pendingPreferredPeriod = periodDetected;
            console.log("[TRIAGEM] ✅ Período detectado e salvo:", periodDetected);
        }

        // Detecta e salva idade
        const ageDetected = extractAgeFromText(text);
        if (ageDetected && !lead?.patientInfo?.age) {
            updateData["patientInfo.age"] = ageDetected.age;
            updateData["patientInfo.ageUnit"] = ageDetected.unit;
            updateData.ageGroup = getAgeGroup(ageDetected.age, ageDetected.unit);
            console.log("[TRIAGEM] ✅ Idade detectada e salva:", ageDetected.age, ageDetected.unit);
        }

        // 🆕 Detecta área pelo bookingProduct OU mapeia da queixa
        let areaDetected = bookingProduct?.therapyArea;

        // Se não veio do bookingProduct, tenta mapear da queixa na mensagem
        if (!areaDetected && !lead?.therapyArea) {
            areaDetected = mapComplaintToTherapyArea(text);
            if (areaDetected) {
                console.log("[TRIAGEM] ✅ Área mapeada da queixa:", areaDetected);
                // Salva a queixa também
                updateData["patientInfo.complaint"] = text;
                updateData["autoBookingContext.complaint"] = text;
            }
        }

        if (areaDetected && !lead?.therapyArea) {
            updateData.therapyArea = areaDetected;
            updateData["autoBookingContext.mappedTherapyArea"] = areaDetected;
            console.log("[TRIAGEM] ✅ Área salva:", areaDetected);
        }

        // Detecta menção de criança
        if (/\b(filh[oa]|crian[çc]a|beb[êe]|menin[oa])\b/i.test(text) && !lead?.ageGroup) {
            updateData.ageGroup = "crianca";
            flags.mentionsChild = true;
            console.log("[TRIAGEM] ✅ Menção de criança detectada");
        }

        // Salva no banco se tiver algo pra salvar
        if (Object.keys(updateData).length > 0) {
            await Leads.findByIdAndUpdate(lead._id, { $set: updateData }).catch((err) => {
                console.error("[TRIAGEM] Erro ao salvar:", err.message);
            });
            // Atualiza objeto local
            if (updateData["patientInfo.age"]) {
                lead.patientInfo = lead.patientInfo || {};
                lead.patientInfo.age = updateData["patientInfo.age"];
            }
            if (updateData.ageGroup) lead.ageGroup = updateData.ageGroup;
            if (updateData.therapyArea) lead.therapyArea = updateData.therapyArea;
            if (updateData.pendingPreferredPeriod) lead.pendingPreferredPeriod = updateData.pendingPreferredPeriod;
        }

        // Verifica o que ainda falta (DEPOIS de salvar)
        const hasProfileNow = hasAgeOrProfileNow(text, flags, enrichedContext, lead) || ageDetected;
        const hasAreaNow = !!(lead?.therapyArea || areaDetected || bookingProduct?.therapyArea);
        const hasPeriodNow = !!(lead?.pendingPreferredPeriod || periodDetected);

        console.log("[TRIAGEM] Estado após salvar:", {
            hasProfile: hasProfileNow,
            hasArea: hasAreaNow,
            hasPeriod: hasPeriodNow
        });

        // Se ainda falta algo, pergunta (1 pergunta por vez)
        if (!hasProfileNow || !hasAreaNow || !hasPeriodNow) {
            return ensureSingleHeart(
                buildTriageSchedulingMessage({ flags, bookingProduct, ctx: enrichedContext, lead }),
            );
        }

        // =========================================================================
        // 🆕 PASSO 4: TRIAGEM COMPLETA - BUSCA SLOTS
        // =========================================================================
        console.log("[ORCHESTRATOR] ✅ Triagem completa! Buscando slots...");

        const therapyAreaForSlots = lead?.therapyArea || areaDetected || bookingProduct?.therapyArea;
        const preferredPeriod = lead?.pendingPreferredPeriod || periodDetected;

        try {
            const availableSlots = await findAvailableSlots({
                therapyArea: therapyAreaForSlots,
                preferredPeriod,
                daysAhead: 30,
            });

            if (!availableSlots?.primary) {
                // Tenta sem filtro de período
                const fallbackSlots = await findAvailableSlots({
                    therapyArea: therapyAreaForSlots,
                    preferredPeriod: null,
                    daysAhead: 30,
                });

                if (fallbackSlots?.primary) {
                    await Leads.findByIdAndUpdate(lead._id, {
                        $set: {
                            pendingSchedulingSlots: fallbackSlots,
                            "autoBookingContext.active": true,
                            stage: "interessado_agendamento"
                        }
                    }).catch(() => { });

                    const periodLabel = preferredPeriod === "manha" ? "manhã" : preferredPeriod === "tarde" ? "tarde" : "noite";
                    const { optionsText } = buildSlotMenuMessage(fallbackSlots);
                    return ensureSingleHeart(`Pra **${periodLabel}** não encontrei vaga agora 😕\n\nTenho essas opções em outros horários:\n\n${optionsText}\n\nQual você prefere? (A, B, C...)`);
                }

                return ensureSingleHeart("No momento não achei horários certinhos pra essa área. Me diga: prefere manhã ou tarde, e qual dia da semana fica melhor?");
            }

            // Urgência
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
                    "autoBookingContext.mappedProduct": bookingProduct?.product,
                    "autoBookingContext.lastOfferedSlots": availableSlots,
                },
            }).catch(() => { });

            enrichedContext.pendingSchedulingSlots = availableSlots;

            const { message: menuMsg, optionsText, ordered, letters } = buildSlotMenuMessage(availableSlots);

            if (!menuMsg || !ordered?.length) {
                return ensureSingleHeart(
                    "No momento não encontrei horários disponíveis. Quer me dizer se prefere manhã ou tarde, e qual dia da semana fica melhor?"
                );
            }

            const allowed = letters.slice(0, ordered.length).join(", ");

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

            return ensureSingleHeart(
                `${urgencyPrefix}Tenho esses horários no momento:\n\n${optionsText}\n\nQual você prefere? (${allowed})`
            );

        } catch (err) {
            console.error("❌ [ORCHESTRATOR] Erro ao buscar slots:", err?.message || err);
            return ensureSingleHeart("Tive um probleminha ao checar os horários agora 😕 Você prefere **manhã ou tarde** e qual **dia da semana** fica melhor?");
        }
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

    // ✅ Pergunta "valor + onde fica" na mesma mensagem → responde os dois
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

        const enrichedFlags = { ...flags, text: userText, rawText: userText };
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
        lead?.ageGroup ||
        lead?.patientInfo?.age ||
        /\d+\s*anos?\b/i.test(userText);

    let scheduleInfoNote = "";

    if (stage === "interessado_agendamento") {
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
    isHotLead: flags.visitLeadHot || stage === "interessado_agendamento",
    isColdLead: flags.visitLeadCold || stage === "novo",

    negativeScopeTriggered: /audiometria|bera|rpg|pilates/i.test(text),

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