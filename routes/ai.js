// backend/routes/aiRoutes.js - NOVO ARQUIVO
import express from "express";
import { generateFollowupMessage } from "../services/aiAmandaService.js";
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = express.Router();

/**
 * POST /api/ai/generate-followup
 * Compatível com SEU frontend
 */
router.post("/generate-followup", async (req, res) => {
    try {
        const { leadId, context, tone, stage } = req.body;

        // Buscar lead do banco
        const Lead = await import('../models/Leads.js').then(m => m.default);
        const lead = await Lead.findById(leadId);

        if (!lead) {
            return sendApiError(res, new AppError('NOT_FOUND', "Lead não encontrado", { status: 404 }), req);
        }

        // Enriquecer dados do lead
        const enrichedLead = {
            ...lead.toObject(),
            reason: context || lead.reason,
            campaign: stage
        };

        // Gerar mensagem com Amanda
        const message = await generateFollowupMessage(enrichedLead);

        res.json({
            success: true,
            data: {
                message,
                confidence: 0.85,
                suggestions: [
                    "Oferecer horário alternativo",
                    "Reforçar benefícios da clínica"
                ],
                metadata: {
                    tone: tone || 'friendly',
                    length: message.length,
                    keywords: ['agendamento', 'disponibilidade']
                }
            }
        });
    } catch (error) {
        console.error("❌ Erro em /ai/generate-followup:", error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', "Erro ao gerar follow-up", {
            status: 500,
            details: error.message,
          }),
          req
        );
    }
});

/**
 * POST /api/ai/analyze-conversation
 */
router.post("/analyze-conversation", async (req, res) => {
    try {
        const { leadId, conversationHistory } = req.body;

        res.json({
            success: true,
            data: {
                sentiment: 'neutral',
                intent: 'information_seeking',
                recommendedAction: 'Responder dúvidas e oferecer agendamento',
                confidence: 0.75,
                insights: [
                    'Lead está na fase de descoberta',
                    'Demonstrou interesse em valores',
                    'Ainda não houve objeções'
                ]
            }
        });
    } catch (error) {
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', "Erro ao analisar conversa", {
            status: 500,
            details: error.message,
          }),
          req
        );
    }
});

export default router;