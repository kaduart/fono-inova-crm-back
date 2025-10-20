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
    const entry = payload.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    const status = entry?.statuses?.[0];
    console.log(`💬 Mensagem recebida de ${msg.from}: ${msg.text?.body}`);

    if (msg) {
        const from = msg.from;
        const text =
            msg.text?.body || msg.interactive?.button_reply?.title || null;

        const lead = await Lead.findOne({
            "contact.phone": { $regex: from.slice(-11) },
        });
        const leadId = lead?._id;

        await Message.create({
            from,
            to: PHONE_ID,
            direction: "inbound",
            type: msg.type,
            content: text,
            status: "received",
            timestamp: new Date(parseInt(msg.timestamp) * 1000),
            lead: leadId,
        });

        if (leadId) await updateChatContext(leadId, "inbound", text);

        // vincular ao último follow-up
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

    if (status) {
        await Message.updateOne(
            { waMessageId: status.id },
            { $set: { status: status.status } }
        );
    }
}
