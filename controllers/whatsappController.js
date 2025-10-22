import { getIo } from '../config/socket.js';
import Contact from '../models/Contact.js'; // 👈 novo
import Message from '../models/Message.js';
import {
    sendTemplateMessage,
    sendTextMessage
} from '../services/whatsappService.js';
import axios from 'axios'; 

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
        console.log('🔐 [DEBUG] WEBHOOK VERIFICATION - FULL DETAILS:', {
            query: req.query,
            verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
            hasToken: !!process.env.WHATSAPP_VERIFY_TOKEN,
            tokenLength: process.env.WHATSAPP_VERIFY_TOKEN?.length
        });

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
    async webhook(req, res) {
        console.log('🔔 [DEBUG] WEBHOOK POST RECEIVED - FIRST LINE');
        console.log('📦 [DEBUG] Full body:', JSON.stringify(req.body, null, 2));

        console.log('🔔 WEBHOOK INICIADO - Headers:', req.headers);
        console.log('📦 WEBHOOK BODY:', JSON.stringify(req.body, null, 2));
        try {
            const io = getIo();
            const entry = req.body.entry?.[0]?.changes?.[0]?.value;
            const msg = entry?.messages?.[0];

            // ⚡ Responde imediatamente ao Meta
            res.sendStatus(200);

            if (!msg) {
                console.warn("⚠️ Nenhuma mensagem válida recebida. Body completo:", JSON.stringify(req.body, null, 2));
                return;
            }

            // 🔧 NORMALIZAÇÃO CORRIGIDA (igual ao frontend)
            const normalizePhone = (phone) => {
                let cleaned = phone.replace(/\D/g, '');
                if (cleaned.startsWith('55')) {
                    cleaned = cleaned.substring(2);
                }
                if (cleaned.length === 10) {
                    cleaned = cleaned.substring(0, 2) + '9' + cleaned.substring(2);
                }
                return cleaned;
            };

            const from = normalizePhone(msg.from || '');
            const type = msg.type;
            const timestamp = new Date(parseInt(msg.timestamp) * 1000 || Date.now());

            console.log(`📩 Mensagem recebida de ${from} (${type})`, {
                originalFrom: msg.from,
                normalizedFrom: from,
                timestamp: timestamp.toISOString(),
                body: req.body
            });

            let content = '';
            let mediaUrl = null;

            // 🔹 Texto normal
            if (type === 'text') {
                content = msg.text?.body || '';
                console.log(`📝 Conteúdo da mensagem: "${content}"`);
            }

            // 🔹 Mídia
            const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker'];
            if (mediaTypes.includes(type)) {
                const media = msg[type] || {};
                content = msg.caption || media.caption || `[${type.toUpperCase()}]`;
                mediaUrl = media.url || null;
                console.log(`📎 Mídia recebida: ${type}`, { caption: content, url: mediaUrl });
            }

            // ✅ SALVAR NO BANCO PRIMEIRO
            const savedMessage = await Message.create({
                from: from, // ✅ JÁ NORMALIZADO
                direction: "inbound",
                type,
                content: content,
                mediaUrl: mediaUrl,
                status: "received",
                timestamp,
            });

            console.log('💾 Mensagem salva no banco:', {
                id: savedMessage._id,
                from: savedMessage.from,
                content: savedMessage.content,
                timestamp: savedMessage.timestamp
            });

            // 🔹 Emitir para o front via socket.io
            if (type === 'text') {
                console.log(`📤 Emitindo socket: whatsapp:new_message para ${from}`);
                io.emit('whatsapp:new_message', {
                    from: from, // ✅ JÁ NORMALIZADO
                    text: content,
                    timestamp: timestamp,
                    id: savedMessage._id
                });
            } else if (mediaUrl) {
                console.log(`📤 Emitindo socket: whatsapp:new_media para ${from}`);
                io.emit('whatsapp:new_media', {
                    from: from, // ✅ JÁ NORMALIZADO
                    type,
                    caption: content,
                    url: mediaUrl,
                    timestamp: timestamp,
                    id: savedMessage._id
                });
            }

        } catch (err) {
            console.error('❌ Erro no webhook WhatsApp:', err);
            console.error('🔧 Stack trace:', err.stack);
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
    }
};

