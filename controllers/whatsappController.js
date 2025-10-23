// controllers/whatsappController.js
import { redisConnection as redis } from '../config/redisConnection.js';
import { getIo } from "../config/socket.js";
import Contact from "../models/Contact.js";
import Lead from '../models/Leads.js';
import Message from "../models/Message.js";
import { generateAmandaReply } from "../services/aiAmandaService.js";
import { resolveMediaUrl, sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";

import { normalizeE164BR, tailPattern } from "../utils/phone.js";

export const whatsappController = {

    async sendTemplate(req, res) {
        try {
            const { phone, template, params = [], leadId } = req.body;
            if (!phone || !template) {
                return res.status(400).json({ success: false, error: "Campos obrigatórios: phone e template" });
            }
            const to = normalizeE164BR(phone);
            const result = await sendTemplateMessage({ to, template, params, lead: leadId });

            // (opcional) persistir template outbound p/ aparecer no chat
            const saved = await Message.create({
                from: process.env.CLINIC_PHONE_E164 || to, // número da clínica
                to,
                direction: "outbound",
                type: "template",
                content: `[TEMPLATE] ${template}`,
                templateName: template,
                status: "sent",
                timestamp: new Date(),
                lead: leadId || null,
            });

            const io = getIo();
            io.emit("message:new", {
                id: String(saved._id),
                from: saved.from,
                to: saved.to,
                direction: "outbound",
                type: "template",
                content: saved.content,
                status: saved.status,
                timestamp: saved.timestamp,
            });

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

            const to = normalizeE164BR(phone); // cliente
            const clinicFrom = process.env.CLINIC_PHONE_E164 || to; // número da clínica (melhor setar no .env)

            const result = await sendTextMessage({ to, text, lead: leadId });

            // 🔹 PERSISTE OUTBOUND
            const saved = await Message.create({
                from: clinicFrom,
                to,
                direction: "outbound",
                type: "text",
                content: text,
                status: "sent",
                timestamp: new Date(),
                lead: leadId || null,
            });

            // 🔹 EMITE PARA A UI
            const io = getIo();
            io.emit("message:new", {
                id: String(saved._id),
                from: saved.from,
                to: saved.to,
                direction: "outbound",
                type: "text",
                content: saved.content,
                status: saved.status,
                timestamp: saved.timestamp,
            });

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
            const change = req.body.entry?.[0]?.changes?.[0];
            const value = change?.value;

            // 1) ignore eventos que não são mensagens
            if (!value?.messages || !Array.isArray(value.messages) || !value.messages[0]) {
                res.sendStatus(200);
                return;
            }

            const msg = value.messages[0];
            const wamid = msg.id;
            const fromRaw = msg.from || "";

            // ⚠️ NÃO use phone_number_id como número de telefone. Use display_phone_number ou .env
            const toRaw =
                value?.metadata?.display_phone_number ||
                process.env.CLINIC_PHONE_E164 ||
                "";

            // responde rápido pro Meta
            res.sendStatus(200);

            // 2) de-dup por wamid
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

            const from = normalizeE164BR(fromRaw); // cliente
            const to = normalizeE164BR(toRaw);     // clínica
            const type = msg.type;
            const timestamp = new Date((parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000);

            console.log("📨 INBOUND:", { wamid, fromRaw, from, type, ts: timestamp.toISOString() });

            let content = "";
            let mediaUrl = null;
            let caption = null;
            let mediaId = null;

            // 4) extrai conteúdo
            if (type === "text") {
                content = msg.text?.body || "";
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

            // 5) upsert contato/lead e salva inbound
            let contact = await Contact.findOne({ phone: from });
            if (!contact) contact = await Contact.create({ phone: from, name: msg.profile?.name || "Contato" });

            let lead = await Lead.findOne({ phone: from });
            if (!lead) lead = await Lead.create({ phone: from, name: contact.name, origin: "WhatsApp" });

            const savedMessage = await Message.create({
                wamid,
                from,  // cliente
                to,    // clínica
                direction: "inbound",
                type,
                content: contentToSave,
                mediaUrl: mediaUrl || null,
                mediaId: mediaId || null,
                caption: caption || null,
                status: "received",
                needs_human_review: type !== "text",
                timestamp,
                contact: contact._id,
                lead: lead._id,
                raw: msg,
            });

            console.log("💾 Mensagem salva (inbound):", String(savedMessage._id));

            // 6) emite pro front
            io.emit("message:new", {
                id: String(savedMessage._id),
                from,
                to,
                direction: "inbound",
                type,
                content: contentToSave,
                text: contentToSave, // compat front antigo
                mediaUrl,
                mediaId,
                caption,
                status: "received",
                timestamp,
            });

            // ============================
            // 🤖 AMANDA — responde só TEXTO
            // ============================
            if (type !== "text" || !contentToSave?.trim()) {
                return; // mídia: secretaria assume
            }

            // (1) lock rápido anti corrida
            try {
                if (redis?.set) {
                    const lockKey = `ai:lock:${from}`;
                    const ok = await redis.set(lockKey, "1", "EX", 3, "NX"); // 3s para teste
                    if (ok !== "OK") {
                        console.log("⏭️  AI lock ativo; evitando corrida", lockKey);
                        return;
                    }
                }
            } catch { }

            // (2) não responder se já houve resposta nossa há ~45s
            const fortyFiveAgo = new Date(Date.now() - 45 * 1000);
            const recentBotReply = await Message.findOne({
                to: from,
                direction: "outbound",
                type: "text",
                timestamp: { $gte: fortyFiveAgo },
            }).lean();
            if (recentBotReply) {
                console.log("⏭️  Já houve resposta nossa recente; pulando auto-reply.");
                return;
            }

            // (3) debounce por número
            let canReply = true;
            try {
                if (redis?.set) {
                    const key = `ai:debounce:${from}`;
                    const ok = await redis.set(key, "1", "EX", 8, "NX"); // 8s p/ teste
                    if (ok !== "OK") canReply = false;
                }
            } catch (e) {
                console.warn("⚠️ Redis debounce indisponível:", e.message);
            }
            if (!canReply) return;

            // (4) lead + histórico curto (corrigido o lookup)
            const leadDoc = await Lead.findOne({ phone: from }).lean().catch(() => null);

            const histDocs = await Message.find({
                $or: [{ from }, { to: from }],
                type: "text",
            }).sort({ timestamp: -1 }).limit(12).lean();

            const lastMessages = histDocs.reverse().map(m => (m.content || m.text || "").toString());
            const greetings = /^(oi|ol[aá]|boa\s*(tarde|noite|dia)|tudo\s*bem|bom\s*dia|fala|e[aíi])[\s!,.]*$/i;
            const isFirstContact = lastMessages.length <= 1 || greetings.test(contentToSave.trim());

            // (5) gera resposta
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

            // (6) envia, persiste e emite OUTBOUND (IA)
            if (aiText && aiText.trim()) {
                await sendTextMessage({ to: from, text: aiText.trim(), lead: leadDoc?._id });

                const savedOut = await Message.create({
                    from: to,         // clínica
                    to: from,         // cliente
                    direction: "outbound",
                    type: "text",
                    content: aiText.trim(),
                    status: "sent",
                    timestamp: new Date(),
                    lead: leadDoc?._id || null,
                });

                io.emit("message:new", {
                    id: String(savedOut._id),
                    from: savedOut.from,
                    to: savedOut.to,
                    direction: "outbound",
                    type: "text",
                    content: savedOut.content,
                    status: savedOut.status,
                    timestamp: savedOut.timestamp,
                });

                console.log("✅ IA (Amanda) enviada e salva:", String(savedOut._id));
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

            const pE164 = normalizeE164BR(phone);
            // match exato
            let msgs = await Message.find({
                $or: [{ from: pE164 }, { to: pE164 }],
            }).sort({ timestamp: 1 });

            // fallback por "rabo"
            if (msgs.length === 0) {
                const tail = tailPattern(phone, 8, 11);
                msgs = await Message.find({
                    $or: [{ from: { $regex: tail } }, { to: { $regex: tail } }],
                }).sort({ timestamp: 1 });
            }

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

            const p = normalizeE164BR(phone);
            const existing = await Contact.findOne({ phone: p });
            if (existing) return res.status(400).json({ error: "Contato com esse telefone já existe" });

            const contact = await Contact.create({ name, phone: p, avatar });
            res.status(201).json(contact);
        } catch (err) {
            console.error("❌ Erro ao adicionar contato:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async updateContact(req, res) {
        try {
            if (req.body?.phone) req.body.phone = normalizeE164BR(req.body.phone);
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
