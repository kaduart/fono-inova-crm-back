// controllers/whatsappController.js
import { redisConnection as redis } from '../config/redisConnection.js'; // <— redis singleton (se tiver)
import { getIo } from "../config/socket.js";
import ChatContext from '../models/ChatContext.js'; // <— contexto do chat
import Contact from "../models/Contact.js";
import Lead from '../models/Leads.js'; // <— modelo do lead
import Message from "../models/Message.js";
import { generateFollowupMessage } from '../services/amandaService.js';
import { resolveMediaUrl, sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";

export const whatsappController = {
    async sendTemplate(req, res) {
        try {
            const { phone, template, params = [], leadId } = req.body;
            if (!phone || !template) {
                return res.status(400).json({ success: false, error: "Campos obrigatórios: phone e template" });
            }
            const result = await sendTemplateMessage({ to: phone, template, params, lead: leadId });
            res.json({ success: true, result });
        } catch (err) {
            console.error("❌ Erro ao enviar template WhatsApp:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async sendText(req, res) {
        try {
            const { phone, text, leadId } = req.body;
            if (!phone || !text) {
                return res.status(400).json({ success: false, error: "Campos obrigatórios: phone e text" });
            }
            const result = await sendTextMessage({ to: phone, text, lead: leadId });
            res.json({ success: true, result });
        } catch (err) {
            console.error("❌ Erro ao enviar texto WhatsApp:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async getWebhook(req, res) {
        try {
            const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
            const mode = req.query["hub.mode"];
            const token = req.query["hub.verify_token"];
            const challenge = req.query["hub.challenge"];

            if (mode && token && mode === "subscribe" && token === verifyToken) {
                return res.status(200).send(challenge);
            }
            return res.sendStatus(403);
        } catch (err) {
            console.error("❌ Erro na verificação do webhook:", err);
            res.sendStatus(500);
        }
    },

    async webhook(req, res) {
        console.log("🔔 [DEBUG] WEBHOOK POST RECEIVED");
        try {
            const io = getIo();
            const entry = req.body.entry?.[0]?.changes?.[0]?.value;
            const msg = entry?.messages?.[0];

            // responde rápido pro Meta
            res.sendStatus(200);
            if (!msg) return;

            // normalização (igual ao front)
            const normalizePhone = (phone) => {
                let cleaned = (phone || "").replace(/\D/g, "");
                if (cleaned.startsWith("55")) cleaned = cleaned.substring(2);
                if (cleaned.length === 10) cleaned = cleaned.substring(0, 2) + "9" + cleaned.substring(2);
                return cleaned;
            };

            const fromRaw = msg.from || "";
            const from = normalizePhone(fromRaw);
            const type = msg.type; // 'text' | 'audio' | 'image' | 'video' | 'document' | 'sticker'
            const timestamp = new Date((parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000);

            console.log("📨 INBOUND:", {
                fromRaw, from, type, ts: timestamp.toISOString()
            });

            let content = "";
            let mediaUrl = null;
            let caption = null;
            let mediaId = null;

            // texto
            if (type === "text") {
                content = msg.text?.body || "";
                console.log("📝 Texto recebido:", content);
            }

            // mídia (resolve via Graph usando media.id)
            try {
                if (type === "audio" && msg.audio?.id) {
                    mediaId = msg.audio.id;
                    caption = "[AUDIO]";
                    const { url } = await resolveMediaUrl(mediaId);
                    mediaUrl = url;
                } else if (type === "image" && msg.image?.id) {
                    mediaId = msg.image.id;
                    caption = msg.image.caption || "[IMAGE]";
                    const { url } = await resolveMediaUrl(mediaId);
                    mediaUrl = url;
                } else if (type === "video" && msg.video?.id) {
                    mediaId = msg.video.id;
                    caption = msg.video.caption || "[VIDEO]";
                    const { url } = await resolveMediaUrl(mediaId);
                    mediaUrl = url;
                } else if (type === "document" && msg.document?.id) {
                    mediaId = msg.document.id;
                    caption = msg.document.filename || "[DOCUMENT]";
                    const { url } = await resolveMediaUrl(mediaId);
                    mediaUrl = url;
                } else if (type === "sticker" && msg.sticker?.id) {
                    mediaId = msg.sticker.id;
                    caption = "[STICKER]";
                    const { url } = await resolveMediaUrl(mediaId);
                    mediaUrl = url;
                }
            } catch (e) {
                console.error("⚠️ Falha ao resolver URL da mídia:", e.message);
            }

            const contentToSave = type === "text" ? (content || "") : (caption || `[${String(type).toUpperCase()}]`);

            // salva mensagem
            const savedMessage = await Message.create({
                from,
                direction: "inbound",
                type,
                content: contentToSave,
                mediaUrl: mediaUrl || null,
                mediaId: mediaId || null,     // <- para proxy por mediaId no front
                caption: caption || null,
                status: "received",
                timestamp,
            });

            console.log("💾 Mensagem salva:", {
                id: String(savedMessage._id),
                type: savedMessage.type,
                hasMedia: !!savedMessage.mediaUrl
            });

            // emite pro front
            if (type === "text") {
                io.emit("whatsapp:new_message", {
                    id: String(savedMessage._id),
                    from,
                    text: contentToSave,
                    timestamp,
                });
            } else {
                io.emit("whatsapp:new_media", {
                    id: String(savedMessage._id),
                    from,
                    type,
                    caption: contentToSave,
                    url: mediaUrl,      // front passa pelo /api/proxy-media
                    mediaId,            // front pode preferir mediaId
                    timestamp,
                });
            }

            // ============================
            // 🤖 AUTO-REPLY AMANDA (IA)
            // ============================

            // 1) Só responde para texto (evita reagir a mídia e a templates)
            if (type !== "text" || !contentToSave?.trim()) return;

            // 2) Debounce para não responder várias vezes seguidas
            //    Usa Redis se disponível; senão, um Map em memória
            const DEBOUNCE_KEY = `ai:debounce:${from}`;
            const DEBOUNCE_SECONDS = 60; // 1 min
            let canReply = true;

            try {
                if (redis && typeof redis.set === "function") {
                    const ok = await redis.set(DEBOUNCE_KEY, "1", "EX", DEBOUNCE_SECONDS, "NX");
                    if (ok !== "OK") canReply = false;
                } else {
                    console.warn("⚠️ Redis indisponível p/ AI debounce. Segue sem throttle.");
                }
            } catch (e) {
                console.warn("⚠️ Erro no debounce Redis:", e.message);
            }
            if (!canReply) return;

            // 3) Coletar dados do Lead / Contexto (se existir)
            let leadDoc = null;
            try {
                // procura por últimos 11 dígitos do telefone
                const tail11 = from.slice(-11);
                leadDoc = await Lead.findOne({ "contact.phone": { $regex: tail11 } });
            } catch (e) {
                console.warn("⚠️ Lead lookup falhou:", e.message);
            }

            let ctx = null;
            try {
                if (leadDoc?._id) {
                    ctx = await ChatContext.findOne({ lead: leadDoc._id }).lean();
                }
            } catch (e) {
                console.warn("⚠️ ChatContext lookup falhou:", e.message);
            }

            // 4) Monta payload para IA
            const aiLead = {
                name: leadDoc?.name || "tudo bem",
                reason: leadDoc?.reason || "avaliação/terapia",
                origin: leadDoc?.origin || "WhatsApp",
                lastInteraction: ctx?.lastUpdatedAt ? new Date(ctx.lastUpdatedAt).toLocaleDateString("pt-BR") : "agora",
            };

            console.log("🧠 IA: gerando resposta para", { to: from, lead: aiLead });

            let aiText = "";
            try {
                aiText = await generateFollowupMessage(aiLead);
            } catch (e) {
                console.error("🤖 IA (Amanda) falhou no auto-reply:", e.message);
            }

            if (!aiText) return;

            // 5) Envia a resposta da IA pelo mesmo serviço de WhatsApp
            try {
                await sendTextMessage({
                    to: from,
                    text: aiText,
                    lead: leadDoc?._id || undefined,
                });
                console.log("✅ IA enviada para", from);
            } catch (e) {
                console.error("❌ Falha ao enviar resposta da IA:", e.message);
            }

        } catch (err) {
            // já respondemos 200
            console.error("❌ Erro no webhook WhatsApp:", err);
        }
    },


    async getChat(req, res) {
        try {
            const { phone } = req.params;
            if (!phone) return res.status(400).json({ error: "Número de telefone é obrigatório" });

            const cleanPhone = phone.replace(/\D/g, "");
            const regex = new RegExp(cleanPhone, "i");

            const msgs = await Message.find({
                $or: [{ from: { $regex: regex } }, { to: { $regex: regex } }],
            }).sort({ timestamp: 1 });

            res.json({ success: true, data: msgs });
        } catch (err) {
            console.error("❌ Erro ao buscar chat:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async listContacts(_req, res) {
        try {
            const contacts = await Contact.find().sort({ name: 1 });
            res.json(contacts);
        } catch (err) {
            console.error("❌ Erro ao listar contatos:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async addContact(req, res) {
        try {
            const { name, phone, avatar } = req.body;
            if (!name || !phone) return res.status(400).json({ error: "Nome e telefone são obrigatórios" });

            const existing = await Contact.findOne({ phone });
            if (existing) return res.status(400).json({ error: "Contato com esse telefone já existe" });

            const contact = await Contact.create({ name, phone, avatar });
            res.status(201).json(contact);
        } catch (err) {
            console.error("❌ Erro ao adicionar contato:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async updateContact(req, res) {
        try {
            const updated = await Contact.findByIdAndUpdate(req.params.id, req.body, { new: true });
            res.json(updated);
        } catch (err) {
            console.error("❌ Erro ao atualizar contato:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async deleteContact(req, res) {
        try {
            await Contact.findByIdAndDelete(req.params.id);
            res.json({ success: true });
        } catch (err) {
            console.error("❌ Erro ao deletar contato:", err);
            res.status(500).json({ error: err.message });
        }
    },
};
