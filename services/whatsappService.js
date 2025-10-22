// =======================================================
// ✅ WhatsApp Service (Cloud API v21) — Fono Inova 💚
// =======================================================
import dotenv from "dotenv";
import fetch from "node-fetch";
import ChatContext from "../models/ChatContext.js";
import Followup from "../models/Followup.js";
import Lead from "../models/Leads.js";
import Message from "../models/Message.js";

dotenv.config();

// -------------------------------------------------------
// 🔧 Utilitários
// -------------------------------------------------------
function normalizePhone(phone) {
    return phone.replace(/\D/g, "").replace(/^55?/, "55");
}

async function updateChatContext(leadId, direction, text) {
    if (!leadId || !text) return;
    const now = new Date();

    const ctx = await ChatContext.findOneAndUpdate(
        { lead: leadId },
        {
            $push: { messages: { direction, text, ts: now } },
            $set: { lastUpdatedAt: now },
        },
        { upsert: true, new: true }
    );

    if (ctx.messages.length > 10) {
        ctx.messages = ctx.messages.slice(-10);
        await ctx.save();
    }
}

// -------------------------------------------------------
// 🔐 Token de acesso e configuração
// -------------------------------------------------------
const META_URL = "https://graph.facebook.com/v21.0";
const WABA_TOKEN = process.env.META_WABA_TOKEN;
const PHONE_ID = process.env.META_WABA_PHONE_ID;

// -------------------------------------------------------
// ✉️ Enviar template com parâmetros dinâmicos
// -------------------------------------------------------
export async function sendTemplateMessage({ to, template, params = [], lead }) {
    const phone = normalizePhone(to);
    const url = `${META_URL}/${PHONE_ID}/messages`;

    const body = {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
            name: template,
            language: { code: "pt_BR" },
            components: [
                {
                    type: "body",
                    parameters: params.map((p) => ({ type: "text", text: p })),
                },
            ],
        },
    };

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${WABA_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    const data = await res.json();

    await Message.create({
        to: phone,
        from: PHONE_ID,
        direction: "outbound",
        type: "template",
        content: JSON.stringify(params),
        templateName: template,
        status: res.ok ? "sent" : "failed",
        lead,
    });

    if (lead) {
        await updateChatContext(lead, "outbound", `[TEMPLATE] ${params.join(" ")}`);
    }

    if (!res.ok) {
        console.error("❌ Erro WhatsApp:", data.error);
        throw new Error(data.error?.message || "Erro ao enviar template WhatsApp");
    }

    console.log(`✅ Template '${template}' enviado para ${phone}`);
    return data;
}


// services/whatsappMedia.js
const GRAPH_BASE = "https://graph.facebook.com/v21.0";

// Usa fetch nativo (você já importa 'node-fetch' no projeto em outros pontos, se precisar)
export async function resolveMediaUrl(mediaId) {
    const token =
        process.env.WHATSAPP_ACCESS_TOKEN ||
        process.env.META_WABA_TOKEN ||
        process.env.SHORT_TOKEN;

    if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN ausente");

    const url = `${GRAPH_BASE}/${mediaId}?fields=id,mime_type,sha256,file_size,url`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Graph media GET falhou (${res.status}): ${t}`);
    }

    const data = await res.json();
    if (!data?.url) throw new Error(`Graph não retornou url (mediaId=${mediaId})`);

    return { url: data.url, mimeType: data.mime_type || "application/octet-stream" };
}

// -------------------------------------------------------
// 💬 Enviar mensagem de texto padrão
// -------------------------------------------------------
export async function sendTextMessage({ to, text, lead }) {
    const phone = normalizePhone(to);
    const url = `${META_URL}/${PHONE_ID}/messages`;

    const body = {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: text },
    };

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${WABA_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    const data = await res.json();

    await Message.create({
        to: phone,
        from: PHONE_ID,
        direction: "outbound",
        type: "text",
        content: text,
        status: res.ok ? "sent" : "failed",
        lead,
    });

    if (lead) await updateChatContext(lead, "outbound", text);

    if (!res.ok) {
        console.error("❌ Erro WhatsApp:", data.error);
        throw new Error(data.error?.message || "Erro ao enviar mensagem WhatsApp");
    }

    console.log(`💚 Mensagem enviada para ${phone}: ${text}`);
    return data;
}

// -------------------------------------------------------
// 📩 Webhook de recebimento
// -------------------------------------------------------
export async function handleWebhookEvent(payload) {
    async function resolveMediaUrl(mediaId) {
        const token =
            process.env.WHATSAPP_ACCESS_TOKEN ||
            process.env.META_WABA_TOKEN ||
            process.env.SHORT_TOKEN;

        if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN ausente");

        const url = `https://graph.facebook.com/v21.0/${mediaId}?fields=id,mime_type,sha256,file_size,url`;
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
            const t = await res.text().catch(() => "");
            throw new Error(`Graph media GET falhou (${res.status}): ${t}`);
        }

        const data = await res.json();
        if (!data?.url) throw new Error(`Graph não retornou url (mediaId=${mediaId})`);

        return { url: data.url, mimeType: data.mime_type || "application/octet-stream" };
    }

    const entry = payload.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    const status = entry?.statuses?.[0];

    if (msg) {
        console.log(
            `💬 Mensagem recebida de ${msg.from}: ${msg.text?.body || `[${(msg.type || '').toUpperCase()}]`}`
        );
    }

    if (msg) {
        const from = msg.from;
        const type = msg.type; // 'text' | 'audio' | 'image' | 'video' | 'document'

        // Texto “puro” (se houver)
        const plainText = msg.text?.body || msg.interactive?.button_reply?.title || null;

        // Campos de mídia
        let mediaUrl = null;
        let caption = null;

        // Resolve URL quando houver mídia
        try {
            if (type === "audio" && msg.audio?.id) {
                caption = "[AUDIO]";
                const { url } = await resolveMediaUrl(msg.audio.id);
                mediaUrl = url;
            } else if (type === "image" && msg.image?.id) {
                caption = msg.image.caption || "[IMAGE]";
                const { url } = await resolveMediaUrl(msg.image.id);
                mediaUrl = url;
            } else if (type === "video" && msg.video?.id) {
                caption = msg.video.caption || "[VIDEO]";
                const { url } = await resolveMediaUrl(msg.video.id);
                mediaUrl = url;
            } else if (type === "document" && msg.document?.id) {
                caption = msg.document.filename || "[DOCUMENT]";
                const { url } = await resolveMediaUrl(msg.document.id);
                mediaUrl = url;
            }
        } catch (err) {
            console.error("⚠️ Falha ao resolver URL da mídia:", err.message);
        }

        // Localiza lead (mantendo sua lógica atual)
        const lead = await Lead.findOne({
            "contact.phone": { $regex: from.slice(-11) },
        });
        const leadId = lead?._id;

        // Define conteúdo salvo (texto puro ou legenda do anexo)
        const contentToSave =
            type === "text" ? (plainText || "") : (caption || `[${(type || '').toUpperCase()}]`);

        // Salva mensagem no histórico (agora com mediaUrl/caption)
        await Message.create({
            from,
            to: PHONE_ID,
            direction: "inbound",
            type,
            content: contentToSave,
            mediaUrl,           // <<<<<< salva a URL lookaside
            caption,            // <<<<<< salva a legenda/descrição
            status: "received",
            timestamp: new Date(parseInt(msg.timestamp) * 1000),
            lead: leadId,
        });

        // Atualiza contexto do chat
        if (leadId) {
            const summaryText = type === "text" ? (plainText || "") : (caption || contentToSave);
            if (summaryText) {
                await updateChatContext(leadId, "inbound", summaryText);
            }
        }

        // Vincula ao último follow-up pendente (sua lógica original)
        if (leadId) {
            const followup = await Followup.findOne({
                lead: leadId,
                responded: false,
                status: { $in: ["sent", "processing"] },
            }).sort({ sentAt: -1 });

            if (followup) {
                followup.responded = true;
                followup.status = "responded";
                followup.respondedAt = new Date(
                    parseInt(msg.timestamp) * 1000 || Date.now()
                );
                await followup.save();
            }
        }
    }

    // Atualiza status de mensagens enviadas (sua lógica original)
    if (status) {
        await Message.updateOne(
            { waMessageId: status.id },
            { $set: { status: status.status } }
        );
    }
}

