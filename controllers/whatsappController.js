import { getIo } from '../config/socket.js';
import Contact from '../models/Contact.js'; // 👈 novo
import Message from '../models/Message.js';
import {
    handleWebhookEvent,
    sendTemplateMessage,
    sendTextMessage,
} from '../services/whatsappService.js';

export const whatsappController = {
    /** ✉️ Envia template (mensagem com variáveis dinâmicas) */
    async sendTemplate(req, res) {
        try {
            const { phone, template, params = [], leadId } = req.body;

            if (!phone || !template) {
                return res.status(400).json({
                    success: false,
                    error: 'Campos obrigatórios: phone e template',
                });
            }

            const result = await sendTemplateMessage({
                to: phone,
                template,
                params,
                lead: leadId,
            });

            res.json({ success: true, result });
        } catch (err) {
            console.error('❌ Erro ao enviar template WhatsApp:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    },

    /** 💬 Envia mensagem de texto padrão */
    async sendText(req, res) {
        try {
            const { phone, text, leadId } = req.body;

            if (!phone || !text) {
                return res.status(400).json({
                    success: false,
                    error: 'Campos obrigatórios: phone e text',
                });
            }

            const result = await sendTextMessage({
                to: phone,
                text,
                lead: leadId,
            });

            res.json({ success: true, result });
        } catch (err) {
            console.error('❌ Erro ao enviar texto WhatsApp:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    },

    /** ✅ Verificação do webhook (GET) */
    async getWebhook(req, res) {
        try {
            const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
            const mode = req.query["hub.mode"];
            const token = req.query["hub.verify_token"];
            const challenge = req.query["hub.challenge"];

            if (mode && token) {
                if (mode === "subscribe" && token === verifyToken) {
                    console.log("✅ Webhook verificado com sucesso pelo Meta!");
                    return res.status(200).send(challenge);
                } else {
                    console.warn("❌ Token de verificação inválido recebido:", token);
                    return res.sendStatus(403);
                }
            }

            console.warn("⚠️ Requisição de verificação incompleta recebida:", req.query);
            res.sendStatus(400);
        } catch (err) {
            console.error("❌ Erro na verificação do webhook:", err);
            res.sendStatus(500);
        }
    },

    /** 📩 Webhook (mensagens recebidas / status) */
    /** 📩 Webhook (mensagens recebidas / status) */
    async webhook(req, res) {
        try {
            const io = getIo();
            const entry = req.body.entry?.[0]?.changes?.[0]?.value;
            const msg = entry?.messages?.[0];

            // ⚡ Responde imediatamente ao Meta
            res.sendStatus(200);

            if (!msg) {
                console.warn("⚠️ Nenhuma mensagem válida recebida.");
                return;
            }

            const from = (msg.from || '').replace(/\D/g, '');
            const to = (entry?.metadata?.display_phone_number || '').replace(/\D/g, '');
            const type = msg.type;
            const timestamp = new Date((msg.timestamp || Date.now()) * 1000);

            let content = '';
            let mediaUrl = null;

            console.log(`📩 Mensagem recebida de ${from} (${type})`);

            // 🔹 Texto normal
            if (type === 'text') {
                content = msg.text?.body || '';
            }

            // 🔹 Mídia (imagem, vídeo, áudio, documento)
            const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker'];
            // dentro do webhook:
            if (mediaTypes.includes(type)) {
                const media = msg[type] || {};
                const caption = msg.caption || media.caption || "";

                // 🔹 Pega URL da mídia
                const mediaUrl = media.url || null;
                console.log(`📎 Mídia recebida: ${type} (${media.mime_type})`);

                io.emit("whatsapp:new_media", {
                    from,
                    type,
                    mime: media.mime_type,
                    caption,
                    url: mediaUrl,
                    timestamp,
                });

                await Message.create({
                    from,
                    direction: "inbound",
                    type,
                    content: caption || `[${type.toUpperCase()}]`,
                    mediaUrl,
                    status: "received",
                    timestamp,
                });
            }

            console.log('💾 Mensagem salva no banco com sucesso');

            // 🔹 Emitir para o front via socket.io
            if (type === 'text') {
                io.emit('whatsapp:new_message', {
                    from,
                    text: content,
                    timestamp,
                });
            } else if (mediaUrl) {
                io.emit('whatsapp:new_media', {
                    from,
                    type,
                    caption: content,
                    url: mediaUrl,
                    timestamp,
                });
            }

            // 🔹 Disparar IA/follow-up assíncrono
            handleWebhookEvent(req.body)
                .then(() => console.log('🤖 handleWebhookEvent executado com sucesso'))
                .catch(err => console.error('❌ Erro no handleWebhookEvent:', err));

        } catch (err) {
            console.error('❌ Erro no webhook WhatsApp:', err);
            res.sendStatus(500);
        }
    },

    /** 🧾 Retorna histórico de chat */
    async getChat(req, res) {
        try {
            const { phone } = req.params;

            if (!phone) {
                return res.status(400).json({ error: 'Número de telefone é obrigatório' });
            }

            // Normaliza para pegar qualquer formato possível do número
            const cleanPhone = phone.replace(/\D/g, '');
            const regex = new RegExp(cleanPhone, 'i');

            const msgs = await Message.find({
                $or: [
                    { from: { $regex: regex } },
                    { to: { $regex: regex } },
                ],
            }).sort({ timestamp: 1 });

            res.json({ success: true, data: msgs });
        } catch (err) {
            console.error('❌ Erro ao buscar chat:', err);
            res.status(500).json({ error: err.message });
        }
    },

    // 👇👇👇 ADICIONADOS ABAIXO 👇👇👇

    /** 👥 Lista todos os contatos */
    async listContacts(req, res) {
        try {
            const contacts = await Contact.find().sort({ name: 1 });
            res.json(contacts);
        } catch (err) {
            console.error('❌ Erro ao listar contatos:', err);
            res.status(500).json({ error: err.message });
        }
    },

    /** ➕ Adiciona novo contato */
    async addContact(req, res) {
        try {
            const { name, phone, avatar } = req.body;

            if (!name || !phone)
                return res.status(400).json({ error: 'Nome e telefone são obrigatórios' });

            const existing = await Contact.findOne({ phone });
            if (existing)
                return res.status(400).json({ error: 'Contato com esse telefone já existe' });

            const contact = await Contact.create({ name, phone, avatar });
            res.status(201).json(contact);
        } catch (err) {
            console.error('❌ Erro ao adicionar contato:', err);
            res.status(500).json({ error: err.message });
        }
    },

    /** ✏️ Atualiza contato existente */
    async updateContact(req, res) {
        try {
            const updated = await Contact.findByIdAndUpdate(req.params.id, req.body, { new: true });
            res.json(updated);
        } catch (err) {
            console.error('❌ Erro ao atualizar contato:', err);
            res.status(500).json({ error: err.message });
        }
    },

    /** 🗑️ Deleta contato */
    async deleteContact(req, res) {
        try {
            await Contact.findByIdAndDelete(req.params.id);
            res.json({ success: true });
        } catch (err) {
            console.error('❌ Erro ao deletar contato:', err);
            res.status(500).json({ error: err.message });
        }
    },
};
