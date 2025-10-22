// services/whatsappService.js
import dotenv from "dotenv";
import fetch from "node-fetch";
import ChatContext from "../models/ChatContext.js";
import Message from "../models/Message.js";
import { getMetaToken } from "../utils/metaToken.js";

dotenv.config();

const META_URL = "https://graph.facebook.com/v21.0";
const PHONE_ID = process.env.META_WABA_PHONE_ID;

function requireToken() {
    const token = getMetaToken();
    if (!token) throw new Error("Token Meta/WhatsApp ausente.");
    return token;
}

function normalizePhone(phone) {
    return phone.replace(/\D/g, "").replace(/^55?/, "55");
}

async function updateChatContext(leadId, direction, text) {
    if (!leadId || !text) return;
    const now = new Date();
    const ctx = await ChatContext.findOneAndUpdate(
        { lead: leadId },
        { $push: { messages: { direction, text, ts: now } }, $set: { lastUpdatedAt: now } },
        { upsert: true, new: true }
    );
    if (ctx.messages.length > 10) {
        ctx.messages = ctx.messages.slice(-10);
        await ctx.save();
    }
}

/** 🔎 Resolve a URL lookaside a partir de um mediaId do WhatsApp */
export async function resolveMediaUrl(mediaId) {
    const token = requireToken();

    const url = `${META_URL}/${mediaId}?fields=id,mime_type,sha256,file_size,url`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Graph media GET falhou (${res.status}): ${t}`);
    }

    const data = await res.json();
    if (!data?.url) throw new Error(`Graph não retornou url (mediaId=${mediaId})`);

    return {
        url: data.url,
        mimeType: data.mime_type || "application/octet-stream",
        fileSize: data.file_size ?? null,
    };
}

/** ✉️ Envia template */
export async function sendTemplateMessage({ to, template, params = [], lead }) {
    const token = requireToken();
    if (!PHONE_ID) throw new Error("META_WABA_PHONE_ID ausente.");

    const phone = normalizePhone(to);
    const url = `${META_URL}/${PHONE_ID}/messages`;

    const body = {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
            name: template,
            language: { code: "pt_BR" },
            components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }],
        },
    };

    const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();

    const waMessageId = data?.messages?.[0]?.id || null;

    await Message.create({
        to: phone,
        from: PHONE_ID,
        direction: "outbound",
        type: "template",
        content: JSON.stringify(params),
        templateName: template,
        status: res.ok ? "sent" : "failed",
        waMessageId,
        timestamp: new Date(),
        lead,
    });

    if (lead) await updateChatContext(lead, "outbound", `[TEMPLATE] ${params.join(" ")}`);

    if (!res.ok) {
        console.error("❌ Erro WhatsApp:", data.error);
        throw new Error(data.error?.message || "Erro ao enviar template WhatsApp");
    }

    return data;
}

/** 💬 Envia texto */
export async function sendTextMessage({ to, text, lead }) {
    const token = requireToken();
    if (!PHONE_ID) throw new Error("META_WABA_PHONE_ID ausente.");

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
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();

    const waMessageId = data?.messages?.[0]?.id || null;

    await Message.create({
        to: phone,
        from: PHONE_ID,
        direction: "outbound",
        type: "text",
        content: text,
        status: res.ok ? "sent" : "failed",
        waMessageId,
        timestamp: new Date(),
        lead,
    });

    if (lead) await updateChatContext(lead, "outbound", text);

    if (!res.ok) {
        console.error("❌ Erro WhatsApp:", data.error);
        throw new Error(data.error?.message || "Erro ao enviar mensagem WhatsApp");
    }

    return data;
}
