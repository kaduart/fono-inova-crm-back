// services/followupOrchestrator.js
import Followup from "../models/Followup.js";
import Lead from "../models/Leads.js";
import Message from "../models/Message.js";
import { followupQueue } from "../config/bullConfig.js";
import {
  analyzeLeadMessage
} from "../services/intelligence/leadIntelligence.js";
import {
  calculateOptimalFollowupTime,
  generateContextualFollowup
} from "../services/intelligence/smartFollowup.js";
import { generateFollowupMessage } from "../services/aiAmandaService.js";

/**
 * Cria e enfileira um follow-up inteligente para um lead.
 * Pode ser usado por:
 *  - controller (createAIFollowup)
 *  - webhook de WhatsApp
 *  - qualquer outro fluxo interno
 */
export async function createSmartFollowupForLead(leadId, options = {}) {
  const {
    explicitScheduledAt = null,
    objective = "reengajamento",
    attempt = 1
  } = options;

  const lead = await Lead.findById(leadId);
  if (!lead) throw new Error("Lead não encontrado");

  // 1) buscar histórico
  const recentMessages = await Message.find({ lead: leadId })
    .sort({ timestamp: -1 })
    .limit(10)
    .lean();

  const lastInbound = recentMessages.find(m => m.direction === "inbound");

  let message;
  let score = lead.conversionScore || 50;
  let analysis = null;

  if (lastInbound?.content) {
    analysis = await analyzeLeadMessage({
      text: lastInbound.content,
      lead,
      history: recentMessages.map(m => m.content || "")
    });

    message = generateContextualFollowup({
      lead,
      analysis,
      attempt
    });

    score = analysis.score;

    await Lead.findByIdAndUpdate(leadId, {
      conversionScore: score,
      lastScoreUpdate: new Date(),
      "qualificationData.extractedInfo": analysis.extracted,
      "qualificationData.intent": analysis.intent.primary,
      "qualificationData.sentiment": analysis.intent.sentiment
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
        attempt
      });

  // 3) criar followup
  const followup = await Followup.create({
    lead: leadId,
    message,
    scheduledAt,
    status: "scheduled",
    aiOptimized: true,
    origin: lead.origin,
    note: `Amanda 2.0 - ${objective} | Score: ${score}`
  });

  // 4) enfileirar
  const delayMs = scheduledAt.getTime() - Date.now();

  await followupQueue.add(
    "followup",
    { followupId: followup._id },
    {
      jobId: `fu-${followup._id}`,
      ...(delayMs > 0 ? { delay: delayMs } : {})
    }
  );

  return { followup, score, analysis };
}
