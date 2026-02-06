/* eslint-disable no-unused-vars */
// services/whatsappService.js
import dotenv from "dotenv";
import fetch from "node-fetch";
import FormData from 'form-data';
import ChatContext from "../models/ChatContext.js";
import Contact from "../models/Contacts.js";
import Lead from "../models/Leads.js"; // ajuste o path
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

    // 🆕 Atualiza lastContactAt no Lead quando mensagem é do lead (inbound)
    if (leadId && direction === "inbound") {
        try {
            await Lead.findByIdAndUpdate(
                leadId,
                {
                    lastContactAt: now,
                },
                { new: true }
            );
            console.log(`[LEAD] lastContactAt atualizado para lead ${leadId}`);
        } catch (err) {
            console.error("⚠️ Erro ao atualizar lastContactAt no lead:", err);
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
/** 💬 Envia texto COM TIMEOUT E RETRY */
export async function sendTextMessage({
    to,
    text,
    lead,
    contactId = null,
    patientId = null,
    sentBy = "amanda",
    userId = null,
    formatMode = "auto",
}) {
    // 🔒 Validação de controle manual (já existe, mantenha)
    if (lead && sentBy !== "manual") {
        const leadDoc = await Lead.findById(lead)
            .select("manualControl.active")
            .lean();
        if (leadDoc?.manualControl?.active) {
            console.log(`⏸️ Envio bloqueado (manual ativo). sentBy=${sentBy} lead=${lead}`);
            return { skipped: true, reason: "manual_control_active" };
        }
    }

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

    // ✅ NOVO: Timeout de 5 segundos + Retry 3 vezes
    const MAX_RETRIES = 3;
    const TIMEOUT_MS = 5000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            console.log(`📤 [WhatsApp] Tentativa ${attempt}/${MAX_RETRIES} para ${phone}`);

            const res = await fetch(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            const data = await res.json();
            const waMessageId = data?.messages?.[0]?.id || null;

            // ✅ SUCESSO: Registra e retorna
            if (res.ok) {
                await registerMessage({
                    leadId: lead,
                    contactId,
                    patientId,
                    direction: "outbound",
                    text,
                    type: "text",
                    status: "sent",
                    waMessageId,
                    timestamp: new Date(),
                    to: phone,
                    from: PHONE_ID,
                    metadata: { sentBy, userId },
                });

                console.log(`✅ Mensagem enviada com sucesso (tentativa ${attempt})`);
                return data;
            }

            // ❌ ERRO RECUPERÁVEL: Rate limit, servidor ocupado
            const isRetryable = [429, 500, 503, 504].includes(res.status);
            if (isRetryable && attempt < MAX_RETRIES) {
                console.warn(`⚠️ Erro ${res.status} (recuperável). Tentando novamente...`);
                await new Promise(resolve => setTimeout(resolve, attempt * 1000)); // Backoff
                continue;
            }

            // ❌ ERRO FATAL: Registra falha e lança
            await registerMessage({
                leadId: lead,
                contactId,
                patientId,
                direction: "outbound",
                text,
                type: "text",
                status: "failed",
                waMessageId: null,
                timestamp: new Date(),
                to: phone,
                from: PHONE_ID,
                metadata: {
                    sentBy,
                    userId,
                    error: data.error,
                    attempt
                },
            });

            throw new Error(`WhatsApp API error: ${res.status} - ${JSON.stringify(data.error)}`);

        } catch (error) {
            clearTimeout(timeoutId);

            // Timeout ou erro de rede
            if (error.name === 'AbortError') {
                console.error(`⏱️ Timeout na tentativa ${attempt}`);
            } else {
                console.error(`❌ Erro na tentativa ${attempt}:`, error.message);
            }

            // Última tentativa: registra falha e re-lança
            if (attempt === MAX_RETRIES) {
                await registerMessage({
                    leadId: lead,
                    contactId,
                    patientId,
                    direction: "outbound",
                    text,
                    type: "text",
                    status: "failed",
                    waMessageId: null,
                    timestamp: new Date(),
                    to: phone,
                    from: PHONE_ID,
                    metadata: {
                        sentBy,
                        userId,
                        error: error.message,
                        attempt: MAX_RETRIES
                    },
                });

                throw error;
            }

            // Aguarda antes de tentar novamente (backoff exponencial)
            await new Promise(resolve => setTimeout(resolve, attempt * 1500));
        }
    }
}

/**
 * 🎬 Envia mensagem de mídia (imagem, áudio, vídeo, documento)
 */
export async function sendWhatsAppMediaMessage({ 
    to, 
    file, 
    type, 
    caption, 
    filename,
    lead = null,
    contactId = null,
    patientId = null,
    sentBy = "manual",
    userId = null
}) {
    const token = await requireToken();
    if (!PHONE_ID) throw new Error("META_WABA_PHONE_ID ausente.");

    const phone = normalizeE164BR(to);
    
    console.log(`📤 [WhatsApp Media] Enviando ${type} para ${phone}`);
    console.log(`📁 [WhatsApp Media] Arquivo: ${filename}, Tamanho: ${file?.length || 0} bytes`);

    // 1. Fazer upload do arquivo para o Meta
    const formData = new FormData();
    
    // ✅ FIX: O Meta NÃO aceita audio/webm diretamente!
    // Mas aceita audio/ogg e audio/opus. WebM com Opus é similar a OGG.
    const isWebmAudio = filename.endsWith('.webm') && type === 'audio';
    
    if (isWebmAudio) {
        // Mudar extensão para .ogg e enviar como audio/ogg
        const oggFilename = filename.replace('.webm', '.ogg');
        console.log(`🎵 [WhatsApp Media] Detectado webm, enviando como ogg: ${oggFilename}`);
        console.log(`📊 [WhatsApp Media] Buffer tipo: ${typeof file}, tamanho: ${file.length}`);
        formData.append('file', file, {
            filename: oggFilename,
            contentType: 'audio/ogg'
        });
        console.log('🎵 [WhatsApp Media] Convertendo webm → ogg para Meta');
    } else {
        formData.append('file', file, filename);
    }
    
    formData.append('type', type);
    formData.append('messaging_product', 'whatsapp');

    const uploadRes = await fetch(`${META_URL}/${PHONE_ID}/media`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
        },
        body: formData
    });

    const uploadData = await uploadRes.json();
    console.log('📤 Upload response:', uploadData);

    if (!uploadRes.ok) {
        throw new Error(`Falha no upload: ${uploadData.error?.message || JSON.stringify(uploadData)}`);
    }

    const mediaId = uploadData.id;

    // 2. Enviar mensagem com a mídia
    const body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phone,
        type,
        [type]: {
            id: mediaId,
            ...(caption && { caption }),
            ...(type === 'document' && { filename })
        }
    };

    console.log('📤 Sending message with media:', JSON.stringify(body, null, 2));

    const sendRes = await fetch(`${META_URL}/${PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    const sendData = await sendRes.json();
    console.log('📤 Send response:', sendData);

    if (!sendRes.ok) {
        throw new Error(`Falha no envio: ${sendData.error?.message || JSON.stringify(sendData)}`);
    }

    const waMessageId = sendData?.messages?.[0]?.id || null;

    // 3. Registrar no banco
    await registerMessage({
        leadId: lead,
        contactId,
        patientId,
        direction: "outbound",
        text: caption || `[${type.toUpperCase()}]`,
        type,
        status: "sent",
        waMessageId,
        timestamp: new Date(),
        to: phone,
        from: PHONE_ID,
        metadata: { sentBy, userId, mediaId, filename },
    });

    return {
        ...sendData,
        mediaId,
        mediaUrl: uploadData.url
    };
}