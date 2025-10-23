// controllers/whatsappController.js
import { redisConnection as redis } from '../config/redisConnection.js'; // <— redis singleton (se tiver)
import { getIo } from "../config/socket.js";
import Contact from "../models/Contact.js";
import Lead from '../models/Leads.js'; // <— modelo do lead
import Message from "../models/Message.js";
import { generateAmandaReply } from "../services/aiAmandaService.js";
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

    // dentro de export const whatsappController = { ... }
    async webhook(req, res) {
        console.log("🔔 [DEBUG] WEBHOOK POST RECEIVED");
        try {
            const io = getIo();
            const change = req.body.entry?.[0]?.changes?.[0];
            const value = change?.value;

            // 1) ignore eventos que não são mensagens
            if (!value?.messages || !Array.isArray(value.messages) || !value.messages[0]) {
                res.sendStatus(200);
                return;
            }

            const msg = value.messages[0];
            const wamid = msg.id;              // id único do WhatsApp
            const fromRaw = msg.from || "";

            // responde rápido pro Meta
            res.sendStatus(200);

            // 2) de-dup por wamid (WhatsApp pode reenviar)
            try {
                if (redis?.set) {
                    const seenKey = `wa:seen:${wamid}`;
                    const ok = await redis.set(seenKey, "1", "EX", 300, "NX");
                    if (ok !== "OK") {
                        console.log("⏭️  Ignorando repetição (wamid já visto)", wamid);
                        return;
                    }
                }
            } catch (e) {
                console.warn("⚠️ Redis indisponível p/ seen:", e.message);
            }

            // 3) normalização (igual ao front)
            const normalizePhone = (phone) => {
                let cleaned = (phone || "").replace(/\D/g, "");
                if (cleaned.startsWith("55")) cleaned = cleaned.substring(2);
                if (cleaned.length === 10) cleaned = cleaned.substring(0, 2) + "9" + cleaned.substring(2);
                return cleaned;
            };

            const from = normalizePhone(fromRaw);
            const type = msg.type; // 'text' | 'audio' | 'image' | 'video' | 'document' | 'sticker'
            const timestamp = new Date((parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000);

            console.log("📨 INBOUND:", { wamid, fromRaw, from, type, ts: timestamp.toISOString() });

            let content = "";
            let mediaUrl = null;
            let caption = null;
            let mediaId = null;

            // 4) extrai conteúdo
            if (type === "text") {
                content = msg.text?.body || "";
                console.log("📝 Texto recebido:", content);
            } else {
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
            }

            const contentToSave = type === "text" ? (content || "") : (caption || `[${String(type).toUpperCase()}]`);

            // 5) persiste (mídia marcada para revisão humana)
            const savedMessage = await Message.create({
                wamid,
                from,
                direction: "inbound",
                type,
                content: contentToSave,
                mediaUrl: mediaUrl || null,
                mediaId: mediaId || null,
                caption: caption || null,
                status: "received",
                needs_human_review: type !== "text",   // 👈 mídia vai para secretária
                timestamp,
            });

            console.log("💾 Mensagem salva:", {
                id: String(savedMessage._id),
                type: savedMessage.type,
                hasMedia: !!savedMessage.mediaUrl,
            });

            // 6) emite pro front
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
                    url: mediaUrl,   // front passa no /api/proxy-media
                    mediaId,
                    timestamp,
                });
            }

            // ============================
            // 🤖 AMANDA — responde só TEXTO
            // ============================
            if (type !== "text" || !contentToSave?.trim()) {
                // opcional: confirmação simpática automática para mídia
                // await sendTextMessage({
                //   to: from,
                //   text: "Recebi seu arquivo. Vou verificar e já te retorno, por favor um momento 💚\n\nEquipe Fono Inova 💚"
                // });
                return; // mídia: secretária assume no painel
            }

            // (1) lock rápido anti corrida (10s)
            try {
                if (redis?.set) {
                    const lockKey = `ai:lock:${from}`;
                    const ok = await redis.set(lockKey, "1", "EX", 10, "NX");
                    if (ok !== "OK") {
                        console.log("⏭️  AI lock ativo; evitando corrida");
                        return;
                    }
                }
            } catch { }

            // (2) não responder se já houve resposta nossa há ~45s
            const fortyFiveAgo = new Date(Date.now() - 45 * 1000);
            const recentBotReply = await Message.findOne({
                to: { $regex: from.slice(-11) },
                direction: "outbound",
                type: "text",
                timestamp: { $gte: fortyFiveAgo },
            }).lean();
            if (recentBotReply) {
                console.log("⏭️  Já houve resposta nossa recente; pulando auto-reply.");
                return;
            }

            // (3) debounce por número (60s)
            let canReply = true;
            try {
                if (redis?.set) {
                    const key = `ai:debounce:${from}`;
                    const ok = await redis.set(key, "1", "EX", 60, "NX");
                    if (ok !== "OK") canReply = false;
                }
            } catch (e) {
                console.warn("⚠️ Redis debounce indisponível:", e.message);
            }
            if (!canReply) return;

            // (4) lead + histórico curto (12 últimas mensagens de texto)
            const tail11 = from.slice(-11);
            const leadDoc = await Lead.findOne({ "contact.phone": { $regex: tail11 } })
                .lean()
                .catch(() => null);

            const histDocs = await Message.find({
                $or: [{ from: { $regex: tail11 } }, { to: { $regex: tail11 } }],
                type: "text",
            })
                .sort({ timestamp: -1 })
                .limit(12)
                .lean();

            const lastMessages = histDocs.reverse().map(m => (m.content || m.text || "").toString());
            const greetings = /^(oi|ol[aá]|boa\s*(tarde|noite|dia)|tudo\s*bem|bom\s*dia|fala|e[aíi])[\s!,.]*$/i;
            const isFirstContact = lastMessages.length <= 1 || greetings.test(contentToSave.trim());
            console.log("[AmandaReply] isFirstContact:", isFirstContact, "lastMessages:", lastMessages);

            // (5) gera resposta contextual
            const aiText = await generateAmandaReply({
                userText: contentToSave,
                lead: {
                    name: leadDoc?.name || "",
                    reason: leadDoc?.reason || "avaliação/terapia",
                    origin: leadDoc?.origin || "WhatsApp",
                },
                context: { lastMessages, isFirstContact },
            });

            console.log("[AmandaReply] texto gerado:", aiText);

            // (6) envia
            if (aiText && aiText.trim()) {
                await sendTextMessage({ to: from, text: aiText.trim(), lead: leadDoc?._id });
                console.log("✅ IA (Amanda) enviada para", from);
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
