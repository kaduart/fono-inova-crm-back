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

            if (!msg) {
                console.log("⚠️ Sem msg no payload:", JSON.stringify(req.body));
                return;
            }

            // normalização (igual ao front)
            const normalizePhone = (phone) => {
                let cleaned = (phone || "").replace(/\D/g, "");
                if (cleaned.startsWith("55")) cleaned = cleaned.substring(2);
                if (cleaned.length === 10) cleaned = cleaned.substring(0, 2) + "9" + cleaned.substring(2);
                return cleaned;
            };

            const isPlaceholderText = (txt) =>
                /^\s*\[(?:AUDIO|IMAGE|VIDEO|DOCUMENT|STICKER)\]\s*$/i.test(String(txt || ""));

            // debounce p/ IA por número (evita 2 respostas coladas)
            const aiShouldReply = async (phone, ttlSeconds = 20) => {
                try {
                    // usando a MESMA assinatura que você já usa no Redis do proxy (EX/TTL como strings)
                    const ok = await redis.set(`ai:auto:${phone}`, "1", "NX", "EX", ttlSeconds);
                    console.log("🔐 aiShouldReply ->", ok ? "ALLOW" : "BLOCK", `(ttl=${ttlSeconds}s)`);
                    return !!ok;
                } catch (e) {
                    console.warn("⚠️ Redis indisponível p/ AI debounce. Segue sem throttle.", e.message);
                    return true; // não bloqueia se redis falhar
                }
            };

            const from = normalizePhone(msg.from || "");
            const type = msg.type; // 'text' | 'audio' | 'image' | 'video' | 'document' | 'sticker'
            const timestamp = new Date((parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000);

            console.log("📨 INBOUND:", { fromRaw: msg.from, from, type, ts: timestamp.toISOString() });

            let content = "";
            let mediaUrl = null;
            let caption = null;

            // texto
            if (type === "text") {
                content = msg.text?.body || "";
                console.log("📝 Texto recebido:", content);
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
                if (mediaUrl) console.log("📎 Mídia resolvida:", { caption, mediaUrl });
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

            console.log("💾 Mensagem salva:", { id: String(savedMessage._id), type, hasMedia: !!mediaUrl });

            // emite pro front (texto x mídia)
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

            // ===============================
            // 🤖 AUTO-REPLY AMANDA 💚
            // ===============================
            try {
                // Apenas texto real (ignora placeholders)
                if (type !== "text" || !content || isPlaceholderText(content)) {
                    console.log("⏭️ AI: ignorando (não é texto real).");
                    return;
                }

                // (opcional) evite loop: só pular se vier MARCADO como nosso envio (ex.: msg.context?.from_me)
                if (msg?.from_me === true) {
                    console.log("⏭️ AI: ignorando mensagem enviada por nós.");
                    return;
                }

                // trava anti-dup por 20s
                const allowed = await aiShouldReply(from);
                if (!allowed) {
                    console.log("⏭️ AI: bloqueado por debounce (já respondeu há pouco).");
                    return;
                }

                // Buscar LEAD (para personalizar)
                let leadDoc = null;
                try {
                    leadDoc = await Lead.findOne({ "contact.phone": { $regex: from.slice(-11) } }).lean();
                } catch (e) {
                    console.warn("⚠️ Lead lookup falhou:", e.message);
                }

                const leadId = leadDoc?._id || null;

                // último contexto curtinho (opcional)
                let lastInteraction = "agora";
                try {
                    const ctx = await ChatContext.findOne({ lead: leadId }).lean();
                    const last = ctx?.messages?.[ctx.messages?.length - 1];
                    if (last?.ts) lastInteraction = new Date(last.ts).toISOString();
                } catch (e) {
                    console.warn("⚠️ ChatContext lookup falhou:", e.message);
                }

                const leadStub = {
                    name: leadDoc?.name || "tudo bem",
                    reason: leadDoc?.reason || "avaliação/terapia",
                    origin: leadDoc?.origin || "WhatsApp",
                    lastInteraction,
                };

                console.log("🧠 IA: gerando resposta para", { to: from, lead: leadStub });

                const aiText = await generateFollowupMessage(leadStub);
                console.log("🧠 IA: texto gerado:", aiText);

                if (aiText && aiText.trim()) {
                    await sendTextMessage({ to: from, text: aiText, lead: leadId });
                    console.log("✅ IA: resposta enviada");
                } else {
                    console.log("⚠️ IA: texto vazio, nada enviado.");
                }
            } catch (aiErr) {
                console.error("🤖 IA (Amanda) falhou no auto-reply:", aiErr?.message || aiErr);
            }
            // ===============================

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
