import Message from '../models/Message.js';
import Contact from '../models/Contact.js'; // 👈 novo
import {
    handleWebhookEvent,
    sendTemplateMessage,
    sendTextMessage,
} from '../services/whatsappService.js';
import { getIo } from '../config/socket.js';

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

    /** 📩 Webhook (mensagens recebidas / status) */
    async webhook(req, res) {
        try {
            const entry = req.body.entry?.[0]?.changes?.[0]?.value;
            const msg = entry?.messages?.[0];
            const io = getIo();

            res.sendStatus(200); // resposta imediata obrigatória

            if (!msg) return;

            // 🔹 Detecta mídias
            const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker'];
            if (mediaTypes.includes(msg.type)) {
                const media = msg[msg.type] || {};
                const caption = msg.caption || media.caption || "";

                console.log(`📎 Mídia recebida: ${msg.type} (${media.mime_type}) de ${msg.from}`);

                io.emit('media-received', {
                    from: msg.from,
                    type: msg.type,
                    mime: media.mime_type,
                    id: media.id,
                    caption,
                    timestamp: msg.timestamp * 1000,
                });

                await Message.create({
                    from: msg.from,
                    to: process.env.PHONE_NUMBER_ID,
                    direction: 'inbound',
                    type: msg.type,
                    content: caption || '[MÍDIA RECEBIDA]',
                    status: 'received',
                    timestamp: new Date(msg.timestamp * 1000),
                });

                console.log('🧭 Mídia encaminhada para análise manual.');
                return;
            }

            // 🔹 Texto normal → IA / follow-up
            await handleWebhookEvent(req.body);
        } catch (err) {
            console.error('❌ Erro no webhook WhatsApp:', err);
            res.status(500).json({ error: err.message });
        }
    },

    /** 🧾 Retorna histórico de chat */
    async getChat(req, res) {
        try {
            const { phone } = req.params;
            if (!phone) {
                return res.status(400).json({ error: 'Número de telefone é obrigatório' });
            }

            const msgs = await Message.find({
                $or: [{ to: phone }, { from: phone }],
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
