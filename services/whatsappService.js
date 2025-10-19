// services/whatsappService.js
import fetch from "node-fetch";
import ChatContext from "../models/ChatContext.js";
import Followup from "../models/Followup.js";
import Lead from "../models/Leads.js";
import Message from "../models/Message.js";
import { getAccessToken } from "./tokenService.js";

function normalizePhone(phone) {
    return phone.replace(/\D/g, "").replace(/^55?/, "55");
}

/** 🟢 Atualiza contexto de chat (para Amanda) */
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

    // Mantém histórico curto (últimas 10 mensagens)
    if (ctx.messages.length > 10) {
        ctx.messages = ctx.messages.slice(-10);
        await ctx.save();
    }
}

/** ✉️ Envia mensagem de template */
export async function sendTemplateMessage({ to, template, params, lead }) {
    const phone = normalizePhone(to);
    const accessToken = await getAccessToken();

    const body = {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
            name: template,
            language: { code: "pt_BR" },
            components: [{ type: "body", parameters: params }],
        },
    };

    const res = await fetch(
        `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        }
    );

    const data = await res.json();
    await Message.create({
        to: phone,
        from: process.env.PHONE_NUMBER_ID,
        direction: "outbound",
        type: "template",
        content: JSON.stringify(params),
        templateName: template,
        status: res.ok ? "sent" : "failed",
        lead,
    });

    if (lead) await updateChatContext(lead, "outbound", `[TEMPLATE] ${params.map(p => p.text).join(" ")}`);

    if (!res.ok) throw new Error(data.error?.message || "Erro ao enviar mensagem WhatsApp");
    return data;
}

/** 💬 Envia mensagem de texto padrão */
export async function sendTextMessage({ to, text, lead }) {
    const phone = normalizePhone(to);
    const accessToken = await getAccessToken();

    const res = await fetch(
        `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to: phone,
                text: { body: text },
            }),
        }
    );

    const data = await res.json();
    await Message.create({
        to: phone,
        from: process.env.PHONE_NUMBER_ID,
        direction: "outbound",
        type: "text",
        content: text,
        status: res.ok ? "sent" : "failed",
        lead,
    });

    if (lead) await updateChatContext(lead, "outbound", text);

    if (!res.ok) throw new Error(data.error?.message || "Erro ao enviar texto WhatsApp");
    return data;
}

/** 📩 Trata eventos de webhook (mensagens recebidas ou status) */
export async function handleWebhookEvent(payload) {
    const entry = payload.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    const status = entry?.statuses?.[0];

    if (msg) {
        const from = msg.from;
        const text = msg.text?.body || msg.interactive?.button_reply?.title || null;

        const lead = await Lead.findOne({ "contact.phone": { $regex: from.slice(-11) } });
        const leadId = lead?._id;

        await Message.create({
            from,
            to: process.env.PHONE_NUMBER_ID,
            direction: "inbound",
            type: msg.type,
            content: text,
            status: "received",
            timestamp: new Date(parseInt(msg.timestamp) * 1000),
            lead: leadId,
        });

        if (leadId) await updateChatContext(leadId, "inbound", text);

        // Vincula resposta ao último follow-up
        if (leadId) {
            const followup = await Followup.findOne({
                lead: leadId,
                responded: false,
                status: { $in: ["sent", "processing"] },
            }).sort({ sentAt: -1 });

            if (followup) {
                followup.responded = true;
                followup.status = "responded";
                followup.respondedAt = new Date(parseInt(msg.timestamp) * 1000 || Date.now());
                await followup.save();
            }
        }
    }

    if (status) {
        await Message.updateOne(
            { waMessageId: status.id },
            { $set: { status: status.status } }
        );
    }
}
