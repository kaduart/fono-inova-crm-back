// services/intelligence/contextMemory.js

import OpenAI from 'openai';
import ChatContext from '../../models/ChatContext.js';
import Message from '../../models/Message.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * 📝 Resume conversa longa
 */
export async function summarizeConversation({ leadId }) {
    const messages = await Message.find({ lead: leadId })
        .sort({ timestamp: 1 })
        .limit(20)
        .lean();

    if (messages.length < 3) {
        return "Conversa inicial sem histórico suficiente.";
    }

    const conversation = messages.map(m =>
        `${m.direction === 'inbound' ? 'Cliente' : 'Amanda'}: ${m.content}`
    ).join('\n');

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.3,
            max_tokens: 150,
            messages: [{
                role: "system",
                content: "Resuma esta conversa em 2-3 frases: queixa principal, especialidade, objeções, status."
            }, {
                role: "user",
                content: conversation
            }]
        });

        const summary = response.choices[0]?.message?.content?.trim() || "";

        await ChatContext.findOneAndUpdate(
            { lead: leadId },
            { lastSummary: summary, lastUpdatedAt: new Date() },
            { upsert: true }
        );

        return summary;
    } catch (error) {
        console.error("❌ Erro ao resumir:", error);
        return "Erro ao gerar resumo.";
    }
}

/**
 * 🔍 Detecta padrões de comportamento
 */
export async function detectBehaviorPatterns({ leadId }) {
    const messages = await Message.find({ lead: leadId })
        .sort({ timestamp: 1 })
        .lean();

    if (messages.length < 2) return null;

    const patterns = {
        avgResponseTime: 0,
        engagementLevel: 'low',
        asksPriceMultipleTimes: false,
        showsUrgency: false
    };

    const inbound = messages.filter(m => m.direction === 'inbound');
    let totalTime = 0;
    let count = 0;

    for (let i = 1; i < inbound.length; i++) {
        const diff = new Date(inbound[i].timestamp) - new Date(inbound[i - 1].timestamp);
        if (diff < 24 * 60 * 60 * 1000) {
            totalTime += diff;
            count++;
        }
    }

    if (count > 0) {
        patterns.avgResponseTime = Math.round(totalTime / count / 1000 / 60);
    }

    if (messages.length > 10) patterns.engagementLevel = 'high';
    else if (messages.length > 5) patterns.engagementLevel = 'medium';

    patterns.asksPriceMultipleTimes = messages.filter(m =>
        m.direction === 'inbound' && /\b(pre[cç]o|valor)/i.test(m.content)
    ).length > 1;

    patterns.showsUrgency = messages.some(m =>
        m.direction === 'inbound' && /\b(urgente|r[aá]pido)/i.test(m.content)
    );

    return patterns;
}

/**
 * 🔄 SALVA INFORMAÇÕES EXTRAÍDAS NO CONTEXTO
 */
export async function update(leadId, extractedInfo) {
    if (!extractedInfo || Object.keys(extractedInfo).length === 0) return null;

    try {
        const updateData = {
            lastExtractedInfo: extractedInfo,
            lastUpdatedAt: new Date()
        };

        console.log('[ContextMemory] Salvando extractedInfo:', {
            leadId: leadId?.toString?.() || leadId,
            extractedInfo,
            awaitingComplaint: extractedInfo?.awaitingComplaint,
            awaitingAge: extractedInfo?.awaitingAge
        });

        const result = await ChatContext.findOneAndUpdate(
            { lead: leadId },
            { $set: updateData },
            { upsert: true, new: true }
        );

        console.log('[ContextMemory] Salvo com sucesso:', {
            leadId: leadId?.toString?.() || leadId,
            resultId: result?._id?.toString?.()
        });

        return true;
    } catch (error) {
        console.error("❌ [ContextMemory] Erro ao atualizar:", error);
        return null;
    }
}