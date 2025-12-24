import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { analyzeLeadMessage } from "../services/intelligence/leadIntelligence.js";
import { urgencyScheduler } from "../services/intelligence/UrgencyScheduler.js";
import enrichLeadContext from "../services/leadContext.js";
import { detectAllFlags } from "./flagsDetector.js";
import { buildEquivalenceResponse } from "./responseBuilder.js";
import {
    detectAllTherapies,
    detectNegativeScopes,
    getPriceLinesForDetectedTherapies,
    getTDAHResponse,
    getTherapyData,
    isAskingAboutEquivalence,
    isTDAHQuestion
} from "./therapyDetector.js";

import Leads from "../models/Leads.js";
import { callOpenAIFallback } from "../services/aiAmandaService.js";
import {
    autoBookAppointment,
    buildSlotMenuMessage,
    buildSlotMenuMessageForPeriod,
    findAvailableSlots,
    formatDatePtBr,
    formatSlot,
    pickSlotFromUserReply,
    validateSlotStillAvailable
} from "../services/amandaBookingService.js";

import Appointment from "../models/Appointment.js";
import { getLatestInsights } from "../services/amandaLearningService.js";
import { buildContextPack } from "../services/intelligence/ContextPack.js";
import { handleInboundMessageForFollowups } from "../services/responseTrackingService.js";
import {
    buildDynamicSystemPrompt,
    buildUserPromptWithValuePitch,
    calculateUrgency,
    getManual,
} from "./amandaPrompt.js";
import { logBookingGate, mapFlagsToBookingProduct } from "./bookingProductMapper.js";
import { extractPreferredDateFromText } from "./dateParser.js";

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

    const hasArea = Boolean(
        flags?.therapyArea ||
        lead?.autoBookingContext?.therapyArea ||
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

    if (flags.wantsSchedule || intent.primary === "agendar_avaliacao") {
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

function normalizeSlots(raw) {
    if (!raw) {
        return {
            primary: null,
            alternativesSamePeriod: [],
            alternativesOtherPeriod: [],
        };
    }

    // ✅ Compat com versão antiga: array de slots
    if (Array.isArray(raw)) {
        const [first, ...rest] = raw;
        return {
            primary: first || null,
            alternativesSamePeriod: rest || [],
            alternativesOtherPeriod: [],
        };
    }

    // ✅ Versão nova: objeto { primary, alternativesSamePeriod, alternativesOtherPeriod }
    const primary = raw.primary || null;
    const same = Array.isArray(raw.alternativesSamePeriod)
        ? raw.alternativesSamePeriod
        : [];
    const other = Array.isArray(raw.alternativesOtherPeriod)
        ? raw.alternativesOtherPeriod
        : [];

    return { primary, alternativesSamePeriod: same, alternativesOtherPeriod: other };
}


// -----------------------------------------------------------------------------
// Slots menu compat layer (do NOT remove existing builder; this only normalizes)
// -----------------------------------------------------------------------------
// buildSlotMenuMessage historically returned different shapes across refactors:
//   - string (full message)
//   - { message, optionsText, ordered, letters }
//   - { message } only
//   - { optionsText, ordered, letters } without message
// This helper guarantees: { menuMsg, optionsText, ordered, letters }.
const SLOT_LETTERS = ["A", "B", "C", "D", "E", "F"];

function flattenNormalizedSlots(slotsNorm) {
    return [
        slotsNorm?.primary,
        ...(slotsNorm?.alternativesSamePeriod || []),
        ...(slotsNorm?.alternativesOtherPeriod || []),
    ].filter(Boolean);
}

function buildOptionsTextFromSlots(rawSlots) {
    const norm = normalizeSlots(rawSlots);
    const flat = flattenNormalizedSlots(norm).slice(0, 6);
    if (!flat.length) return "";
    return flat.map((s, i) => `${SLOT_LETTERS[i]}) ${formatSlot(s)}`).join("\n");
}

function buildSlotMenuCompat(rawSlots) {
    const norm = normalizeSlots(rawSlots);

    // defaults computed locally (never depend on builder)
    const orderedDefault = flattenNormalizedSlots(norm).slice(0, 6);
    const lettersDefault = SLOT_LETTERS.slice(0, orderedDefault.length);
    const optionsDefault = buildOptionsTextFromSlots(norm);

    let res = null;
    try {
        res = buildSlotMenuMessage(norm);
    } catch (_) {
        res = null;
    }

    if (typeof res === "string") {
        const menuMsg = res;
        return {
            menuMsg,
            optionsText: optionsDefault || menuMsg,
            ordered: orderedDefault,
            letters: lettersDefault,
        };
    }

    if (res && typeof res === "object") {
        const menuMsg = res.message || res.menuMsg || null;
        const ordered = Array.isArray(res.ordered) && res.ordered.length ? res.ordered : orderedDefault;
        const letters = Array.isArray(res.letters) && res.letters.length ? res.letters : SLOT_LETTERS.slice(0, ordered.length);
        const optionsText = res.optionsText || optionsDefault || (typeof menuMsg === "string" ? menuMsg : "");
        return { menuMsg, optionsText, ordered, letters };
    }

    return { menuMsg: null, optionsText: optionsDefault, ordered: orderedDefault, letters: lettersDefault };
}

function buildSlotMenuForPeriodCompat(rawSlots, desiredPeriod, opts = {}) {
    const norm = normalizeSlots(rawSlots);
    let res = null;
    try {
        res = buildSlotMenuMessageForPeriod(norm, desiredPeriod, opts);
    } catch (_) {
        res = null;
    }

    if (typeof res === "string") {
        return { message: res, optionsText: res, ordered: [], letters: SLOT_LETTERS };
    }

    if (res && typeof res === "object") {
        return {
            message: res.message || res.menuMsg || null,
            optionsText: res.optionsText || "",
            ordered: Array.isArray(res.ordered) ? res.ordered : [],
            letters: Array.isArray(res.letters) ? res.letters : SLOT_LETTERS,
        };
    }

    return { message: null, optionsText: "", ordered: [], letters: SLOT_LETTERS };
}


function hasAnySlot(raw) {
    if (!raw) return false;
    const s = normalizeSlots(raw);
    const all = [
        s.primary,
        ...s.alternativesSamePeriod,
        ...s.alternativesOtherPeriod,
    ].filter(Boolean);
    return all.length > 0;
}


function hasDayAndTimePattern(msg = "") {
    const normalized = String(msg).toLowerCase();
    const hasDay =
        /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|sabado|domingo)\b/i.test(normalized);
    const hasTime = /\b(\d{1,2}:\d{2})\b|\b(\d{1,2})\s*h\b/i.test(normalized);
    return hasDay && hasTime;
}

function isPeriodOnlyAnswer(msg = "") {
    const normalized = String(msg).toLowerCase().trim();
    const hasPeriod = /\b(manh[ãa]|cedo|tarde|noite)\b/i.test(normalized);
    const hasLetterOrNum = /(?:^|\s)([a-f]|[1-6])(?:\s|$|[).,;!?])/i.test(normalized);
    const hasDayTime = hasDayAndTimePattern(normalized);
    return hasPeriod && !hasLetterOrNum && !hasDayTime;
}

function isRejectingOptions(msg = "") {
    const normalized = String(msg).toLowerCase();
    return /\b(n[aã]o|nao|nenhum|nenhuma|outro\s+dia|outros\s+hor[aá]rios|outras\s+op[çc][aã]es|prefiro\s+outro|n[aã]o\s+quero|n[aã]o\s+d[aá])\b/i.test(normalized);
}

function normalizeChoiceForOptions(raw = "") {
    const text = String(raw);
    const hasOptionKeyword = /\b(op(?:c|ç)[aã]o|alternativa)\b/i.test(text);
    let out = text;

    out = out.replace(/\b(primeira|primeiro)\b/i, "A");

    if (hasOptionKeyword) {
        out = out
            .replace(/\b(segunda|segundo)\b/i, "B")
            .replace(/\b(terceira|terceiro)\b/i, "C")
            .replace(/\b(quarta|quarto)\b/i, "D")
            .replace(/\b(quinta|quinto)\b/i, "E")
            .replace(/\b(sexta|sexto)\b/i, "F");
    }

    return out;
}

function getCurrentSlots(lead, context) {
    // ✅ Fonte da verdade (COMMIT 1): pendingSchedulingSlots
    // Compat mode (read-only por 1 semana): lastOfferedSlots apenas como fallback.
    return (
        lead?.pendingSchedulingSlots ||
        context?.pendingSchedulingSlots ||
        lead?.autoBookingContext?.lastOfferedSlots ||
        null
    );
}

function isSimpleYes(text = "") {
    return /\b(sim|s\b|ok|okay|pode|pode\s+ser|beleza|fechado|confirmo|perfeito)\b/i.test(text);
}
function slotKey(s) {
    const d = s?.date ? String(s.date) : "";
    const t = s?.time ? String(s.time) : "";
    if (!d || !t) return null;
    return `${d}__${t}`;
}

function menuContainsSlot(chosen, rawMenu) {
    if (!chosen || !rawMenu) return false;
    const menu = normalizeSlots(rawMenu);
    const key = slotKey(chosen);
    if (!key) return false;

    const all = [
        menu.primary,
        ...menu.alternativesSamePeriod,
        ...menu.alternativesOtherPeriod,
    ].filter(Boolean);

    return all.some((s) => slotKey(s) === key);
}

function detectPeriod(txt = "") {
    const t = String(txt).toLowerCase();
    if (/\b(manh[ãa]|cedo)\b/i.test(t)) return "manha";
    if (/\b(tarde)\b/i.test(t)) return "tarde";
    if (/\b(noite)\b/i.test(t)) return "noite";
    return null;
}
/**
 * 🎯 ORQUESTRADOR COM CONTEXTO INTELIGENTE
 */
export default async function getOptimizedAmandaResponse({
    content,
    userText,
    lead = {},
    context = {},
    messageId = null,
    // ✅ compat: alguns chamadores passam leadId/from fora de `context`
    leadId = null,
    from = null,
    phone = null,
}) {
    const raw = userText ?? content;
    const text = typeof raw === "string" ? raw : "";
    // ✅ Sempre tentar resolver o lead do banco (sem depender do chamador)
    const resolvedLeadId = context?.leadId || leadId || null;
    if (!lead?._id && resolvedLeadId) {
        lead = await Leads.findById(resolvedLeadId).lean().catch(() => lead);
    }

    // fallback: tenta resolver por telefone quando leadId não veio
    const resolvedPhone = context?.from || context?.phone || from || phone || null;
    if (!lead?._id && resolvedPhone) {
        lead = await Leads.findOne({ phone: String(resolvedPhone) })
            .sort({ lastMessageAt: -1 })
            .lean()
            .catch(() => lead);
    }
    const normalized = text.toLowerCase().trim();
    // ✅ Fonte da verdade: sempre preferir o lead do banco para flags "pending"
    const freshLead = lead?._id
        ? await Leads.findById(lead._id).lean().catch(() => null)
        : null;

    lead = freshLead || lead;

    // ======================================================
    // 🧩 COMMIT 1 (Compat mode): migrar lastOfferedSlots -> pendingSchedulingSlots
    // Regra: persistir slots somente em pendingSchedulingSlots.
    // lastOfferedSlots fica read-only por ~1 semana.
    // ======================================================
    if (
        lead?._id &&
        (!lead?.pendingSchedulingSlots || !lead?.pendingSchedulingSlots?.primary) &&
        lead?.autoBookingContext?.lastOfferedSlots?.primary
    ) {
        try {
            await Leads.findByIdAndUpdate(lead._id, {
                $set: { pendingSchedulingSlots: lead.autoBookingContext.lastOfferedSlots },
            }).catch(() => { });
            lead = {
                ...lead,
                pendingSchedulingSlots: lead.autoBookingContext.lastOfferedSlots,
            };
        } catch (e) {
            // compat-only: não falhar fluxo por migração
        }
    }

    if (lead?._id) {
        const chosenSlot =
            lead?.pendingChosenSlot ||
            lead?.autoBookingContext?.pendingChosenSlot ||
            null;

        const collecting = lead?.pendingPatientInfoForScheduling === true;

        const rawMenu =
            lead?.pendingSchedulingSlots ||
            lead?.autoBookingContext?.lastOfferedSlots ||
            null;

        const hasChosen = Boolean(chosenSlot);
        const chosenInMenu = hasChosen ? menuContainsSlot(chosenSlot, rawMenu) : true;

        const shouldClear = hasChosen && (!collecting || !chosenInMenu);

        if (shouldClear) {
            await Leads.findByIdAndUpdate(lead._id, {
                $set: {
                    pendingChosenSlot: null,
                    pendingPatientInfoForScheduling: false,
                    pendingPatientInfoStep: null,
                    "autoBookingContext.pendingChosenSlot": null, // compat
                },
            }).catch(() => { });

            lead = {
                ...lead,
                pendingChosenSlot: null,
                pendingPatientInfoForScheduling: false,
                pendingPatientInfoStep: null,
                autoBookingContext: {
                    ...(lead.autoBookingContext || {}),
                    pendingChosenSlot: null,
                },
            };
        }
    }

    const SCHEDULING_REGEX =
        /\b(agendar|marcar|consulta|atendimento|avalia[cç][aã]o)\b|\b(qual\s+dia|qual\s+hor[áa]rio|tem\s+hor[áa]rio|dispon[ií]vel|disponivel|essa\s+semana)\b/i;


    function hasAgeOrProfileNow(txt = "", flags = {}, ctx = {}, lead = {}) {
        const t = String(txt || "");
        const hasYears = /\b\d{1,2}\s*anos?\b/i.test(t);
        const hasMonths = /\b\d{1,2}\s*(mes|meses)\b/i.test(t);
        const mentionsChildWord = /\b(filh[oa]|crianç|crianca|beb[eê]|bebe|menino|menina)\b/i.test(t);
        const mentionsBaby = /\b(beb[eê]|rec[eé]m[-\s]*nascid[oa]|rn)\b/i.test(t) || hasMonths;

        // 🔥 inferência única
        const inferred = {
            mentionsChild: mentionsBaby || mentionsChildWord || hasYears || hasMonths,
            ageGroup: hasYears || hasMonths || mentionsChildWord ? "crianca" : null,
        };

        // 🔥 já salva no lead se for a 1ª msg
        if (lead?._id && inferred.ageGroup && !lead.ageGroup) {
            Leads.findByIdAndUpdate(lead._id, {
                $set: {
                    ageGroup: inferred.ageGroup,
                    "contextMemory.hasAge": true,
                    "contextMemory.lastAgeDetected": new Date(),
                },
            }).catch(() => { });
        }

        const hasProfile = !!(
            flags.mentionsChild ||
            flags.mentionsTeen ||
            flags.mentionsAdult ||
            ctx.ageGroup ||
            lead?.ageGroup ||
            hasYears ||
            hasMonths ||
            inferred.mentionsChild
        );

        return { hasProfile, inferred };
    }

    const step = lead.triageStep;

    if (step === "ask_profile") {
        return "Perfeito 😊 Qual a idade do paciente? (pode mandar em anos ou meses) 💚";
    }

    if (step === "ask_area") {
        return "Qual atendimento você está buscando? (Fono, Psicologia, TO, Fisioterapia ou Neuropsico) 💚";
    }

    if (step === "ask_period") {
        return "Qual período fica melhor: **manhã ou tarde**? 💚";
    }

    // fallback (não deveria chegar aqui se step=done)
    return "Me diz só mais um detalhe pra eu organizar certinho, por favor 💚";
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
    const freshLead = await Leads.findById(lead._id).lean().catch(() => null);
    const leadForInfo = freshLead || lead;


    const patientInfo = extractPatientInfoFromLead(leadForInfo, text);
    const chosenSlot =
        leadForInfo?.pendingChosenSlot ||
        leadForInfo?.autoBookingContext?.pendingChosenSlot ||
        null;

    const step = leadForInfo.pendingPatientInfoStep || "name";

    // helpers simples
    const extractName = (msg) => {
        const t = String(msg || "").trim();
        // aceita "Nome: X" ou só "X" (desde que tenha 2 palavras)
        const m1 = t.match(/\b(nome|paciente)\s*[:\-]\s*([a-zÀ-úA-ZÀ-Ú\s]{3,80})/i);
        if (m1) return m1[2].trim();
        if (/^[a-zÀ-úA-ZÀ-Ú]{2,}\s+[a-zÀ-úA-ZÀ-Ú]{2,}/.test(t)) return t;
        return null;
    };

    const extractBirth = (msg) => {
        const t = String(msg || "").trim();
        const m = t.match(/\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/);
        if (!m) return null;
        return `${m[3]}-${m[2]}-${m[1]}`;
    };

    // PASSO 1: NOME
    if (step === "name") {
        const name = extractName(text);
        if (!name) return "Pra eu confirmar certinho: qual o **nome completo** do paciente? 💚";

        await Leads.findByIdAndUpdate(lead._id, {
            $set: { "patientInfo.fullName": name, pendingPatientInfoStep: "birth" }
        }).catch(() => { });

        return "Obrigada! Agora me manda a **data de nascimento** (dd/mm/aaaa) 💚";
    }

    // PASSO 2: NASCIMENTO
    if (step === "birth") {
        const birthDate = extractBirth(text);
        if (!birthDate) return "Me manda a **data de nascimento** no formato **dd/mm/aaaa** 💚";

        await Leads.findByIdAndUpdate(lead._id, {
            $set: { "patientInfo.birthDate": birthDate }
        }).catch(() => { });

        // pega os dados completos do lead (com nome salvo)
        const updated = await Leads.findById(lead._id).lean().catch(() => null);
        const fullName = updated?.patientInfo?.fullName || null;

        if (!fullName || !chosenSlot) {
            // fallback bem seguro
            return "Perfeito! Só mais um detalhe: confirma pra mim o **nome completo** do paciente? 💚";
        }

        const phone =
            updated?.contact?.phone ||
            leadForInfo?.contact?.phone ||
            null;

        const email =
            updated?.contact?.email ||
            leadForInfo?.contact?.email ||
            null;

        await Leads.findByIdAndUpdate(lead._id, {
            $set: {
                "patientInfo.birthDate": birthDate,
                "patientInfo.phone": phone,
                "patientInfo.email": email,
            }
        }).catch(() => { });

        const bookingResult = await autoBookAppointment({
            lead: updated || leadForInfo,
            chosenSlot,
            patientInfo: { fullName, birthDate, phone, email }
        });

        if (bookingResult.success) {
            const appointmentId =
                bookingResult?.appointment?._id ||
                bookingResult?.appointmentId ||
                bookingResult?.appointment;

            if (!appointmentId) {
                console.error("[BOOKING] success=true mas sem appointmentId");
                return "Tive um problema ao confirmar. Vou pedir pra equipe te ajudar 💚";
            }

            let appointment = null;
            try {
                appointment = await Appointment.findById(appointmentId).lean();
            } catch (e) { }

            if (!appointment) {
                console.error("[BOOKING] Appointment success mas não está no BD:", appointmentId);
                return "Tive um problema ao confirmar. Vou pedir pra equipe te ajudar 💚";
            }

            await Leads.findByIdAndUpdate(lead._id, {
                $set: {
                    stage: "paciente",
                    pendingPatientInfoForScheduling: false,
                    pendingPatientInfoStep: null,
                    pendingChosenSlot: null,
                    pendingSchedulingSlots: null,
                }
            }).catch(() => { });

            // ✅ Mensagem final de confirmação (usa chosenSlot se quiser; aqui uso appointment se tiver)
            const when =
                (appointment?.date && appointment?.time)
                    ? `${formatDatePtBr(appointment.date)} às ${appointment.time}`
                    : (chosenSlot ? formatSlot(chosenSlot) : "o horário combinado");

            return `Perfeito! Agendamento confirmado para **${when}**. Qualquer coisa, estou por aqui 💚`;
        }


        if (bookingResult.code === "TIME_CONFLICT") {
            return "Esse horário acabou de ser preenchido 😕 Quer que eu te envie outras opções? 💚";
        }

        return "Tive um probleminha ao confirmar. Já vou pedir pra equipe te ajudar por aqui 💚";
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

// ✅ set correto (pra triagem e pro LLM)
enrichedContext.lastUserText = text;
enrichedContext.currentUserText = text;


if (contextPack?.mode) console.log("[AmandaAI] ContextPack mode:", contextPack.mode);

// 🧠 Análise inteligente (uma vez) — ANTES dos flags, pra alimentar triagem/idade
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

// 🔗 Integra idade/perfil detectados pela inteligência ao contexto (pra não perguntar de novo)
if (analysis?.extracted) {
    const extracted = analysis.extracted || {};
    let detectedAgeGroup = null;

    const idade = typeof extracted.idade === "number" ? extracted.idade : null;
    const idadeRangeRaw =
        extracted.idadeRange ||
        extracted.faixaEtaria ||
        extracted.faixa_etaria ||
        extracted.ageRange ||
        extracted.age_group ||
        null;

    if (idadeRangeRaw) {
        const r = String(idadeRangeRaw).toLowerCase();
        if (/(bebe|bebê|1a3|4a6|7a12|crianc|crianç|infantil|escolar)/.test(r)) {
            detectedAgeGroup = "crianca";
        } else if (/(adolescente|13a17)/.test(r)) {
            detectedAgeGroup = "adolescente";
        } else if (/(adulto|18\+|maior)/.test(r)) {
            detectedAgeGroup = "adulto";
        }
    }

    if (!detectedAgeGroup && Number.isFinite(idade)) {
        if (idade <= 12) detectedAgeGroup = "crianca";
        else if (idade <= 17) detectedAgeGroup = "adolescente";
        else detectedAgeGroup = "adulto";
    }

    const perfilRaw =
        extracted.perfil ||
        extracted.perfilPaciente ||
        extracted.profile ||
        extracted.patientProfile ||
        null;

    if (!detectedAgeGroup && perfilRaw) {
        const p = String(perfilRaw).toLowerCase();
        if (/crianc|crianç|infantil|escolar|bebe|bebê/.test(p)) detectedAgeGroup = "crianca";
        else if (/adolesc/.test(p)) detectedAgeGroup = "adolescente";
        else if (/adult/.test(p)) detectedAgeGroup = "adulto";
    }

    if (detectedAgeGroup) {
        // joga pro contexto da conversa (pra triagem não perguntar de novo)
        if (!enrichedContext.ageGroup) {
            enrichedContext.ageGroup = detectedAgeGroup;
        }

        // persiste no lead se ainda não tiver salvo
        if (lead?._id && !lead?.ageGroup) {
            try {
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: {
                        ageGroup: detectedAgeGroup,
                        "contextMemory.hasAge": true,
                        "contextMemory.lastAgeDetected": new Date(),
                    },
                }).catch(() => { });
                lead.ageGroup = detectedAgeGroup;
            } catch (e) {
                // não quebra o fluxo se der erro de persistência
            }
        }
    }
}

// 🔄 Se o lead já tem ageGroup salvo, garante que o contexto enxerga
if (!enrichedContext.ageGroup && lead?.ageGroup) {
    enrichedContext.ageGroup = lead.ageGroup;
}

// 3) Calcula FLAGS uma vez pro fluxo todo
let flags = {};
try {
    flags = detectAllFlags(text, lead, enrichedContext) || {};
} catch (err) {
    console.warn("[ORCHESTRATOR] detectAllFlags falhou:", err.message);
    flags = {};
}

const quick = extractQuickFactsFromText(text);

if (lead?._id && quick.ageGroup) {
    const update = {
        ageGroup: quick.ageGroup,
        "contextMemory.hasAge": true,
        "contextMemory.lastAgeDetected": new Date(),
    };

    if (quick.ageValue) {
        update["contextMemory.ageValue"] = quick.ageValue; // ex: "7 meses"
    }

    await Leads.findByIdAndUpdate(lead._id, { $set: update }).catch(() => { });

    // ✅ Atualiza objeto local também
    lead.ageGroup = quick.ageGroup;
    lead.contextMemory = { ...lead.contextMemory, hasAge: true, ageValue: quick.ageValue };

    // ✅ Propaga pro contexto
    enrichedContext.ageGroup = quick.ageGroup;
}

// 🔥 Mesma lógica pro período preferido
if (lead?._id && quick.preferredPeriod && !lead.pendingPreferredPeriod) {
    await Leads.findByIdAndUpdate(lead._id, {
        $set: { pendingPreferredPeriod: quick.preferredPeriod }
    }).catch(() => { });

    lead.pendingPreferredPeriod = quick.preferredPeriod;
    enrichedContext.preferredPeriod = quick.preferredPeriod;
}

// 1) Joga pro contexto
if (quick.ageGroup && !enrichedContext.ageGroup) {
    enrichedContext.ageGroup = quick.ageGroup;
}

if (quick.preferredPeriod && !enrichedContext.preferredPeriod) {
    enrichedContext.preferredPeriod = quick.preferredPeriod;
}

if (quick.isChild) {
    flags.mentionsChild = true;
}

// 2) Persiste no lead (memória longa)
if (lead?._id) {
    const update = {};

    if ((quick.ageGroup || quick.ageValue) && lead?._id) {
        const update = {
            ageGroup: quick.ageGroup || lead.ageGroup || "crianca",
            "contextMemory.hasAge": true,
            "contextMemory.lastAgeDetected": new Date(),
        };

        if (quick.ageValue) update["contextMemory.ageValue"] = quick.ageValue;

        await Leads.findByIdAndUpdate(lead._id, { $set: update }).catch(() => { });
        Object.assign(lead, update);
        enrichedContext.ageGroup = update.ageGroup;
    }


    if (Object.keys(update).length) {
        await Leads.findByIdAndUpdate(lead._id, { $set: update }).catch(() => { });
        Object.assign(lead, update);
    }
}


// 4) flags já enxergam mode/urgency
const bookingProduct = mapFlagsToBookingProduct({ ...flags, text }, lead);
const areaSource = bookingProduct?._areaSource || "none";

const isSchedulingLikeText =
    GENERIC_SCHEDULE_EVAL_REGEX.test(normalized) ||
    SCHEDULING_REGEX.test(normalized);

// ❗ NÃO trata “quanto custa a avaliação” como agendamento
const wantsScheduling =
    flags.wantsSchedule ||
    flags.wantsSchedulingNow ||
    (isSchedulingLikeText && !flags.asksPrice);

// 🚦 INÍCIO + PROGRESSÃO DA TRIAGEM (SEM STALE LEAD)
// Regra: 1 pergunta por vez.
// Fluxo: ask_profile -> ask_area -> ask_period -> done (SEM ask_complaint, SEM pedir dia)
const schedulingConversation =
    wantsScheduling ||
    Boolean(lead?.triageStep) ||
    lead?.stage === "interessado_agendamento" ||
    enrichedContext?.stage === "interessado_agendamento" ||
    enrichedContext?.stage === "triagem_agendamento";

if (lead?._id && schedulingConversation && !lead?.pendingPatientInfoForScheduling) {
    // ✅ REFRESH: pega lead atualizado do banco (com dados salvos acima)
    const freshLead = await Leads.findById(lead._id).lean().catch(() => null);
    if (freshLead) {
        lead = { ...lead, ...freshLead }; // merge
    }

    // 🔥 CHECAGEM INTELIGENTE: só entra na triagem se REALMENTE faltar algo
    const hasProfileNow = Boolean(
        lead.ageGroup ||
        enrichedContext.ageGroup ||
        quick.ageGroup ||
        /\b\d{1,2}\s*(anos?|m[eê]s|meses)\b/i.test(text)
    );

    const hasAreaNow = Boolean(
        bookingProduct?.therapyArea ||
        lead?.autoBookingContext?.therapyArea ||
        lead?.therapyArea ||
        enrichedContext?.therapyArea
    );

    const hasPeriodNow = Boolean(
        lead?.pendingPreferredPeriod ||
        enrichedContext?.preferredPeriod ||
        quick.preferredPeriod ||
        detectPeriod(text)
    );

    // ✅ Se já tem TUDO, pula triagem (avança direto pra slots)
    if (hasProfileNow && hasAreaNow && hasPeriodNow) {
        // Força step=done pra sair da triagem
        if (lead.triageStep && lead.triageStep !== "done") {
            await Leads.findByIdAndUpdate(lead._id, {
                $set: { triageStep: "done", stage: "interessado_agendamento" }
            }).catch(() => { });

            lead.triageStep = "done";
            lead.stage = "interessado_agendamento";
        }
    }

    // ✅ Se ainda falta algo, avança 1 step
    let step = lead?.triageStep || "ask_profile";

    if (step === "ask_profile" && hasProfileNow) {
        step = hasAreaNow ? "ask_period" : "ask_area";
    } else if (step === "ask_area" && hasAreaNow) {
        step = "ask_period";
    } else if (step === "ask_period" && hasPeriodNow) {
        step = "done";
    }

    // ✅ Só atualiza se mudou
    if (step !== lead?.triageStep) {
        const update = { triageStep: step };

        if (!lead?.triageStep) update.stage = "triagem_agendamento";

        if (step === "done") {
            update.stage = "interessado_agendamento";
            update.pendingPreferredPeriod = hasPeriodNow || lead?.pendingPreferredPeriod || null;
        }

        await Leads.findByIdAndUpdate(lead._id, { $set: update }).catch(() => { });
        lead = { ...lead, ...update };
    }

    // 🚨 BLOQUEIO: se ainda não terminou, só pergunta o próximo
    if (lead.triageStep && lead.triageStep !== "done") {
        return ensureSingleHeart(buildTriageSchedulingMessage({ lead }));
    }


    // bloqueio forte: se não terminou triagem, só pergunta o próximo passo
    if (lead.triageStep && lead.triageStep !== "done") {
        return ensureSingleHeart(buildTriageSchedulingMessage({ lead }));
    }


    // 🧮 Normaliza contagem de mensagens
    const historyLen = Array.isArray(enrichedContext.conversationHistory)
        ? enrichedContext.conversationHistory.length
        : enrichedContext.messageCount || 0;

    const msgCount = historyLen + 1;
    enrichedContext.messageCount = msgCount;

    if (!enrichedContext?.pendingSchedulingSlots && lead?.pendingSchedulingSlots) {
        enrichedContext.pendingSchedulingSlots = lead.pendingSchedulingSlots;
    }

    // ✅ Se já tem slots pendentes e o lead respondeu escolhendo
    const rawPending = getCurrentSlots(lead, enrichedContext);

    const hasPendingSlots = hasAnySlot(rawPending);


    if (lead?._id && hasPendingSlots) {
        const slotsCtx = normalizeSlots(rawPending);
        slotsCtx.all = [
            slotsCtx.primary,
            ...slotsCtx.alternativesSamePeriod,
            ...slotsCtx.alternativesOtherPeriod,
        ].filter(Boolean);


        const onlyOne = slotsCtx.all.length === 1 ? slotsCtx.all[0] : null;
        const isNo = /\b(n[aã]o|nao|prefiro\s+outro|outro\s+hor[aá]rio)\b/i.test(text);
        let isYes = /\b(sim|confirmo|ok|okay|pode\s+ser|fechado|beleza)\b/i.test(text);
        isYes = isYes && !isNo;

        if (onlyOne && isYes) {
            // ✅ COMMIT 4: revalidar slot antes de pedir dados
            const refreshMeta =
                rawPending?._meta ||
                lead?.pendingSchedulingSlots?._meta ||
                null;

            const validation = await validateSlotStillAvailable(onlyOne, refreshMeta);

            if (!validation?.isValid) {
                const fresh = validation?.freshSlots || null;

                if (hasAnySlot(fresh)) {
                    // Atualiza menu e limpa escolha antiga
                    await Leads.findByIdAndUpdate(lead._id, {
                        $set: {
                            pendingSchedulingSlots: fresh,
                            pendingChosenSlot: null,
                            pendingPatientInfoForScheduling: false,
                            pendingPatientInfoStep: null,
                        }
                    }).catch(() => { });

                    const normalizedFresh = normalizeSlots(fresh);
                    const { optionsText } = buildSlotMenuCompat(normalizedFresh);

                    const msg =
                        `Ops! Esse horário acabou de ser preenchido 😕\n\n` +
                        `Tenho essas outras opções no momento:\n\n${optionsText}\n\n` +
                        `Me responde só com a **letra** (A, B, C...) ou **número** (1 a 6) 💚`;

                    return ensureSingleHeart(msg);
                }

                // Se nem freshSlots vieram, volta a perguntar preferências sem avançar estado
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: {
                        pendingChosenSlot: null,
                        pendingPatientInfoForScheduling: false,
                        pendingPatientInfoStep: null,
                    }
                }).catch(() => { });

                return "Ops! Esse horário acabou de ser preenchido 😕 Você prefere **manhã ou tarde** fica melhor? 💚";
            }

            await Leads.findByIdAndUpdate(lead._id, {
                $set: {
                    pendingChosenSlot: onlyOne,
                    pendingPatientInfoForScheduling: true,
                    pendingPatientInfoStep: "name",
                },
            }).catch(() => { });

            return "Perfeito! Me manda só o **nome completo** do paciente 💚";
        }

        if (onlyOne && isNo) {
            return "Sem problema! Você prefere **manhã ou tarde** fica melhor? 💚";
        }

        const hasLetterChoice =
            /(?:^|\s)([A-F])(?:\s|$|[).,;!?])/i.test(text) ||
            /\bop[çc][aã]o\s*([A-F])\b/i.test(text);

        const hasNumberChoice =
            /(?:^|\s)([1-6])(?:\s|$|[).,;!?])/i.test(text) ||
            /\bop[çc][aã]o\s*([1-6])\b/i.test(text);

        const hasDayAndTime = hasDayAndTimePattern(text);

        const { menuMsg, optionsText, ordered, letters } = buildSlotMenuCompat(slotsCtx);

        if (!menuMsg) {
            return ensureSingleHeart(
                `${optionsText || ""}\n\nMe responde com a **letra** (A, B, C...) ou com **dia + horário** (ex.: “quinta 14h”) pra eu confirmar 💚`
            );
        }

        // ✅ Adendo: quando a pessoa responde só "manhã/tarde/noite", a gente NÃO escolhe por ela.
        // Em vez disso, mostramos até 2 opções daquele período e pedimos a letra.
        if (isPeriodOnlyAnswer(text)) {
            const desired =
                /\b(manh[ãa]|cedo)\b/i.test(text)
                    ? "manha"
                    : /\b(tarde)\b/i.test(text)
                        ? "tarde"
                        : "noite";

            const pretty =
                desired === "manha" ? "manhã" : desired === "tarde" ? "tarde" : "noite";

            const periodMenu = buildSlotMenuForPeriodCompat(slotsCtx, desired, { max: 2 });

            if (periodMenu?.optionsText) {
                const lettersHint = (periodMenu.letters || []).join(", ");
                return ensureSingleHeart(
                    `Perfeito! Pra **${pretty}**, tenho essas opções:\n\n${periodMenu.optionsText}\n\nMe responde só com a letra (${lettersHint}). Se não servir, pode dizer **outro dia/período** 💚`
                );
            }

            // Não tem naquele período → mostra o menu completo sem chutar
            return ensureSingleHeart(
                `Entendi! Pra **${pretty}** eu não encontrei horários agora 😕\n\n${menuMsg}`
            );
        }

        // Se o lead disse "não/nenhuma/outro dia", oferecemos outras opções (menu completo)
        if (isRejectingOptions(text) && !hasLetterChoice && !hasNumberChoice && !hasDayAndTime) {
            return ensureSingleHeart(
                `${menuMsg}\n\nSe preferir, me diga um **dia + horário** (ex.: “quinta 14h”) que eu tento encaixar 💚`
            );
        }

        // Escolha explícita (sem chute): letra/número sempre; strict:false apenas quando houver dia+hora.
        const looksLikeChoice = hasLetterChoice || hasNumberChoice || hasDayAndTime;

        if (!looksLikeChoice) {
            return ensureSingleHeart(menuMsg);
        }

        {
            const normalizedChoice = normalizeChoiceForOptions(text);

            let chosen = pickSlotFromUserReply(normalizedChoice, slotsCtx, { strict: true });

            // strict:false só quando houver padrão claro dia+hora, e SEM fallback silencioso
            if (!chosen && hasDayAndTime) {
                chosen = pickSlotFromUserReply(normalizedChoice, slotsCtx, { strict: false, noFallback: true });
            }

            if (!chosen) {
                return ensureSingleHeart(
                    `${optionsText}\n\nNão consegui identificar sua escolha 😅 Me responde só com a **letra** (A, B, C...) ou **número** (1 a 6) 💚`
                );
            }

            if (chosen) {
                // ✅ COMMIT 4: revalidar slot antes de pedir dados
                const refreshMeta =
                    rawPending?._meta ||
                    lead?.pendingSchedulingSlots?._meta ||
                    null;

                const validation = await validateSlotStillAvailable(chosen, refreshMeta);

                if (!validation?.isValid) {
                    const fresh = validation?.freshSlots || null;

                    if (hasAnySlot(fresh)) {
                        await Leads.findByIdAndUpdate(lead._id, {
                            $set: {
                                pendingSchedulingSlots: fresh,
                                pendingChosenSlot: null,
                                pendingPatientInfoForScheduling: false,
                                pendingPatientInfoStep: null,
                            }
                        }).catch(() => { });

                        const normalizedFresh = normalizeSlots(fresh);
                        const { optionsText } = buildSlotMenuCompat(normalizedFresh);

                        const msg =
                            `Ops! Esse horário acabou de ser preenchido 😕\n\n` +
                            `Tenho essas outras opções no momento:\n\n${optionsText}\n\n` +
                            `Me responde só com a **letra** (A, B, C...) ou **número** (1 a 6) 💚`;

                        return ensureSingleHeart(msg);
                    }

                    return "Ops! Esse horário acabou de ser preenchido 😕 Quer que eu te envie outras opções? 💚";
                }

                await Leads.findByIdAndUpdate(lead._id, {
                    $set: {
                        pendingChosenSlot: chosen,
                        pendingPatientInfoForScheduling: true,
                        pendingPatientInfoStep: "name",
                    }
                }).catch(() => { });

                return "Perfeito! Me manda só o **nome completo** do paciente 💚";
            }

        }
    }

    // 🔎 Data explícita no texto
    const parsedDateStr = extractPreferredDateFromText(text);
    if (parsedDateStr) flags.preferredDate = parsedDateStr;

    // ✅ bookingMapper sabe que estamos no fluxo de agendamento
    const currentSlotsForFlow = getCurrentSlots(lead, enrichedContext);
    const hasSlotsForFlow = hasAnySlot(currentSlotsForFlow);

    flags.inSchedulingFlow = Boolean(
        hasSlotsForFlow ||
        lead?.pendingChosenSlot ||
        lead?.pendingPatientInfoForScheduling ||
        lead?.autoBookingContext?.therapyArea ||
        enrichedContext?.stage === "interessado_agendamento" ||
        lead?.stage === "interessado_agendamento"
    );

    // ✅ Persistir explicitArea escolhida (somente quando mapper pediu)
    // (garante que “Quero agendar com a fono” não fique preso em psicologia)
    if (
        lead?._id &&
        bookingProduct?._shouldPersistTherapyArea &&
        bookingProduct?.therapyArea &&
        bookingProduct.therapyArea !== (lead?.autoBookingContext?.therapyArea || lead?.therapyArea)
    ) {
        await Leads.findByIdAndUpdate(lead._id, {
            $set: {
                therapyArea: bookingProduct.therapyArea,
                "autoBookingContext.therapyArea": bookingProduct.therapyArea,
                // opcional: limpar specialties/produto antigo se você quiser evitar lixo herdado
                "autoBookingContext.mappedSpecialties": [],
                "autoBookingContext.mappedProduct": bookingProduct.product || bookingProduct.therapyArea,
            },
        }).catch(() => { });
    }

    if (!flags.therapyArea && bookingProduct?.therapyArea) {
        flags.therapyArea = bookingProduct.therapyArea;
    }

    // ✅ Persistência: não trocar de área depois

    const resolvedTherapyArea =
        bookingProduct?.therapyArea ||
        flags.therapyArea ||
        lead?.autoBookingContext?.therapyArea ||
        lead?.therapyArea ||
        null;

    if (resolvedTherapyArea) {
        enrichedContext.therapyArea = resolvedTherapyArea;
        if (lead?._id && lead?.therapyArea !== resolvedTherapyArea) {
            await Leads.findByIdAndUpdate(lead._id, { $set: { therapyArea: resolvedTherapyArea } }).catch(
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

    // ✅ prioridade máxima pra preço (mas usando o builder + Claude)
    if (isPurePriceQuestion) {
        // tenta inferir a terapia pra ajudar o topic/priceLine
        let therapies = [];
        try {
            therapies = detectAllTherapies(text) || [];
        } catch (_) {
            therapies = [];
        }

        // se não detectou nada, deixa vazio mesmo — o builder vai pedir a área
        const therapyAnswer = await callClaudeWithTherapyData({
            therapies,
            flags: {
                ...flags,
                asksPrice: true,        // garante
                text,                   // garante
                rawText: text,          // garante
            },
            userText: text,
            lead,
            context: enrichedContext,
            analysis,
        });

        const scoped = enforceClinicScope(therapyAnswer, text);
        return ensureSingleHeart(scoped);
    }


    logBookingGate(flags, bookingProduct);

    const acceptedPrivateNow =
        /\b(ok|beleza|pode\s+ser|tudo\s+bem|sem\s+problema|particular\s+mesmo|pode\s+seguir)\b/i.test(text) &&
        /\b(particular|reembolso|plano|conv[eê]nio|unimed|ipasgo|amil)\b/i.test(text);

    if (lead?._id && acceptedPrivateNow) {
        await Leads.findByIdAndUpdate(lead._id, {
            $set: { acceptedPrivateCare: true, insuranceHardNo: false },
        }).catch(() => { });
    }
    // ✅ Se eu estava no gate do plano e o lead respondeu "ok/sim", aceita particular sem precisar repetir "plano"
    if (lead?._id && lead?.insuranceGatePending && isSimpleYes(text)) {
        await Leads.findByIdAndUpdate(lead._id, {
            $set: { acceptedPrivateCare: true, insuranceHardNo: false },
            $unset: { insuranceGatePending: "" }
        }).catch(() => { });
    }

    // PRD: não deixar gate pendurado travar a conversa
    if (lead?._id && lead?.insuranceGatePending) {
        const movedOn =
            /\b(agendar|marcar|hor[aá]rio|dia|semana|tarde|manh[ãa]|sexta|segunda)\b/i.test(text) ||
            /\b(pre[çc]o|preco|valor|quanto\s+custa)\b/i.test(text);

        if (movedOn && !isSimpleYes(text)) {
            await Leads.findByIdAndUpdate(lead._id, {
                $unset: { insuranceGatePending: "" }
            }).catch(() => { });
        }
    }

    const wantsPlan = /\b(unimed|plano|conv[eê]nio|ipasgo|amil)\b/i.test(text);
    const isHardPlanCondition =
        /\b(s[oó]\s*se|apenas\s*se|somente\s*se|quero\s+continuar\s+se)\b.*\b(unimed|plano|conv[eê]nio)\b/i.test(
            text,
        );

    if (wantsPlan && lead?.acceptedPrivateCare !== true) {
        if (isHardPlanCondition && lead?._id) {
            await Leads.findByIdAndUpdate(lead._id, {
                $set: { insuranceHardNo: true, acceptedPrivateCare: false },
            }).catch(() => { });
        }

        // marca pending
        if (lead?._id) {
            await Leads.findByIdAndUpdate(lead._id, {
                $set: { insuranceGatePending: true },
            }).catch(() => { });
        }

        try {
            const extraFlags = detectAllFlags(text, lead, enrichedContext) || {};
            flags = { ...flags, ...extraFlags };
        } catch (err) {
            console.warn("[ORCHESTRATOR] detectAllFlags (plano) falhou:", err.message);
        }


        return ensureSingleHeart(
            "Atendemos no particular e emitimos recibo/nota pra você tentar reembolso no plano. Quer que eu já te mostre os horários disponíveis? 💚"
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
    // ✅ (Opcional, recomendado) Persistir stage para consistência em follow-up e próximos ciclos
    if (lead?._id && newStage && newStage !== lead?.stage) {
        Leads.findByIdAndUpdate(lead._id, { $set: { stage: newStage } })
            .catch(() => { });
    }

    // 🦴🍼 Gate osteopata (físio bebê)
    const babyContext =
        /\b\d{1,2}\s*(mes|meses)\b/i.test(text) || /\b(beb[eê]|rec[eé]m[-\s]*nascid[oa]|rn)\b/i.test(text);

    const therapyAreaForGate =
        enrichedContext.therapyArea ||
        flags.therapyArea ||
        bookingProduct?.therapyArea ||
        lead?.autoBookingContext?.therapyArea ||
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

    const profileCheck = hasAgeOrProfileNow(text, flags, enrichedContext);

    // ===============================
    // 🚨 GATE REAL: perfil / área antes de IA (LEGADO)
    // Agora só roda pra leads que ainda NÃO usam a triagem nova (sem triageStep)
    // ===============================
    if (
        wantsScheduling &&
        !lead?.pendingPatientInfoForScheduling &&
        !lead?.triageStep // <- se já existe triageStep (ask_profile/ask_area/ask_period/done), usamos só a triagem nova
    ) {
        // força child flag (continua valendo)
        if (/\b(meu|minha)\s+(filh[oa]|crian[çc]a)\b/i.test(text)) {
            flags.mentionsChild = true;
        }

        const hasProfile =
            flags.mentionsChild ||
            flags.mentionsTeen ||
            flags.mentionsAdult ||
            profileCheck?.hasProfile ||
            lead?.ageGroup;

        const hasArea = !!(
            bookingProduct?.therapyArea ||
            flags?.therapyArea ||
            lead?.autoBookingContext?.therapyArea ||
            lead?.therapyArea
        );

        // ❌ SEM PERFIL (apenas em leads legado, sem triagem nova)
        if (!hasProfile) {
            return ensureSingleHeart(
                "Pra eu te orientar certinho, a avaliação é pra **criança, adolescente ou adulto**? 💚"
            );
        }

        // ❌ SEM ÁREA (apenas em leads legado, sem triagem nova)
        if (!hasArea) {
            return ensureSingleHeart(
                "Qual atendimento você está buscando? (Fono, Psicologia, TO, Fisioterapia ou Neuropsicológica) 💚"
            );
        }
    }


    if (bookingProduct?.product === "multi_servico") {
        const combined = `${text}`.toLowerCase();
        const wantsLinguinha = /\b(teste\s+da\s+linguinha|linguinha|freio\s+lingual|fr[eê]nulo)\b/i.test(combined);
        const wantsFisio = /\b(fisio|fisioterapia)\b/i.test(combined);

        const services = [
            wantsFisio ? "Fisioterapia" : null,
            wantsLinguinha ? "Teste da Linguinha" : null,
        ].filter(Boolean);

        if (services.length >= 2) {
            return ensureSingleHeart(
                `Perfeito! Só confirmando: você quer **${services.join("** e **")}**, certo? Quer agendar **primeiro qual dos dois**? 💚`
            );
        }

        // fallback neutro: não inventa
        return ensureSingleHeart(
            "Perfeito! Só pra eu organizar certinho: você quer agendar **quais atendimentos**? (ex.: Fono, Psicologia, TO, Fisio, Neuropsico) 💚"
        );
    }


    if (RESCHEDULE_REGEX.test(normalized)) {
        return ensureSingleHeart(
            "Claro! Vamos remarcar 😊 Você prefere **manhã ou tarde** fica melhor pra você? 💚"
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
        lead?.autoBookingContext?.therapyArea ||
        lead?.therapyArea ||
        enrichedContext?.therapyArea ||
        null;

    const specialtiesForSlots =
        (bookingProduct?.specialties?.length ? bookingProduct.specialties : null) ||
        lead?.autoBookingContext?.mappedSpecialties ||
        [];

    if (profileCheck.inferred?.mentionsChild) flags.mentionsChild = true;
    if (profileCheck.inferred?.ageGroup && !enrichedContext.ageGroup) enrichedContext.ageGroup = profileCheck.inferred.ageGroup;

    if (profileCheck.inferred?.ageGroup && lead?._id) {
        await Leads.findByIdAndUpdate(lead._id, {
            $set: {
                ageGroup: profileCheck.inferred.ageGroup,
                "contextMemory.hasAge": true,
                "contextMemory.lastAgeDetected": new Date()
            }
        }).catch(() => { });
    }
    const ageMatch = text.match(/\b(\d{1,2})\s*anos?\b/i);
    if (ageMatch && lead?._id && !lead?.ageGroup) {
        const age = parseInt(ageMatch[1], 10);
        const group = age < 12 ? "crianca" : age < 18 ? "adolescente" : "adulto";
        await Leads.findByIdAndUpdate(lead._id, {
            $set: { ageGroup: group, "contextMemory.hasAge": true, "contextMemory.lastAgeDetected": new Date() }
        }).catch(() => { });
    }

    const pendingSlotsNow = getCurrentSlots(lead, enrichedContext);
    const alreadyHasSlots = hasAnySlot(pendingSlotsNow);

    if (alreadyHasSlots) {
        // garante que o contexto tenha os slots pra construção do menu
        if (!enrichedContext.pendingSchedulingSlots && lead?.pendingSchedulingSlots) {
            enrichedContext.pendingSchedulingSlots = lead.pendingSchedulingSlots;
        }
    }

    const schedulingActive =
        wantsScheduling ||
        lead?.stage === "interessado_agendamento" ||
        lead?.triageStep === "done" ||
        Boolean(lead?.pendingPreferredPeriod);

    const shouldFetchSlots =
        schedulingActive &&
        lead?.triageStep === "done" &&
        therapyAreaForSlots &&
        !alreadyHasSlots &&
        !lead?.pendingPatientInfoForScheduling;

    if (shouldFetchSlots) {
        if (!therapyAreaForSlots) {
            console.log("⚠️ [ORCHESTRATOR] quer agendar mas sem therapyArea (triagem faltando)");
            return ensureSingleHeart(
                buildTriageSchedulingMessage({ lead })
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
            if (!hasAnySlot(availableSlots)) {
                // fallback: tenta sem filtro de período e mostra o que tem (sem chutar)
                if (preferredPeriod) {
                    const fallbackSlots = await findAvailableSlots({
                        therapyArea: therapyAreaForSlots,
                        specialties: specialtiesForSlots,
                        preferredDay: null,
                        preferredPeriod: null,
                        preferredDate: preferredSpecificDate,
                        daysAhead: 30,
                    });

                    if (hasAnySlot(fallbackSlots)) {
                        await Leads.findByIdAndUpdate(lead._id, {
                            $set: { pendingSchedulingSlots: fallbackSlots },
                        }).catch(() => { });

                        const normalizedFallback = normalizeSlots(fallbackSlots);
                        const { optionsText, ordered, letters } = buildSlotMenuCompat(normalizedFallback);
                        const allowed = (Array.isArray(letters) ? letters : SLOT_LETTERS).slice(0, Math.max(1, (ordered?.length || 0))).join(", ");

                        const pretty =
                            preferredPeriod === "manha" ? "manhã" :
                                preferredPeriod === "tarde" ? "tarde" : "noite";

                        return ensureSingleHeart(
                            `Pra **${pretty}** não encontrei vaga agora 😕\n\nTenho essas opções no momento:\n\n${optionsText}\n\nQual você prefere? (${allowed})`
                        );
                    }
                }

                return ensureSingleHeart("No momento não encontrei horários disponíveis 😕 Qual período fica melhor: **manhã ou tarde**?");
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
                        const picked = pickTwoSlots({
                            primary: prioritized[0],
                            alternativesSamePeriod: prioritized.slice(1),
                            alternativesOtherPeriod: [],
                        });

                        availableSlots.primary = picked.primary;
                        availableSlots.alternativesSamePeriod = picked.alternativesSamePeriod;
                        availableSlots.alternativesOtherPeriod = [];
                    }

                    console.log(`🔎 Urgência aplicada (${urgencyLevel}) → ${prioritized.length} slots priorizados`);
                } catch (err) {
                    console.error("Erro ao aplicar urgência:", err);
                }
            }


            // ✅ COMMIT 4: guarda contexto de busca dentro do pendingSchedulingSlots (schema é Mixed)
            try {
                if (availableSlots && typeof availableSlots === "object") {
                    availableSlots._meta = {
                        therapyArea: therapyAreaForSlots,
                        specialties: specialtiesForSlots,
                        preferredDay,
                        preferredPeriod,
                        preferredDate: preferredSpecificDate,
                        daysAhead: 30,
                        createdAt: new Date().toISOString(),
                    };
                }
            } catch (_) { }

            await Leads.findByIdAndUpdate(lead._id, {
                $set: {
                    pendingSchedulingSlots: availableSlots,

                    // 🧼 COMMIT 4.1: sempre que eu gero um NOVO menu, eu zero a escolha antiga
                    pendingChosenSlot: null,
                    pendingPatientInfoForScheduling: false,
                    pendingPatientInfoStep: null,

                    urgencyApplied: urgencyLevel,
                    "autoBookingContext.active": true,
                    "autoBookingContext.therapyArea": therapyAreaForSlots,
                    "autoBookingContext.mappedSpecialties": specialtiesForSlots,
                    "autoBookingContext.mappedProduct": bookingProduct?.product,
                },
            }).catch(() => { });


            enrichedContext.pendingSchedulingSlots = availableSlots;

            // ✅ Fonte única de menu A..F
            const normalizedSlots = normalizeSlots(availableSlots);
            const { menuMsg, optionsText, ordered, letters } = buildSlotMenuCompat(normalizedSlots);

            if (!menuMsg) {
                // se o builder falhar, pelo menos entrega o optionsText ou um menu simples
                const fallbackText =
                    optionsText ||
                    `A) ${formatSlot(availableSlots.primary)}\n` +
                    (availableSlots.alternativesSamePeriod?.[0] ? `B) ${formatSlot(availableSlots.alternativesSamePeriod[0])}\n` : "") +
                    (availableSlots.alternativesSamePeriod?.[1] ? `C) ${formatSlot(availableSlots.alternativesSamePeriod[1])}\n` : "");

                return ensureSingleHeart(
                    `Tenho esses horários no momento:\n\n${fallbackText}\n\nMe responde com a letra (A, B, C...) 💚`
                );
            }


            // ✅ allowed baseado no que realmente existe
            const allowed = (Array.isArray(letters) ? letters : SLOT_LETTERS).slice(0, Math.max(1, (ordered?.length || 0))).join(", ");

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
            return "Tive um probleminha ao checar os horários agora 😕 Você prefere **manhã ou tarde** fica melhor? 💚";
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

    // ✅ garante que o contexto do LLM tenha os slots reais, mesmo que só estejam no lead
    if (!enrichedContext.pendingSchedulingSlots && lead?.pendingSchedulingSlots) {
        enrichedContext.pendingSchedulingSlots = lead.pendingSchedulingSlots;
    }
    // Fluxo geral
    const genericAnswer = await callAmandaAIWithContext(text, lead, enrichedContext, flags, analysis);

    const finalScoped = enforceClinicScope(genericAnswer, text);
    return ensureSingleHeart(finalScoped);
}

function safeHour(slot) {
    const t = slot?.time;
    if (typeof t !== "string") return null;
    const m = t.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    if (Number.isNaN(h)) return null;
    return h;
}


function pickTwoSlots(slots) {
    const all = [
        slots?.primary,
        ...(slots?.alternativesSamePeriod || []),
        ...(slots?.alternativesOtherPeriod || []),
    ].filter(Boolean);

    const byPeriod = { manha: [], tarde: [] };

    for (const s of all) {
        const h = safeHour(s);
        if (h === null) continue;
        if (h < 12) byPeriod.manha.push(s);
        else if (h < 18) byPeriod.tarde.push(s);
    }

    // se nenhum slot tem hora válida, só devolve o primeiro “safe”
    if (!byPeriod.manha.length && !byPeriod.tarde.length) {
        const first = all[0] || null;
        return { primary: first, alternativesSamePeriod: all.slice(1, 2), alternativesOtherPeriod: [] };
    }

    const result = [];

    if (byPeriod.manha.length) result.push(byPeriod.manha[0]);
    if (byPeriod.tarde.length) result.push(byPeriod.tarde[0]);

    // fallback: só manhã ou só tarde
    if (result.length === 1) {
        const h0 = safeHour(result[0]);
        const samePeriod = (h0 !== null && h0 < 12) ? byPeriod.manha : byPeriod.tarde;

        if (samePeriod[1]) result.push(samePeriod[1]);
    }

    return {
        primary: result[0],
        alternativesSamePeriod: result.slice(1),
        alternativesOtherPeriod: []
    };
}


function extractQuickFactsFromText(text = "") {
    const t = String(text || "");
    const lower = t.toLowerCase();

    // 🔥 REGEX ROBUSTA - captura "7 mês", "3 anos", "18 meses", etc
    const yearsMatch = t.match(/\b(\d{1,2})\s*anos?\b/i);
    const monthsMatch = t.match(/\b(\d{1,2})\s*(m[eê]s|meses)\b/i); // ← FIX: aceita "mês" com acento

    let ageNumber = null;
    let ageUnit = null;
    let ageGroup = null;

    if (monthsMatch) {
        ageNumber = parseInt(monthsMatch[1], 10);
        ageUnit = "meses";
        ageGroup = "crianca"; // ← bebê sempre é criança
    } else if (yearsMatch) {
        ageNumber = parseInt(yearsMatch[1], 10);
        ageUnit = "anos";
        if (!Number.isNaN(ageNumber)) {
            if (ageNumber <= 12) ageGroup = "crianca";
            else if (ageNumber <= 17) ageGroup = "adolescente";
            else ageGroup = "adulto";
        }
    }

    // 🔥 FALLBACK: palavras-chave
    const isChildByWords = /\b(filh[oa]|crianç|bebê|bebe|menino|menina)\b/i.test(t);
    if (isChildByWords && !ageGroup) {
        ageGroup = "crianca";
    }

    // período
    let preferredPeriod = null;
    if (/\bmanh[ãa]\b/i.test(lower)) preferredPeriod = "manha";
    if (/\btarde\b/i.test(lower)) preferredPeriod = "tarde";

    return {
        ageValue: ageNumber ? `${ageNumber} ${ageUnit}` : null, // ← NOVO: guarda valor bruto
        ageNumber,
        ageUnit,
        ageGroup,
        isChild: isChildByWords || ageGroup === "crianca",
        preferredPeriod,
    };
}

/**
 * Extrai nome + data de nascimento do lead ou da mensagem atual
 */
function extractPatientInfoFromLead(lead, lastMessage) {
    let fullName = lead.patientInfo?.fullName || lead.name || null;
    let birthDate = lead.patientInfo?.birthDate || null;
    const phone = lead.contact?.phone || lead.phone || null;
    const email = lead.contact?.email || lead.email || null;

    const msg = String(lastMessage || "").trim();

    // ✅ 1) Padrão: "Nome, dd/mm/aaaa"
    if ((!fullName || !birthDate)) {
        const combo = msg.match(/^\s*([^,\n]{3,80})\s*,\s*(\d{2})[\/\-](\d{2})[\/\-](\d{4})\s*$/);
        if (combo) {
            const [, name, dd, mm, yyyy] = combo;
            fullName = fullName || name.trim();
            birthDate = birthDate || `${yyyy}-${mm}-${dd}`;
        }
    }

    // ✅ 2) "Nome: X" / "Nascimento: dd/mm/aaaa"
    if (!fullName) {
        const n = msg.match(/\b(nome|paciente)\s*[:\-]\s*([a-zÀ-úA-ZÀ-Ú\s]{3,80})/i);
        if (n) fullName = n[2].trim();
    }
    if (!birthDate) {
        const d = msg.match(/\b(nasc|nascimento|data\s*de\s*nasc)\s*[:\-]?\s*(\d{2})[\/\-](\d{2})[\/\-](\d{4})/i);
        if (d) birthDate = `${d[4]}-${d[3]}-${d[2]}`;
    }

    // ✅ 3) Teu padrão antigo ("me chamo", etc.) continua valendo
    if (!fullName) {
        const nameMatch = msg.match(/(?:meu nome [eé]|me chamo|sou)\s+([a-zà-úA-ZÀ-Ú\s]+)/i);
        if (nameMatch) fullName = nameMatch[1].trim();
    }
    if (!birthDate) {
        const dateMatch = msg.match(/\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/);
        if (dateMatch) birthDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
    }

    return { fullName, birthDate, phone, email };
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
    const isFrenuloOrLinguinha =
        /\b(fr[eê]nulo|freio\s+lingual|fr[eê]nulo\s+lingual|teste\s+da\s+linguinha|linguinha)\b/i.test(userText || "");

    if (mentionsOrelhinha) {
        // só menciona linguinha se o usuário citou linguinha/freio/frênulo
        if (isFrenuloOrLinguinha) {
            return (
                "O teste da orelhinha (triagem auditiva) nós **não realizamos** aqui. " +
                "Já o **Teste da Linguinha (R$150)** a gente faz sim. Quer agendar pra essa semana ou pra próxima? 💚"
            );
        }

        return (
            "O teste da orelhinha (triagem auditiva/TAN) nós **não realizamos** aqui. " +
            "Você está buscando **um exame** (auditivo) ou é **avaliação/terapia** pra alguma queixa (fala, linguagem, etc.)? 💚"
        );
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

        const prompt = buildUserPromptWithValuePitch({
            ...flags,
            text: userText,          // garante que sempre tem texto
            rawText: userText,       // usa o raw (sem mexer)
            conversationSummary: context?.conversationSummary || "",
            inSchedulingFlow: flags.inSchedulingFlow || context?.inSchedulingFlow,
            therapyArea: flags.therapyArea || context?.therapyArea,
            ageGroup: flags.ageGroup || context?.ageGroup,
        });
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
        lead?.autoBookingContext?.therapyArea ||
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

    // 🧠 Checa se já tem tudo pra não ficar perguntando o que já sabemos
    const extracted = lead?.qualificationData?.extractedInfo || {};
    const missing = [];

    if (!extracted.idade) missing.push("idade");
    if (!extracted.especialidade && !lead?.therapyArea) missing.push("especialidade");
    if (!extracted.disponibilidade && !lead?.pendingPatientInfoForScheduling) missing.push("período");

    if (missing.length > 0) {
        const prompt = buildDynamicPromptForMissing(missing, extracted);
        console.log("⚙️ [AmandaFlow] Gerando prompt dinâmico:", prompt);

        return {
            thought_process: "Faltam informações básicas para o agendamento. Gerando pergunta contextual.",
            reply_to_user: prompt,
            update_lead_state: {
                triageStep: "ask_missing_info"
            }
        };
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
            const hour = safeHour(s);
            if (hour === null) continue;

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
    const allowed = new Set(["user", "assistant"]);
    return (messages || [])
        .filter(Boolean)
        .map((m) => {
            const role = allowed.has(m.role) ? m.role : "user";

            let contentBlocks;
            if (typeof m.content === "string") {
                contentBlocks = [{ type: "text", text: m.content }];
            } else if (Array.isArray(m.content)) {
                contentBlocks = m.content;
            } else {
                contentBlocks = [{ type: "text", text: JSON.stringify(m.content) }];
            }

            return { role, content: contentBlocks };
        });
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
        if (isFrenuloOrLinguinha) {
            return (
                "O teste da orelhinha (triagem auditiva) nós **não realizamos** aqui. " +
                "Já o **Teste da Linguinha (R$150)** a gente faz sim. Quer agendar pra essa semana ou pra próxima? 💚"
            );
        }

        return (
            "O teste da orelhinha (triagem auditiva/TAN) nós **não realizamos** aqui. " +
            "Você está buscando **um exame** (auditivo) ou é **avaliação/terapia** pra alguma queixa (fala, linguagem etc.)? 💚"
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

