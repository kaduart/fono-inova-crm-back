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
    urgencyLevel,
    lastAgreement: lead.lastAgreement || null,
  };
}
