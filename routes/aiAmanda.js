// routes/aiAmanda.js - AMANDA 2.0 + 1.0

import express from "express";

import Followup from "../models/Followup.js";
import Lead from "../models/Leads.js";
import Message from "../models/Message.js";

// Amanda 2.0 (serviços de inteligência)
import { analyzeLeadMessage } from "../services/intelligence/leadIntelligence.js";
import { generateContextualFollowup } from "../services/intelligence/smartFollowup.js";

// Amanda 1.0 (Anthropic)
import {
    generateAmandaReply,
    generateFollowupMessage,
} from "../services/aiAmandaService.js";

import { followupQueue } from "../config/bullConfig.js";
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = express.Router();

/**
 * 🎯 POST /api/amanda/draft
 * Gera rascunho de follow-up inteligente
 *
 * Prioridade:
 * 1. Amanda 2.0 (se tiver histórico de mensagens)
 * 2. Amanda 1.0 (Anthropic)
 */
router.post("/draft", async (req, res) => {
    try {
        const { leadId, reason, campaign } = req.body;

        if (!leadId) {
            return res
                .status(400)
                .json({ success: false, message: "leadId é obrigatório" });
        }

        const lead = await Lead.findById(leadId);
        if (!lead) {
            return res
                .status(404)
                .json({ success: false, message: "Lead não encontrado" });
        }

        console.log(`🤖 Gerando draft para lead: ${lead.name} (${leadId})`);

        // 1️⃣ Tentar Amanda 2.0 com histórico
        try {
            const recentMessages = await Message.find({ lead: leadId })
                .sort({ timestamp: -1 })
                .limit(10)
                .lean();

            const lastInbound = recentMessages.find(
                (m) => m.direction === "inbound"
            );

            if (lastInbound?.content) {
                console.log("🧠 Usando Amanda 2.0 (com histórico)");

                const analysis = await analyzeLeadMessage({
                    text: lastInbound.content,
                    lead,
                    history: recentMessages.map((m) => m.content || ""),
                });

                const draft = generateContextualFollowup({
                    lead,
                    analysis,
                    attempt: 1,
                });

                console.log(
                    `✅ Amanda 2.0: Score ${analysis.score} | Draft gerado com sucesso`
                );

                return res.json({
                    success: true,
                    draft,
                    version: "2.0",
                    score: analysis.score,
                    segment: analysis.segment,
                    intent: analysis.intent,
                    meta: {
                        reason,
                        campaign,
                        hasHistory: true,
                        messagesAnalyzed: recentMessages.length,
                    },
                });
            }
        } catch (ai2Error) {
            console.warn("⚠️ Amanda 2.0 indisponível:", ai2Error.message);
        }

        // 2️⃣ Fallback para Amanda 1.0 (Anthropic)
        console.log("🤖 Usando Amanda 1.0 (API Anthropic)");

        const enrichedLead = {
            ...lead.toObject(),
            reason: reason || lead.reason,
            campaign,
        };

        const draft = await generateFollowupMessage(enrichedLead);

        console.log("✅ Amanda 1.0: Draft gerado via API Anthropic");

        return res.json({
            success: true,
            draft,
            version: "1.0",
            meta: {
                reason,
                campaign,
            },
        });
    } catch (err) {
        console.error("❌ Erro ao gerar draft:", err);

        let firstName = "Cliente";
        try {
            if (req.body.leadId) {
                const lead = await Lead.findById(req.body.leadId).lean();
                if (lead?.name) {
                    firstName = lead.name.split(" ")[0];
                }
            }
        } catch {
            // se der erro aqui, ignora e usa "Cliente"
        }

        return sendApiError(
          res,
          new AppError('INTERNAL_ERROR', "Erro ao gerar rascunho", {
            status: 500,
            extra: { fallback: `Oi ${firstName}! Como posso te ajudar? 💚` },
          }),
          req
        );
    }
});

/**
 * 💬 POST /api/amanda/reply
 * Gera resposta para mensagem do lead (chat Amanda)
 */
router.post("/reply", async (req, res) => {
    try {
        const { leadId, userText, context = {} } = req.body;

        if (!userText || !userText.trim()) {
            return res
                .status(400)
                .json({ success: false, message: "userText é obrigatório" });
        }

        console.log(`💬 Gerando resposta para: "${userText}"`);

        let leadData = {
            name: "Cliente",
            reason: "atendimento",
            origin: "whatsApp",
        };

        if (leadId) {
            const lead = await Lead.findById(leadId).lean();
            if (lead) {
                leadData = {
                    name: lead.name,
                    reason: lead.reason || lead.appointment?.seekingFor || "atendimento",
                    origin: lead.origin || "whatsApp",
                    lastInteraction: lead.updatedAt || lead.createdAt,
                };
            }
        }

        const lastMessages = leadId
            ? await Message.find({ lead: leadId })
                .sort({ timestamp: -1 })
                .limit(5)
                .lean()
                .then((msgs) => msgs.reverse().map((m) => m.content || ""))
            : [];

        const enrichedContext = {
            ...context,
            lastMessages,
            isFirstContact: lastMessages.length <= 1,
        };

        const reply = await generateAmandaReply({
            userText,
            lead: leadData,
            context: enrichedContext,
        });

        console.log(
            `✅ Resposta gerada: "${reply ? reply.substring(0, 80) : ""}..."`
        );

        return res.json({
            success: true,
            reply,
            meta: {
                leadName: leadData.name,
                hasHistory: lastMessages.length > 0,
                usedAPI: true,
            },
        });
    } catch (err) {
        console.error("❌ Erro ao gerar resposta:", err);

        let firstName = "tudo bem";
        try {
            if (req.body.leadId) {
                const lead = await Lead.findById(req.body.leadId).lean();
                if (lead?.name) {
                    firstName = lead.name.split(" ")[0];
                }
            }
        } catch {
            // ignora
        }

        return sendApiError(
          res,
          new AppError('INTERNAL_ERROR', "Erro ao gerar resposta", {
            status: 500,
            extra: { fallback: `Oi ${firstName}! Deixa eu te passar para nossa equipe. Aguarde um momento! 💚` },
          }),
          req
        );
    }
});

/**
 * 📤 POST /api/amanda/send
 * Cria follow-up e enfileira na BullMQ
 */
router.post("/send", async (req, res) => {
    try {
        const {
            leadId,
            message,
            scheduledAt,
            reason,
            campaign,
            therapist,
            aiOptimized = false,
        } = req.body;

        if (!leadId || !message) {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', "Campos obrigatórios: leadId, message", {
                status: 400,
              }),
              req
            );
        }

        const lead = await Lead.findById(leadId);
        if (!lead) {
            return res
                .status(404)
                .json({ success: false, message: "Lead não encontrado" });
        }

        const followup = await Followup.create({
            lead: leadId,
            message,
            scheduledAt: scheduledAt || new Date(),
            status: "scheduled",
            aiOptimized,
            origin: lead.origin,
            note: campaign ? `Campanha: ${campaign}` : undefined,
            ...(reason && { reason }),
            ...(therapist && { therapist }),
        });

        console.log(`✅ Follow-up criado: ${followup._id}`);

        const delayMs = new Date(followup.scheduledAt).getTime() - Date.now();

        await followupQueue.add(
            "followup",
            { followupId: followup._id },
            {
                jobId: `fu-${followup._id}`,
                ...(delayMs > 0 ? { delay: delayMs } : {}),
            }
        );

        return res.json({
            success: true,
            data: followup,
            message: "Follow-up agendado com sucesso",
        });
    } catch (err) {
        console.error("❌ Erro ao agendar follow-up:", err);
        return sendApiError(res, err, req);
    }
});

/**
 * 🧪 POST /api/amanda/test
 * Testa se a API Anthropic está configurada
 */
router.post("/test", async (req, res) => {
    try {
        const testLead = {
            name: "Teste Silva",
            reason: "avaliação",
            origin: "Teste",
        };

        const message = await generateFollowupMessage(testLead);

        return res.json({
            success: true,
            message: "API Anthropic funcionando!",
            sample: message,
            apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
            apiKeyPreview: process.env.ANTHROPIC_API_KEY
                ? `${process.env.ANTHROPIC_API_KEY.substring(0, 20)}...`
                : null,
        });
    } catch (err) {
        console.error("❌ Teste falhou:", err);

        return sendApiError(
          res,
          new AppError('INTERNAL_ERROR', "API Anthropic não está funcionando", {
            status: 500,
            legacyError: err.message,
            extra: { apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY },
          }),
          req
        );
    }
});

/**
 * 📊 GET /api/amanda/status
 * Status do sistema Amanda
 */
router.get("/status", async (req, res) => {
    try {
        const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
        const hasGroqKey = !!process.env.GROQ_API_KEY;

        const stats = await Followup.aggregate([
            {
                $group: {
                    _id: "$note",
                    count: { $sum: 1 },
                },
            },
        ]);

        const amandaStats = {
            "Amanda 2.0": stats.find((s) => s._id?.includes("2.0"))?.count || 0,
            "Amanda 1.0": stats.find((s) => s._id?.includes("1.0"))?.count || 0,
            Outros:
                stats
                    .filter((s) => !s._id?.includes("Amanda"))
                    .reduce((sum, s) => sum + s.count, 0) || 0,
        };

        return res.json({
            success: true,
            status: "operational",
            api: {
                // 🆕 Groq como primário
                groq: hasGroqKey ? "configured" : "not_configured",
                groqModel: "llama-3.1-8b-instant",
                groqTier: "free (6K req/dia)",
                // Claude como fallback
                anthropic: hasAnthropicKey ? "configured" : "not_configured",
                anthropicRole: "fallback",
                // Provider ativo
                primaryProvider: hasGroqKey ? "groq" : (hasAnthropicKey ? "anthropic" : "none"),
            },
            stats: amandaStats,
            features: {
                amanda2: true,
                amanda1_api: hasGroqKey || hasAnthropicKey,
                contextAnalysis: true,
                errorTolerance: true,
                freeAI: hasGroqKey, // 🆕 indica se tá usando IA grátis
            },
        });
    } catch (err) {
        console.error("❌ Erro ao consultar status Amanda:", err);
        return sendApiError(res, err, req);
    }
});

export default router;
