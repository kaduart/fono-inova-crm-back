// controllers/whatsappController.js
import { getIo } from "../config/socket.js";
import Contact from "../models/Contact.js";
import Message from "../models/Message.js";
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

            const from = normalizePhone(msg.from || "");
            const type = msg.type; // 'text' | 'audio' | 'image' | 'video' | 'document' | 'sticker'
            const timestamp = new Date((parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000);

            let content = "";
            let mediaUrl = null;
            let caption = null;

            // texto
            if (type === "text") {
                content = msg.text?.body || "";
            }

            // mídia (resolve via Graph usando media.id)
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
                } else if (type === "sticker" && msg.sticker?.id) {
                    caption = "[STICKER]";
                    const { url } = await resolveMediaUrl(msg.sticker.id);
                    mediaUrl = url;
                }
            } catch (e) {
                console.error("⚠️ Falha ao resolver URL da mídia:", e.message);
            }

            const contentToSave = type === "text" ? content || "" : caption || `[${String(type).toUpperCase()}]`;

            const savedMessage = await Message.create({
                from,
                direction: "inbound",
                type,
                content: contentToSave,
                mediaUrl: mediaUrl || null,
                caption: caption || null,
                status: "received",
                timestamp,
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
                    url: mediaUrl, // front vai passar pelo /api/proxy-media
                    timestamp,
                });
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
