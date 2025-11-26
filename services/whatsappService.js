// services/whatsappService.js
import dotenv from "dotenv";
import fetch from "node-fetch";
import ChatContext from "../models/ChatContext.js";
import Contact from "../models/Contact.js";
import Message from "../models/Message.js";
import { getMetaToken } from "../utils/metaToken.js";
import { normalizeE164BR } from "../utils/phone.js";

dotenv.config();

const META_URL = "https://graph.facebook.com/v21.0";
const PHONE_ID = process.env.META_WABA_PHONE_ID;

async function requireToken() {
    const token = await getMetaToken();
    if (!token) throw new Error("Token Meta/WhatsApp ausente.");
    return token;
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

/**
 * 🧱 Registro centralizado de mensagem (inbound/outbound)
 */
export async function registerMessage({
    leadId,
    contactId,
    patientId,
    direction,
    text,
    // extras opcionais (mantém compatibilidade com chamadas antigas)
    type = "text",
    status = null,
    waMessageId = null,
    timestamp = null,
    to = null,
    from = null,
    metadata = null,
}) {
    const now = timestamp || new Date();

    // 1) Salva mensagem no histórico
    const payload = {
        lead: leadId,
        contact: contactId,
        patient: patientId || null,
        direction,
        type,
        content: text,
        timestamp: now,
    };

    if (status) payload.status = status;

    // ✅ CORRIGIDO: Sempre salvar waMessageId quando existir
    if (waMessageId) {
        payload.waMessageId = waMessageId;
        console.log('💾 Salvando com waMessageId:', waMessageId);
    }

    if (to) payload.to = to;
    if (from) payload.from = from;
    if (metadata) payload.metadata = metadata;

    console.log('💾 Payload completo para salvar:', {
        ...payload,
        content: payload.content?.substring(0, 50) + '...'
    });

    const msg = await Message.create(payload);

    console.log('✅ Mensagem criada no banco:', {
        _id: msg._id,
        waMessageId: msg.waMessageId,
        lead: msg.lead,
        to: msg.to
    });

    // 2) Atualiza contexto de chat
    await updateChatContext(leadId, direction, text);

    // 3) Atualiza contato para ordenação da lista
    if (contactId) {
        try {
            await Contact.findByIdAndUpdate(
                contactId,
                {
                    lastMessageAt: now,
                    lastMessagePreview: text.slice(0, 120),
                    lastDirection: direction,
                },
                { new: true }
            );
        } catch (err) {
            console.error("⚠️ Erro ao atualizar lastMessageAt no contato:", err);
        }
    }

    return msg;
}

/** 🔎 Resolve a URL lookaside a partir de um mediaId do WhatsApp */
export async function resolveMediaUrl(mediaId) {
    const token = await requireToken();

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
    const token = await requireToken();
    if (!PHONE_ID) throw new Error("META_WABA_PHONE_ID ausente.");

    const phone = normalizeE164BR(to);
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
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    const data = await res.json();

    const waMessageId = data?.messages?.[0]?.id || null;

    // Se quiser manter contexto de conversa:
    if (lead) {
        await updateChatContext(lead, "outbound", `[TEMPLATE] ${params.join(" ")}`);
    }

    if (!res.ok) {
        console.error("❌ Erro WhatsApp:", data.error);
        throw new Error(data.error?.message || "Erro ao enviar template WhatsApp");
    }

    return data;
}

/** 💬 Envia texto */
export async function sendTextMessage({
    to,
    text,
    lead,
    // novos campos opcionais
    contactId = null,         // ← passa o contact._id quando tiver
    patientId = null,         // ← se estiver vinculado a um paciente
    sentBy = "amanda",   // default: Amanda respondeu sozinha
    userId = null,            // quando vier de usuário humano, passa o id aqui
}) {
    const token = await requireToken();
    if (!PHONE_ID) throw new Error("META_WABA_PHONE_ID ausente.");

    const phone = normalizeE164BR(to);
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
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    const data = await res.json();

    const waMessageId = data?.messages?.[0]?.id || null;
    const now = new Date();

    // 🔁 Usa SEMPRE o registro centralizado
    await registerMessage({
        leadId: lead,
        contactId,
        patientId,
        direction: "outbound",
        text,
        type: "text",
        status: res.ok ? "sent" : "failed",
        waMessageId,
        timestamp: now,
        to: phone,
        from: PHONE_ID,
        metadata: {
            sentBy,
            userId,
        },
    });

    if (!res.ok) {
        console.error("❌ Erro WhatsApp:", data.error);
        throw new Error(
            data.error?.message || "Erro ao enviar mensagem WhatsApp"
        );
    }

    return data;
}
