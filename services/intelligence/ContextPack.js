// ======================================================
// 🔹 ContextPack.js
// Fonte única de contexto (Lead + mensagens + modo + urgência)
// ======================================================

import Lead from "../../models/Leads.js";
import Message from "../../models/Message.js";
import { determineMode } from "./ModeRouter.js";

/**
 * Monta o pacote de contexto unificado usado por AmandaAI.
 */
export async function buildContextPack(leadId) {
  const lead = await Lead.findById(leadId).lean();
  if (!lead) throw new Error("Lead não encontrado para ContextPack");

  // últimas 20 mensagens
  const messages = await Message.find({ lead: leadId })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  const recentMessages = messages.reverse();
  const lastUserMessage = recentMessages
    .slice()
    .reverse()
    .find((m) => m.from === "user");
  const lastAmandaMessage = recentMessages
    .slice()
    .reverse()
    .find((m) => m.from === "amanda");

  // Define modo (clínico / comercial / booking / suporte)
  const mode = determineMode({
    lead,
    lastUserMessage,
    recentMessages,
  });

  const toneMode = determineToneMode({
    lead,
    lastUserMessage,
  });

  const urgencyLevel =
    lead?.clinicalFlags?.includes("crise") ||
      (lead?.ageGroup === "bebê" && lead?.therapyArea === "fonoaudiologia")
      ? "ALTA"
      : lead?.urgencyLevel || "NORMAL";

  return {
    leadId,
    conversationSummary: lead.conversationSummary || "",
    knownFacts: lead.knownFacts || {},
    recentMessages,
    lastUserMessage,
    lastAmandaMessage,
    stage: lead.stage,
    mode,
    toneMode,
    urgencyLevel,
    lastAgreement: lead.lastAgreement || null,
  };
}

function determineToneMode({
  lead,
  lastUserMessage,
}) {
  const text =
    typeof lastUserMessage?.content === "string"
      ? lastUserMessage.content.toLowerCase()
      : "";

  const messageLength = text.length;

  // ================================
  // PRIORIDADE 1 — EMOÇÃO / MEDO EXPLÍCITO
  // ================================
  const emotionalKeywords = [
    "preocup",
    "medo",
    "insegur",
    "ansios",
    "receio",
    "desesper",
    "aflita",
    "com medo",
  ];

  const hasEmotionalLanguage =
    emotionalKeywords.some((word) => text.includes(word)) ||
    lead?.clinicalFlags?.includes("ansiedade") ||
    lead?.clinicalFlags?.includes("medo");

  if (hasEmotionalLanguage) {
    return "acolhimento";
  }

  // ================================
  // PRIORIDADE 2 — CONTEXTO CLÍNICO SENSÍVEL
  // ================================
  if (
    lead?.mentionsChild === true ||
    lead?.mentionsTEA === true ||
    lead?.mentionsDoubtTEA === true ||
    lead?.ageGroup === "bebê" ||
    messageLength > 300
  ) {
    return "acolhimento";
  }

  // ================================
  // PRIORIDADE 3 — PERFIL DECISOR / ADULTO
  // ================================
  const isAdultDecisor =
    lead?.mentionsAdult === true ||
    lead?.segment === "decisor" ||
    lead?.score >= 70 ||
    /quanto custa|valor|preço|agenda|horário/i.test(text);

  if (isAdultDecisor) {
    return "premium";
  }

  // ================================
  // FALLBACK SEGURO
  // ================================
  return "acolhimento";
}

