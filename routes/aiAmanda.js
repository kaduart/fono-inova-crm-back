// routes/aiAmanda.js - VERSÃO COMPLETA AMANDA 2.0
import express from "express";
import Followup from "../models/Followup.js";
import Lead from "../models/Leads.js";
import Message from "../models/Message.js";

// ✅ AMANDA 2.0 (Intelligence Services)
import { analyzeLeadMessage } from "../services/intelligence/leadIntelligence.js";
import { generateContextualFollowup } from "../services/intelligence/smartFollowup.js";

// ✅ AMANDA 1.0 MELHORADA (API Anthropic)
import { generateAmandaReply, generateFollowupMessage } from "../services/aiAmandaService.js";

const router = express.Router();

/**
 * 🎯 ROTA: POST /api/amanda/draft
 * Gera rascunho de follow-up inteligente
 * 
 * Prioridade:
 * 1. Amanda 2.0 (se tiver histórico de mensagens)
 * 2. Amanda 1.0 com API (usa ANTHROPIC_API_KEY)
 * 3. Fallback gratuito (templates)
 */
router.post("/draft", async (req, res) => {
    try {
        const { leadId, reason, campaign } = req.body;

        if (!leadId) {
            return res.status(400).json({
                success: false,
                message: "leadId é obrigatório"
            });
        }

        const lead = await Lead.findById(leadId);
        if (!lead) {
            return res.status(404).json({
                success: false,
                message: "Lead não encontrado"
            });
        }

        console.log(`🤖 Gerando draft para lead: ${lead.name} (${leadId})`);

        // ═══════════════════════════════════════════════════
        // 1️⃣ TENTAR AMANDA 2.0 (Análise completa + contexto)
        // ═══════════════════════════════════════════════════
        try {
            // Buscar histórico de mensagens
            const recentMessages = await Message.find({
                lead: leadId
            })
                .sort({ timestamp: -1 })
                .limit(10)
                .lean();

            const lastInbound = recentMessages.find(m => m.direction === 'inbound');

            if (lastInbound?.content) {
                console.log('🧠 Usando Amanda 2.0 (com histórico)');

                // Análise inteligente
                const analysis = await analyzeLeadMessage({
                    text: lastInbound.content,
                    lead,
                    history: recentMessages.map(m => m.content || '')
                });

                // Gerar mensagem contextualizada
                const draft = generateContextualFollowup({
                    lead,
                    analysis,
                    attempt: 1
                });

                console.log(`✅ Amanda 2.0: Score ${analysis.score} | Draft gerado`);

                return res.json({
                    success: true,
                    draft,
                    version: '2.0',
                    score: analysis.score,
                    segment: analysis.segment,
                    intent: analysis.intent,
                    meta: {
                        reason,
                        campaign,
                        hasHistory: true,
                        messagesAnalyzed: recentMessages.length
                    }
                });
            }
        } catch (ai2Error) {
            console.warn('⚠️ Amanda 2.0 indisponível:', ai2Error.message);
        }

        // ═══════════════════════════════════════════════════
        // 2️⃣ USAR AMANDA 1.0 MELHORADA (API Anthropic)
        // Usa ANTHROPIC_API_KEY do .env
        // ═══════════════════════════════════════════════════
        console.log('🤖 Usando Amanda 1.0 (API Anthropic)');

        const enrichedLead = {
            ...lead.toObject(),
            reason: reason || lead.reason,
            campaign
        };

        const draft = await generateFollowupMessage(enrichedLead);

        console.log(`✅ Amanda 1.0: Draft gerado via API`);

        return res.json({
            success: true,
            draft,
            version: '1.0',
            meta: {
                reason,
                campaign,
                hasHistory: false,
                usedAPI: true
            }
        });

    } catch (err) {
        console.error("❌ Erro ao gerar draft:", err);

        // Fallback final (template simples)
        const firstName = req.body.leadId ?
            (await Lead.findById(req.body.leadId))?.name?.split(' ')[0] :
            'Cliente';

        return res.status(500).json({
            success: false,
            message: "Erro ao gerar rascunho",
            fallback: `Oi ${firstName}! Como posso te ajudar? 💚`
        });
    }
});

/**
 * 💬 ROTA: POST /api/amanda/reply
 * Gera resposta para mensagem do lead
 * 
 * Usa API Anthropic (ANTHROPIC_API_KEY)
 * Tolera erros de digitação
 * Resposta natural e empática
 */
router.post("/reply", async (req, res) => {
    try {
        const { leadId, userText, context = {} } = req.body;

        if (!userText || !userText.trim()) {
            return res.status(400).json({
                success: false,
                message: "userText é obrigatório"
            });
        }

        console.log(`💬 Gerando resposta para: "${userText}"`);

        // Buscar dados do lead
        let leadData = {
            name: "Cliente",
            reason: "atendimento",
            origin: "WhatsApp"
        };

        if (leadId) {
            const lead = await Lead.findById(leadId).lean();
            if (lead) {
                leadData = {
                    name: lead.name,
                    reason: lead.reason || lead.appointment?.seekingFor || "atendimento",
                    origin: lead.origin || "WhatsApp",
                    lastInteraction: lead.updatedAt || lead.createdAt,
                };
            }
        }

        // Buscar histórico de mensagens
        const lastMessages = leadId ?
            await Message.find({ lead: leadId })
                .sort({ timestamp: -1 })
                .limit(5)
                .lean()
                .then(msgs => msgs.reverse().map(m => m.content || '')) :
            [];

        // Enriquecer contexto
        const enrichedContext = {
            ...context,
            lastMessages,
            isFirstContact: lastMessages.length <= 1
        };

        // ═══════════════════════════════════════════════════
        // 🌐 CHAMAR API ANTHROPIC (usa ANTHROPIC_API_KEY)
        // ═══════════════════════════════════════════════════
        const reply = await generateAmandaReply({
            userText,
            lead: leadData,
            context: enrichedContext,
        });

        console.log(`✅ Resposta gerada: "${reply.substring(0, 50)}..."`);

        return res.json({
            success: true,
            reply,
            meta: {
                leadName: leadData.name,
                hasHistory: lastMessages.length > 0,
                usedAPI: true
            }
        });

    } catch (err) {
        console.error("❌ Erro ao gerar resposta:", err);

        // Fallback simples
        const firstName = req.body.leadId ?
            (await Lead.findById(req.body.leadId))?.name?.split(' ')[0] :
            'tudo bem';

        return res.status(500).json({
            success: false,
            message: "Erro ao gerar resposta",
            fallback: `Oi ${firstName}! Deixa eu te passar para nossa equipe. Aguarde um momento! 💚`
        });
    }
});

/**
 * 📤 ROTA: POST /api/amanda/send
 * Confirma e enfileira follow-up
 * 
 * Cria follow-up no banco
 * Adiciona na fila BullMQ
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
            aiOptimized = false
        } = req.body;

        if (!leadId || !message) {
            return res.status(400).json({
                success: false,
                message: "Campos obrigatórios: leadId, message"
            });
        }

        // Verificar se lead existe
        const lead = await Lead.findById(leadId);
        if (!lead) {
            return res.status(404).json({
                success: false,
                message: "Lead não encontrado"
            });
        }

        // Criar follow-up
        const followup = await Followup.create({
            lead: leadId,
            message,
            scheduledAt: scheduledAt || new Date(),
            status: "scheduled",
            aiOptimized,
            origin: lead.origin,
            note: campaign ? `Campanha: ${campaign}` : undefined,
            // Campos opcionais da rota antiga
            ...(reason && { reason }),
            ...(therapist && { therapist })
        });

        console.log(`✅ Follow-up criado: ${followup._id}`);

        return res.json({
            success: true,
            data: followup,
            message: 'Follow-up agendado com sucesso'
        });

    } catch (err) {
        console.error("❌ Erro ao agendar follow-up:", err);
        return res.status(500).json({
            success: false,
            message: "Erro ao agendar follow-up",
            error: err.message
        });
    }
});

/**
 * 🧪 ROTA: POST /api/amanda/test
 * Testa se API Anthropic está configurada
 */
router.post("/test", async (req, res) => {
    try {
        const testLead = {
            name: "Teste Silva",
            reason: "avaliação",
            origin: "Teste"
        };

        // Testar Amanda 1.0 (API)
        const message = await generateFollowupMessage(testLead);

        return res.json({
            success: true,
            message: "API Anthropic funcionando!",
            sample: message,
            apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
            apiKeyPreview: process.env.ANTHROPIC_API_KEY?.substring(0, 20) + '...'
        });

    } catch (err) {
        console.error("❌ Teste falhou:", err);
        return res.status(500).json({
            success: false,
            message: "API Anthropic não está funcionando",
            error: err.message,
            apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY
        });
    }
});

/**
 * 📊 ROTA: GET /api/amanda/status
 * Status do sistema Amanda
 */
router.get("/status", async (req, res) => {
    try {
        // Verificar configurações
        const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;

        // Contar follow-ups por versão
        const stats = await Followup.aggregate([
            {
                $group: {
                    _id: "$note",
                    count: { $sum: 1 }
                }
            }
        ]);

        const amandaStats = {
            'Amanda 2.0': stats.find(s => s._id?.includes('2.0'))?.count || 0,
            'Amanda 1.0': stats.find(s => s._id?.includes('1.0'))?.count || 0,
            'Outros': stats.filter(s => !s._id?.includes('Amanda')).reduce((sum, s) => sum + s.count, 0)
        };

        return res.json({
            success: true,
            status: "operational",
            api: {
                anthropic: hasAnthropicKey ? "configured" : "not_configured",
                keyPreview: hasAnthropicKey ?
                    process.env.ANTHROPIC_API_KEY.substring(0, 20) + '...' :
                    null
            },
            stats: amandaStats,
            features: {
                amanda2: true,
                amanda1_api: hasAnthropicKey,
                contextAnalysis: true,
                errorTolerance: true
            }
        });

    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

export default router;