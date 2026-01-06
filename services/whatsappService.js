// services/whatsappService.js
import dotenv from "dotenv";
import fetch from "node-fetch";
import ChatContext from "../models/ChatContext.js";
import Contact from "../models/Contacts.js";
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
            $setOnInsert: { lead: leadId },
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


/** 📍 Envia localização (pin) */
export async function sendLocationMessage({
    to,
    latitude,
    longitude,
    name,
    address,
    url = null,
    lead,
    contactId = null,
    patientId = null,
    sentBy = "amanda",
    userId = null
}) {
    const token = await requireToken();
    if (!PHONE_ID) throw new Error("META_WABA_PHONE_ID ausente.");

    const phone = normalizeE164BR(to);
    const metaUrl = `${META_URL}/${PHONE_ID}/messages`;

    console.log("📍 Enviando localização via WhatsApp...");

    const body = {
        messaging_product: "whatsapp",
        to: phone,
        type: "location",
        location: {
            latitude,
            longitude,
            name,
            address
        }
    };

    const res = await fetch(metaUrl, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    const data = await res.json();
    const waMessageId = data?.messages?.[0]?.id || null;
    const now = new Date();

    await registerMessage({
        leadId: lead,
        contactId,
        patientId,
        direction: "outbound",
        text: `${name} - ${address}`,
        type: "location",
        status: res.ok ? "sent" : "failed",
        waMessageId,
        timestamp: now,
        to: phone,
        from: PHONE_ID,
        metadata: { sentBy, userId },
    });

    if (!res.ok) {
        console.error("❌ Erro WhatsApp (location):", data.error);
        throw new Error(data.error?.message || "Erro ao enviar localização WhatsApp");
    }

    console.log("✅ Localização enviada com sucesso:", { waMessageId, phone });
    return { ...data, waMessageId };
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

/**
 * 🧼 Formata texto para WhatsApp sem destruir parágrafos
 * - mode="preserve": mantém quebras de linha e parágrafos (default recomendado)
 * - mode="bullets": transforma linhas em lista com ▫️
 * - mode="auto": preserva parágrafos; só usa bullets se o texto já parece lista
 */
function formatWhatsAppText(text, { mode = "auto" } = {}) {
    const raw = (text ?? "").toString();

    // normaliza quebras
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Se o caller pediu preservar, faz só um trim suave
    if (mode === "preserve") {
        // remove espaços no fim de linha, mas mantém linhas vazias
        return normalized
            .split("\n")
            .map(line => line.replace(/\s+$/g, ""))
            .join("\n")
            .trim();
    }

    // Detecta se já é lista (linhas iniciando com -, •, ▫️, 1), 2), etc)
    const lines = normalized.split("\n");
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    const looksLikeList =
        nonEmpty.length >= 3 &&
        nonEmpty.every(l => /^\s*(?:[-•▫️]|\d+[\)\.]|\*)\s+/.test(l));

    // AUTO: por padrão preserva parágrafos; bullets só quando já parece lista
    if (mode === "auto" && !looksLikeList) {
        return formatWhatsAppText(normalized, { mode: "preserve" });
    }

    // BULLETS (ou auto + lista)
    const bulletLines = nonEmpty.map(l => l.trim().replace(/^\s*(?:[-•▫️]|\d+[\)\.]|\*)\s+/, ""));
    return bulletLines.map((l, idx) => (idx === 0 ? `▫️ ${l}` : `▫️ ${l}`)).join("\n").trim();
}

export async function sendTemplateMessage({
    to,
    template,
    params = [],
    lead = null,
    contactId = null,
    patientId = null,
    renderedText = null,
    sentBy = "amanda",
    userId = null
}) {
    const token = await requireToken();
    if (!PHONE_ID) throw new Error("META_WABA_PHONE_ID ausente.");

    const phone = normalizeE164BR(to);
    const url = `${META_URL}/${PHONE_ID}/messages`;

    // ✅ Aceita params como string OU como objeto {type,text}
    const safeParams = (params || []).map((p) => {
        if (typeof p === "string") return { type: "text", text: p };
        if (p && typeof p === "object" && p.type && typeof p.text === "string") return p;
        // fallback
        return { type: "text", text: String(p ?? "") };
    });

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
                    parameters: safeParams,
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
    const now = new Date();

    // Texto para salvar no CRM (não temos o conteúdo "real" do template, então salvamos um texto útil)
    const paramsText = safeParams.map(p => p.text).filter(Boolean).join(" ");
    const contentToSave =
        (renderedText && String(renderedText).trim()) ||
        (paramsText ? paramsText : `[TEMPLATE:${template}]`);

    // 🔁 Mantém contexto de conversa (ChatContext)
    if (lead) {
        await updateChatContext(lead, "outbound", contentToSave);
    }

    // 💾 Registra a mensagem no CRM (Message)
    if (lead) {
        await registerMessage({
            leadId: lead,
            contactId,
            patientId,
            direction: "outbound",
            text: contentToSave,
            type: "template",
            status: res.ok ? "sent" : "failed",
            waMessageId,
            timestamp: now,
            to: phone,
            from: PHONE_ID,
            metadata: {
                templateName: template,
                sentBy,
                userId
            },
        });
    }

    if (!res.ok) {
        console.error("❌ Erro WhatsApp:", data.error);
        throw new Error(data.error?.message || "Erro ao enviar template WhatsApp");
    }

    return { ...data, waMessageId };
}

/** 💬 Envia texto */
export async function sendTextMessage({
    to,
    text,
    lead,
    contactId = null,         // ← passa o contact._id quando tiver
    patientId = null,         // ← se estiver vinculado a um paciente
    sentBy = "amanda",   // default: Amanda respondeu sozinha
    userId = null,            // quando vier de usuário humano, passa o id aqui
    formatMode = "auto",      // "auto" | "preserve" | "bullets"
}) {
    const token = await requireToken();
    if (!PHONE_ID) throw new Error("META_WABA_PHONE_ID ausente.");

    const phone = normalizeE164BR(to);
    const url = `${META_URL}/${PHONE_ID}/messages`;

    const formattedText = formatWhatsAppText(text, { mode: formatMode });

    const body = {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: formattedText },
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
