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
    async webhook(req, res) {
        try {
            const io = getIo();
            const entry = req.body.entry?.[0]?.changes?.[0]?.value;
            const msg = entry?.messages?.[0];

            // ⚡ Meta exige resposta imediata
            res.sendStatus(200);

            // --- [1] LOGA se chegou do WhatsApp
            console.log("\n====================== 🌐 WEBHOOK RECEBIDO ======================");
            console.log("🕐 Hora:", new Date().toLocaleString("pt-BR"));
            console.log("📩 Body bruto:", JSON.stringify(req.body, null, 2));

            if (!msg) {
                console.warn("⚠️ Nenhuma mensagem válida recebida.");
                return;
            }

            const from = msg.from;
            const type = msg.type;
            const timestamp = new Date(msg.timestamp * 1000);
            let content = "";

            console.log(`📥 Mensagem detectada de ${from} (${type})`);

            // --- [2] Detecta mídia ou texto
            if (type === "text") {
                content = msg.text?.body || "";
                console.log("💬 Conteúdo recebido:", content);

                // --- [3] Emite evento para front
                console.log("📡 Emitindo evento 'whatsapp:new_message' via Socket.IO...");
                io.emit("whatsapp:new_message", { from, text: content, timestamp });
                console.log("✅ Evento emitido para", io.engine.clientsCount, "clientes conectados");
            }

            const mediaTypes = ["image", "video", "audio", "document", "sticker"];
            if (mediaTypes.includes(type)) {
                const media = msg[type] || {};
                const caption = msg.caption || media.caption || "";
                content = caption || `[${type.toUpperCase()} RECEBIDO]`;

                console.log(`📎 Mídia recebida: ${type} (${media.mime_type})`);
                console.log("📡 Emitindo evento 'whatsapp:new_media' via Socket.IO...");
                io.emit("whatsapp:new_media", {
                    from,
                    type,
                    mime: media.mime_type,
                    id: media.id,
                    caption: content,
                    timestamp,
                });
                console.log("✅ Evento emitido para", io.engine.clientsCount, "clientes conectados");
            }

            // --- [4] Confirma persistência no banco
            await Message.create({
                from,
                to: process.env.PHONE_NUMBER_ID,
                direction: "inbound",
                type,
                content,
                status: "received",
                timestamp,
            });
            console.log("💾 Mensagem salva no banco com sucesso");

            // --- [5] Dispara IA / follow-up (sem await travando)
            handleWebhookEvent(req.body)
                .then(() => console.log("🤖 handleWebhookEvent executado com sucesso"))
                .catch((err) => console.error("❌ Erro no handleWebhookEvent:", err));

            console.log("=================================================================\n");
        } catch (err) {
            console.error("❌ Erro no webhook WhatsApp:", err);
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
