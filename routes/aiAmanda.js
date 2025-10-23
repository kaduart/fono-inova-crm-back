// routes/aiAmanda.routes.js
import dotenv from "dotenv";
import express from "express";
import Followup from "../models/Followup.js";
import Lead from "../models/Leads.js";
import { generateAmandaReply, generateFollowupMessage } from "../services/aiAmandaService.js";

dotenv.config();

const router = express.Router();

/**
 * Gera um rascunho de follow-up curto (mantém seu comportamento atual)
 * body: { leadId, reason?, campaign? }
 */
router.post("/draft", async (req, res) => {
    try {
        const { leadId, reason, campaign } = req.body;
        const lead = await Lead.findById(leadId);
        if (!lead) return res.status(404).json({ success: false, message: "Lead não encontrado" });

        const text = await generateFollowupMessage({ ...lead.toObject(), reason });
        return res.json({ success: true, draft: text, meta: { reason, campaign } });
    } catch (err) {
        console.error("❌ /ai/draft error:", err);
        return res.status(500).json({ success: false, message: "Erro ao gerar rascunho" });
    }
});

/**
 * Gera uma resposta conversacional da Amanda para qualquer texto
 * body: { leadId?, userText, context? }
 * - Se leadId vier, usamos nome/motivo/origem; caso contrário, usa defaults
 */
router.post("/reply", async (req, res) => {
    try {
        const { leadId, userText, context } = req.body;

        let leadData = {};
        if (leadId) {
            const lead = await Lead.findById(leadId).lean();
            if (lead) {
                leadData = {
                    name: lead.name,
                    reason: lead.reason,
                    origin: lead.origin || "WhatsApp",
                    lastInteraction: lead.updatedAt || lead.createdAt,
                };
            }
        }

        const reply = await generateAmandaReply({
            userText,
            lead: leadData,
            context: context || {},
        });

        return res.json({ success: true, reply });
    } catch (err) {
        console.error("❌ /ai/reply error:", err);
        return res.status(500).json({ success: false, message: "Erro ao gerar resposta" });
    }
});

/**
 * Confirma um follow-up e enfileira (mantém sua rota)
 * body: { leadId, message, reason?, campaign?, therapist? }
 */
router.post("/send", async (req, res) => {
    try {
        const { leadId, message, reason, campaign, therapist } = req.body;

        const followup = await Followup.create({
            lead: leadId,
            message,
            scheduledAt: new Date(),
            status: "scheduled",
            reason,
            campaign,
            therapist,
        });

        // aqui você pode colocar na fila imediatamente se tiver queue/worker
        return res.json({ success: true, data: followup });
    } catch (err) {
        console.error("❌ /ai/send error:", err);
        return res.status(500).json({ success: false, message: "Erro ao agendar follow-up" });
    }
});

export default router;
