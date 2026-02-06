// services/followupOrchestrator.js
import { followupQueue } from "../config/bullConfig.js";
import Followup from "../models/Followup.js";
import Lead from "../models/Leads.js";
import Message from "../models/Message.js";
import { generateFollowupMessage } from "../services/aiAmandaService.js";

import { analyzeLeadMessage } from "../services/intelligence/leadIntelligence.js";
import {
  calculateOptimalFollowupTime,
  generateContextualFollowup,
} from "../services/intelligence/smartFollowup.js";

// ✅ NOVO: “memória”/contexto persistido (resumo + histórico)
// 🗑️ REMOVIDO: buildContextPack - usar enrichLeadContext abaixo
import enrichLeadContext from "../services/leadContext.js";

const TZ_SP = "America/Sao_Paulo";

function getStartOfDayInSP(now = new Date()) {
  // Mantém o mesmo padrão que você já usa no worker
  const spNow = new Date(now.toLocaleString("en-US", { timeZone: TZ_SP }));
  spNow.setHours(0, 0, 0, 0);
  return spNow;
}

function isSameDayInSP(messages = []) {
  const startOfDaySP = getStartOfDayInSP(new Date());
  return messages.some((m) => m?.timestamp && new Date(m.timestamp) >= startOfDaySP);
}

/**
 * Cria e enfileira um follow-up inteligente para um lead.
 * Pode ser usado por:
 *  - controller (createAIFollowup)
 *  - webhook de WhatsApp
 *  - qualquer outro fluxo interno
 */
export async function createSmartFollowupForLead(leadId, options = {}) {
  const { explicitScheduledAt = null, objective = "reengajamento", attempt = 1 } = options;

  const lead = await Lead.findById(leadId);
  if (!lead) throw new Error("Lead não encontrado");

  // 1) buscar histórico (mais rico, igual worker)
  const recentMessages = await Message.find({ lead: leadId })
    .sort({ timestamp: -1 })
    .limit(30)
    .lean();

  const lastInbound = recentMessages.find((m) => m.direction === "inbound");

  // ✅ CONTEXTO UNIFICADO (leadContext.js tem tudo)
  const enrichedContext = await enrichLeadContext(leadId).catch(() => null);
  const summaryText = enrichedContext?.conversationSummary || null;
  const fullContext = enrichedContext || {};

  const sameDay = isSameDayInSP(recentMessages);

  // Histórico em ordem cronológica para a inteligência
  const historyChrono = recentMessages
    .slice()
    .reverse()
    .map((m) => (m.content || "").toString())
    .filter(Boolean);

  let message = "";
  let score = lead.conversionScore || 50;
  let analysis = null;

  if (lastInbound?.content) {
    analysis = await analyzeLeadMessage({
      text: lastInbound.content,
      lead,
      history: historyChrono,
    });

    // ✅ Gera follow-up já com “memória” e contexto do dia
    message = generateContextualFollowup({
      lead,
      analysis,
      attempt,
      history: recentMessages,
      sameDay,
      summaryText,
      context: fullContext,
    });

    score = analysis?.score ?? score;

    await Lead.findByIdAndUpdate(leadId, {
      conversionScore: score,
      lastScoreUpdate: new Date(),
      "qualificationData.extractedInfo": analysis?.extracted || {},
      "qualificationData.intent": analysis?.intent?.primary || null,
      "qualificationData.sentiment": analysis?.intent?.sentiment || null,
    });
  } else {
    // fallback Amanda 1.0
    message = await generateFollowupMessage(lead);
  }

  // 2) horário ótimo
  const scheduledAt = explicitScheduledAt
    ? new Date(explicitScheduledAt)
    : calculateOptimalFollowupTime({
      lead,
      score,
      lastInteraction: new Date(),
      attempt,
    });

  // 3) criar followup
  const followup = await Followup.create({
    lead: leadId,
    message,
    scheduledAt,
    status: "scheduled",
    aiOptimized: true,
    origin: lead.origin,
    note: `Amanda 2.0 - ${objective} | Score: ${score}`,
  });

  // 4) enfileirar
  const delayMs = scheduledAt.getTime() - Date.now();

  await followupQueue.add(
    "followup",
    { followupId: followup._id },
    {
      jobId: `fu-${followup._id}`,
      ...(delayMs > 0 ? { delay: delayMs } : {}),
    }
  );

  return { followup, score, analysis };
}
