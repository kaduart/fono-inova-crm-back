// controllers/whatsappController.js - VERSÃO CORRIGIDA

import mongoose from 'mongoose';
import { redisConnection as redis } from '../config/redisConnection.js';
import { getIo } from "../config/socket.js";
import Contact from "../models/Contact.js";
import Followup from "../models/Followup.js";
import Lead from '../models/Leads.js';
import Message from "../models/Message.js";
import { describeWaImage, transcribeWaAudio } from "../services/aiAmandaService.js";
import { checkFollowupResponse } from "../services/responseTrackingService.js";
import { resolveMediaUrl, sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";
import getOptimizedAmandaResponse from '../utils/amandaOrchestrator.js';
import { normalizeE164BR } from "../utils/phone.js";
const AUTO_TEST_NUMBERS = [
    "5561981694922", "5561981694922", "556292013573", "5562992013573"
];

export const whatsappController = {

    async sendTemplate(req, res) {
        try {
            const { phone, template, params = [], leadId } = req.body;
            if (!phone || !template) {
                return res.status(400).json({ success: false, error: "Campos obrigatórios: phone e template" });
            }
            const to = normalizeE164BR(phone);
            const result = await sendTemplateMessage({ to, template, params, lead: leadId });

            const waMessageId = result?.waMessageId || result?.messages?.[0]?.id || null;

            const saved = await Message.create({
                from: process.env.CLINIC_PHONE_E164 || to,
                to,
                direction: "outbound",
                type: "template",
                content: `[TEMPLATE] ${template}`,
                templateName: template,
                status: "sent",
                timestamp: new Date(),
                lead: leadId || null,
                waMessageId,
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
            const {
                phone,
                text,
                leadId,
                userId = null,
                sentBy = 'manual',
            } = req.body;
            console.log('📩 [/api/whatsapp/send-text] body recebido:', req.body);
            if (!phone || !text) {
                return res.status(400).json({
                    success: false,
                    error: "Campos obrigatórios: phone e text"
                });
            }

            const to = normalizeE164BR(phone);

            // 🔎 Tenta achar Contact pelo telefone
            const contact = await Contact.findOne({ phone: to }).lean();

            // 🔎 Tenta achar Lead (ou pelo id, ou pelo telefone)
            let leadDoc = null;
            if (leadId) {
                leadDoc = await Lead.findById(leadId).lean();
            } else {
                leadDoc = await Lead.findOne({ 'contact.phone': to }).lean();
            }

            const resolvedLeadId = leadDoc?._id || leadId || null;
            const patientId = leadDoc?.convertedToPatient || null;

            console.log('📤 Enviando mensagem via service...', {
                to,
                lead: resolvedLeadId,
                contact: contact?._id,
                text: text.substring(0, 50)
            });

            // 📤 Envia usando o service centralizado
            const result = await sendTextMessage({
                to,
                text,
                lead: resolvedLeadId,
                contactId: contact?._id || null,
                patientId,
                sentBy,
                userId
            });

            console.log('✅ Service retornou:', result);

            // ✅ Busca a mensagem recém-salva - CORRIGIDO
            const waMessageId = result?.messages?.[0]?.id || null;

            // Espera 200ms para garantir que salvou
            await new Promise(resolve => setTimeout(resolve, 200));

            let saved = null;

            // 1ª tentativa: buscar pelo waMessageId
            if (waMessageId) {
                saved = await Message.findOne({ waMessageId }).lean();
                console.log('🔍 Busca por waMessageId:', saved ? 'ENCONTROU' : 'NÃO ACHOU');
            }

            // 2ª tentativa: buscar pela mensagem mais recente para este lead/telefone
            if (!saved && resolvedLeadId) {
                saved = await Message.findOne({
                    lead: resolvedLeadId,
                    direction: 'outbound',
                    type: 'text'
                }).sort({ timestamp: -1 }).lean();
                console.log('🔍 Busca por lead + outbound:', saved ? 'ENCONTROU' : 'NÃO ACHOU');
            }

            // 3ª tentativa: última mensagem outbound para este telefone
            if (!saved) {
                saved = await Message.findOne({
                    to,
                    direction: 'outbound',
                    type: 'text'
                }).sort({ timestamp: -1 }).lean();
                console.log('🔍 Busca por to + outbound:', saved ? 'ENCONTROU' : 'NÃO ACHOU');
            }

            console.log('📡 Mensagem encontrada para emitir?', saved ? 'SIM' : 'NÃO');

            if (saved) {
                console.log('📡 Dados da mensagem:', {
                    id: String(saved._id),
                    waMessageId: saved.waMessageId,
                    lead: saved.lead,
                    contact: saved.contact,
                    to: saved.to,
                    from: saved.from
                });
            }

            // 📡 Notifica o frontend via socket
            if (saved) {
                const io = getIo();
                console.log('📡 Emitindo message:new via socket...');

                io.emit("message:new", {
                    id: String(saved._id),
                    from: saved.from,
                    to: saved.to,
                    direction: saved.direction,
                    type: saved.type,
                    content: saved.content,
                    text: saved.content,
                    status: saved.status,
                    timestamp: saved.timestamp,
                    leadId: String(saved.lead || resolvedLeadId || ''),
                    contactId: String(saved.contact || contact?._id || ''),
                    metadata: saved.metadata || {
                        sentBy,
                        userId
                    }
                });

                console.log('✅ Socket emitido com sucesso!');
            } else {
                console.warn('⚠️ Mensagem não foi encontrada no banco para emitir socket!');
                console.warn('⚠️ waMessageId:', waMessageId);
                console.warn('⚠️ resolvedLeadId:', resolvedLeadId);
                console.warn('⚠️ to:', to);
            }

            res.json({
                success: true,
                result,
                messageId: saved?._id || null
            });
        } catch (err) {
            console.error("❌ Erro ao enviar texto WhatsApp:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async deletarMsgChat(req, res) {
        try {
            const { id } = req.params;

            console.log('🗑️ Recebendo requisição DELETE:', id);

            // Valida ObjectId
            if (!mongoose.Types.ObjectId.isValid(id)) {
                console.log('❌ ID inválido:', id);
                return res.status(400).json({
                    success: false,
                    error: 'ID inválido'
                });
            }

            // Busca a mensagem ANTES de deletar
            const message = await Message.findById(id);

            if (!message) {
                console.log('❌ Mensagem não encontrada:', id);
                return res.status(404).json({
                    success: false,
                    error: 'Mensagem não encontrada'
                });
            }

            console.log('📋 Mensagem encontrada:', {
                id: message._id,
                from: message.from,
                to: message.to,
                direction: message.direction,
                content: message.content?.substring(0, 50)
            });

            // ✅ Só permite deletar mensagens OUTBOUND (enviadas)
            if (message.direction !== 'outbound') {
                console.log('❌ Tentativa de deletar mensagem inbound:', message.direction);
                return res.status(403).json({
                    success: false,
                    error: 'Só é possível deletar mensagens enviadas'
                });
            }

            // Deleta do banco
            await Message.findByIdAndDelete(id);
            console.log('✅ Mensagem deletada do banco');

            // ✅ EMITE SOCKET para sincronizar
            try {
                const io = getIo();
                const payload = {
                    id: String(id),
                    from: message.from,
                    to: message.to
                };

                console.log('📡 Tentando emitir message:deleted via socket:', payload);

                io.emit('message:deleted', payload);

                console.log('✅ Socket message:deleted emitido com sucesso!');
            } catch (socketError) {
                console.error('❌ Erro ao emitir socket:', socketError);
            }

            res.json({
                success: true,
                message: 'Mensagem deletada com sucesso'
            });

        } catch (error) {
            console.error('❌ Erro ao deletar mensagem:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
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
        console.log("=========================== >>> 🔔MENSAGEM RECEBIDA DE CLIENTE <<< ===========================", new Date().toISOString());

        try {
            const change = req.body.entry?.[0]?.changes?.[0];
            const value = change?.value;

            // ✅ RESPONDE IMEDIATAMENTE
            res.sendStatus(200);

            if (!value?.messages || !Array.isArray(value.messages) || !value.messages[0]) {
                console.log("🔔 Webhook recebido, mas não é mensagem");
                return;
            }

            const msg = value.messages[0];
            const wamid = msg.id;
            const fromRaw = msg.from || "";

            console.log("📨 INBOUND RECEBIDO:", {
                wamid,
                from: fromRaw,
                type: msg.type,
                timestamp: new Date().toISOString()
            });

            // ✅ DEDUPLICAÇÃO
            let isDuplicate = false;
            try {
                if (redis?.set) {
                    const seenKey = `wa:seen:${wamid}`;
                    const ok = await redis.set(seenKey, "1", "EX", 300, "NX");
                    if (ok !== "OK") {
                        console.log("⏭️ Mensagem duplicada, ignorando:", wamid);
                        isDuplicate = true;
                    }
                }
            } catch (e) {
                console.warn("⚠️ Redis indisponível, continuando sem dedup:", e.message);
            }

            if (isDuplicate) return;

            // ✅ CHAMA PROCESSAMENTO DIRETO (sem this)
            await processInboundMessage(msg, value);

        } catch (err) {
            console.error("❌ Erro crítico no webhook:", err);
        }
    },

    async listContacts(req, res) {
        try {
            const {
                page = 1,
                limit = 50,
                search = ''
            } = req.query;

            const skip = (parseInt(page) - 1) * parseInt(limit);
            const limitNum = Math.min(parseInt(limit), 100);

            const filter = {};
            if (search) {
                filter.$or = [
                    { name: { $regex: search, $options: 'i' } },
                    { phone: { $regex: search } }
                ];
            }

            const [contacts, total] = await Promise.all([
                Contact.find(filter)
                    .select('_id name phone avatar lastMessageAt lastMessage hasNewMessage unreadCount')
                    .sort({ lastMessageAt: -1, name: 1 })
                    .skip(skip)
                    .limit(limitNum)
                    .lean(),
                Contact.countDocuments(filter)
            ]);

            res.json({
                success: true,
                data: contacts,
                pagination: {
                    page: parseInt(page),
                    limit: limitNum,
                    total,
                    hasMore: skip + contacts.length < total
                }
            });
        } catch (err) {
            console.error("❌ Erro ao listar contatos:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async getChat(req, res) {
        try {
            const { phone } = req.params;
            const { limit = 50, before } = req.query;

            if (!phone) {
                return res.status(400).json({ error: "Número de telefone é obrigatório" });
            }

            const pE164 = normalizeE164BR(phone);
            const numeric = pE164.replace(/\D/g, '');
            const limitNum = Math.min(parseInt(limit), 100);

            // Query otimizada com $in ao invés de múltiplos $or
            const phoneVariants = [pE164, numeric, `+${numeric}`];

            const filter = {
                $or: [
                    { from: { $in: phoneVariants } },
                    { to: { $in: phoneVariants } }
                ]
            };

            // Paginação por cursor
            if (before) {
                filter.timestamp = { $lt: new Date(before) };
            }

            const msgs = await Message.find(filter)
                .select('_id from to content text type timestamp direction status mediaUrl mediaId caption')
                .sort({ timestamp: before ? -1 : -1 })
                .limit(limitNum)
                .lean();

            // Ordena cronologicamente
            msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            return res.json({
                success: true,
                data: msgs,
                hasMore: msgs.length === limitNum
            });
        } catch (err) {
            console.error("❌ Erro ao buscar chat:", err);
            return res.status(500).json({ error: err.message });
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

    async sendManualMessage(req, res) {
        try {
            const { leadId, text, userId, phone } = req.body;

            let lead = null;

            if (leadId) {
                // fluxo antigo: já tenho o lead
                lead = await Lead.findById(leadId).populate('contact');
            }

            let normalizedPhone = null;

            if (lead?.contact?.phone) {
                normalizedPhone = normalizeE164BR(
                    lead.contact.phone ||
                    lead.contact.phoneWhatsapp ||
                    lead.contact.phoneNumber ||
                    ''
                );
            } else if (phone) {
                // sem leadId, resolve pelo telefone
                normalizedPhone = normalizeE164BR(phone);
                lead = await Lead.findOne({ 'contact.phone': normalizedPhone }).populate('contact');
            }

            if (!lead) {
                return res.status(404).json({
                    success: false,
                    message: 'Lead não encontrado para esse envio manual'
                });
            }

            // 🔎 Contact de chat (coleção Contact) pelo telefone do lead
            const chatPhone = normalizeE164BR(
                lead.contact?.phone ||
                lead.contact?.phoneWhatsapp ||
                lead.contact?.phoneNumber ||
                normalizedPhone ||
                ''
            );

            const contact = await Contact.findOne({ phone: chatPhone }).lean();
            const patientId = lead.convertedToPatient || null;

            // 📤 Envia mensagem via service centralizado
            const result = await sendTextMessage({
                to: chatPhone,
                text,
                lead: lead._id,
                contactId: contact?._id || null,
                patientId,
                sentBy: 'manual',
                userId
            });

            // 🔁 Localiza mensagem persistida pra emitir no socket
            const waMessageId = result?.messages?.[0]?.id || null;
            if (waMessageId) {
                const saved = await Message.findOne({ waMessageId }).lean();
                if (saved) {
                    const io = getIo();
                    io.emit("message:new", {
                        id: String(saved._id),
                        from: saved.from,
                        to: saved.to,
                        direction: saved.direction,
                        type: saved.type,
                        content: saved.content,
                        status: saved.status,
                        timestamp: saved.timestamp,
                        leadId: saved.lead || lead._id,
                        contactId: saved.contact || (contact?._id || null),
                        metadata: saved.metadata || {
                            sentBy: 'manual',
                            userId
                        }
                    });
                }
            }

            // 🧠 Ativa controle manual (Amanda PAUSADA)
            await Lead.findByIdAndUpdate(lead._id, {
                'manualControl.active': true,
                'manualControl.takenOverAt': new Date(),
                'manualControl.takenOverBy': userId
            });

            console.log(`✅ Mensagem manual enviada - Amanda pausada para o lead ${lead._id}`);

            res.json({
                success: true,
                message: 'Mensagem enviada. Amanda pausada.',
                messageId: waMessageId || `manual-${Date.now()}`
            });

        } catch (error) {
            console.error("❌ Erro em sendManualMessage:", error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

};

// ✅ FUNÇÃO SEPARADA (não depende do this)
async function processInboundMessage(msg, value) {
    try {
        const io = getIo();
        const wamid = msg.id;
        const fromRaw = msg.from || "";
        const toRaw = value?.metadata?.display_phone_number || process.env.CLINIC_PHONE_E164 || "";

        const from = normalizeE164BR(fromRaw);
        const to = normalizeE164BR(toRaw);
        const type = msg.type;
        const fromNumeric = from.replace(/\D/g, '');
        const isTestNumber = AUTO_TEST_NUMBERS.includes(fromNumeric);

        console.log("🔎 isTestNumber?", fromNumeric, isTestNumber);


        const timestamp = new Date((parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000);

        console.log("🔄 Processando mensagem:", { from, type, wamid });

        // EXTRAÇÃO DE CONTEÚDO
        let content = "";
        let mediaUrl = null;
        let caption = null;
        let mediaId = null;

        if (type === "text") {
            // 💬 Texto normal
            content = msg.text?.body || "";
        } else if (type === "audio" && msg.audio?.id) {
            // 🎙️ ÁUDIO → transcrever
            mediaId = msg.audio.id;
            caption = "[AUDIO]";

            try {
                // Opcional: ainda resolve URL para uso no front/proxy
                const { url } = await resolveMediaUrl(mediaId);
                mediaUrl = url;
            } catch (e) {
                console.error("⚠️ Falha ao resolver mídia (audio):", e.message);
            }

            console.log(`🎙️ Processando áudio para transcrição: ${mediaId}`);

            // 🔹 TRANSCRIÇÃO
            content = await transcribeWaAudio(mediaId, `audio_${wamid}.ogg`);

            if (!content || content.length < 3) {
                content = "[Áudio não pôde ser transcrito]";
            }
        } else if (type === "image" && msg.image?.id) {
            // 🖼️ IMAGEM → descrição + legenda
            mediaId = msg.image.id;
            caption = (msg.image.caption || "").trim();

            // URL para o front / proxy
            try {
                const { url } = await resolveMediaUrl(mediaId);
                mediaUrl = url;
            } catch (e) {
                console.error("⚠️ Falha ao resolver mídia (image):", e.message);
            }

            try {
                console.log(`🖼️ Gerando descrição para imagem: ${mediaId}`);
                const description = await describeWaImage(mediaId, caption);

                if (caption) {
                    // legenda + descrição → vira texto rico pra Amanda
                    content = `${caption}\n[Detalhe da imagem: ${description}]`;
                } else {
                    content = `Imagem enviada: ${description}`;
                }
            } catch (e) {
                console.error("⚠️ Falha ao descrever imagem:", e.message);
                // fallback: pelo menos algo textual
                content = caption || "Imagem recebida.";
            }
        } else {
            // 🎥 📄 😀 VÍDEO / DOCUMENTO / STICKER (mantém como marcador)
            try {
                if (type === "video" && msg.video?.id) {
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
                console.error("⚠️ Falha ao resolver mídia:", e.message);
            }
        }

        // 🔹 Agora: TEXT, AUDIO e IMAGE usam `content` (texto "de verdade")
        const contentToSave =
            (type === "text" || type === "audio" || type === "image")
                ? content
                : (caption || `[${type.toUpperCase()}]`);



        // ✅ BUSCA UNIFICADA INTELIGENTE
        console.log("🔍 Buscando contact para:", from);
        let contact = await Contact.findOne({ phone: from });
        if (!contact) {
            contact = await Contact.create({
                phone: from,
                name: msg.profile?.name || "Contato WhatsApp"
            });
            console.log("✅ Novo contact criado:", contact._id);
        }

        console.log("🔍 Buscando lead para:", from);
        let lead = await Lead.findOne({ 'contact.phone': from });

        // ✅ VERIFICA SE EXISTE PATIENT COM ESTE TELEFONE
        let patient = null;
        try {
            patient = await mongoose.model('Patient').findOne({ phone: from });
            console.log("🔍 Patient encontrado:", patient ? patient._id : "Nenhum");
        } catch (e) {
            console.log("ℹ️ Model Patient não disponível");
        }

        if (!lead) {
            // 🎯 DECISÃO INTELIGENTE: Se tem patient, cria lead vinculado
            if (patient) {
                const leadData = {
                    name: patient.fullName || contact.name,
                    contact: {
                        phone: from,
                        email: patient.email || null
                    },
                    origin: "WhatsApp",
                    status: "virou_paciente",
                    convertedToPatient: patient._id,
                    conversionScore: 100,
                    appointment: {
                        seekingFor: "Adulto +18 anos",
                        modality: "Online",
                        healthPlan: "Mensalidade"
                    },
                    circuit: "Circuito Padrão",
                    responded: false,
                    conversationSummary: null,
                    summaryGeneratedAt: null,
                    summaryCoversUntilMessage: 0,
                    autoReplyEnabled: true,
                    manualControl: isTestNumber
                        ? { active: false, autoResumeAfter: 0 }  // 🧪 teste: sem espera
                        : { active: false, autoResumeAfter: 30 },
                    interactions: [],
                    scoreHistory: [],
                    lastInteractionAt: new Date()
                };

                // ✅ USA insertMany (bypass Mongoose bug)
                const [createdLead] = await Lead.insertMany([leadData], { rawResult: false });
                lead = createdLead;
                console.log("🔄 Patient convertido em lead:", lead._id);
            } else {
                // Cria novo lead normal
                const leadData = {
                    name: contact.name,
                    contact: { phone: from },
                    origin: "WhatsApp",
                    status: "novo",
                    appointment: {
                        seekingFor: "Adulto +18 anos",
                        modality: "Online",
                        healthPlan: "Mensalidade"
                    },
                    circuit: "Circuito Padrão",
                    conversionScore: 0,
                    responded: false,
                    conversationSummary: null,
                    summaryGeneratedAt: null,
                    summaryCoversUntilMessage: 0,
                    autoReplyEnabled: true,
                    manualControl: isTestNumber
                        ? { active: false, autoResumeAfter: 0 }  // 🧪 teste: sem espera
                        : { active: false, autoResumeAfter: 30 },
                    interactions: [],
                    scoreHistory: [],
                    lastInteractionAt: new Date()
                };

                // ✅ USA insertMany (bypass Mongoose bug)
                const [createdLead] = await Lead.insertMany([leadData], { rawResult: false });
                lead = createdLead;
                console.log("✅ Novo lead criado:", lead._id);
            }
        }

        // 🧪 Se for número de teste, sempre garantir que NÃO esteja em manual
        if (isTestNumber && lead) {
            await Lead.findByIdAndUpdate(lead._id, {
                $set: {
                    'manualControl.active': false,
                    'manualControl.takenOverAt': null,
                    'manualControl.takenOverBy': null,
                    'manualControl.autoResumeAfter': 0,
                    autoReplyEnabled: true,
                }
            });
            lead.manualControl = { active: false, autoResumeAfter: 0 };
            lead.autoReplyEnabled = true;

            console.log("🧪 Lead de teste destravado de controle manual:", String(lead._id));
        }

        // ✅ SALVAR MENSAGEM NO CRM
        const savedMessage = await Message.create({
            wamid,
            from,
            to,
            direction: "inbound",
            type,
            content: contentToSave,
            mediaUrl,
            mediaId,
            caption,
            status: "received",
            // 🔹 Só marca como "precisa revisão" se NÃO for texto, áudio transcrito ou imagem descrita
            needs_human_review: !(type === "text" || type === "audio" || type === "image"),
            timestamp,
            contact: contact._id,
            lead: lead._id,
            raw: msg,
        });


        try {
            contact.lastMessageAt = timestamp;
            await contact.save();
        } catch (e) {
            console.error("⚠️ Erro ao atualizar lastMessageAt no Contact:", e.message);
        }
        console.log("💾 Mensagem salva no CRM:", {
            id: savedMessage._id,
            lead: lead._id,
            contact: contact._id,
            patient: patient?._id || "Nenhum",
            content: contentToSave.substring(0, 50) + '...'
        });

        // ✅ NOTIFICAR FRONTEND
        io.emit("message:new", {
            id: String(savedMessage._id),
            from,
            to,
            direction: "inbound",
            type,
            content: contentToSave,
            text: contentToSave,
            mediaUrl,
            mediaId,
            caption,
            status: "received",
            timestamp,
            leadId: lead._id,
            contactId: contact._id
        });

        // ✅ ATUALIZAR ÚLTIMA INTERAÇÃO DO LEAD
        try {
            lead.lastInteractionAt = new Date();
            lead.interactions.push({
                date: new Date(),
                channel: 'whatsapp',
                direction: 'inbound',
                message: contentToSave,
                status: 'received'
            });
            await lead.save();
            console.log("📅 Interação atualizada no lead");
        } catch (updateError) {
            console.error("⚠️ Erro ao atualizar interação:", updateError.message);
        }

        const isRealText = contentToSave?.trim() && !contentToSave.startsWith("[");

        // ✅ AMANDA 2.0 TRACKING (texto, áudio transcrito ou imagem descrita)
        if ((type === 'text' || type === 'audio' || type === 'image') && isRealText) {
            handleResponseTracking(lead._id, contentToSave)
                .catch(err => console.error("⚠️ Tracking não crítico falhou:", err));
        }

        // ✅ RESPOSTA AUTOMÁTICA (Amanda) para texto, áudio transcrito ou imagem descrita
        if ((type === "text" || type === "audio" || type === "image") && isRealText) {
            handleAutoReply(from, to, contentToSave, lead)
                .catch(err => console.error("⚠️ Auto-reply não crítico falhou:", err));
        }

        // 🔥 AUTO-AGENDADOR DE FOLLOW-UP (Amanda 2.0)
        try {
            const freshLead = await Lead.findById(lead._id).lean();

            const autoReplyOn = freshLead?.autoReplyEnabled !== false;
            const manualActive = freshLead?.manualControl?.active === true;

            if (autoReplyOn && !manualActive) {
                // Evita duplicar: follow-up futuro já agendado
                const existing = await Followup.findOne({
                    lead: freshLead._id,
                    status: { $in: ["scheduled", "processing"] },
                    scheduledAt: { $gte: new Date() },
                }).lean();

                if (!existing) {
                    await createSmartFollowupForLead(freshLead._id, {
                        explicitScheduledAt: null, // deixa a Amanda decidir o melhor horário
                        objective: "reengajamento_inbound",
                        attempt: 1,
                    });

                    console.log("💚🤍 Follow-up inteligente auto-agendado via Amanda 2.0:", {
                        leadId: String(freshLead._id),
                    });
                } else {
                    console.log(
                        "ℹ️ Já existe follow-up futuro para este lead, não vou duplicar:",
                        {
                            leadId: String(freshLead._id),
                            followupId: String(existing._id),
                            status: existing.status,
                            scheduledAt: existing.scheduledAt,
                        }
                    );
                }
            } else {
                console.log(
                    "ℹ️ Auto follow-up ignorado (manualControl ativo ou autoReply desativado)."
                );
            }
        } catch (autoFuError) {
            console.error(
                "⚠️ Erro ao auto-agendar follow-up via inbound WhatsApp (não crítico):",
                autoFuError.message
            );
        }


        console.log("✅ Mensagem processada com sucesso:", wamid);

    } catch (error) {
        console.error("❌ Erro CRÍTICO no processInboundMessage:", error);
    }
}

// ✅ FUNÇÕES AUXILIARES SEPARADAS
async function handleResponseTracking(leadId, content) {
    try {
        const lastFollowup = await Followup.findOne({
            lead: leadId,
            status: 'sent',
            responded: false
        }).sort({ sentAt: -1 }).lean();

        if (lastFollowup) {
            const timeSince = Date.now() - new Date(lastFollowup.sentAt).getTime();
            const WINDOW_72H = 72 * 60 * 60 * 1000;

            if (timeSince < WINDOW_72H) {
                console.log(`✅ Lead respondeu a follow-up! Processando...`);
                await checkFollowupResponse(lastFollowup._id);
            }
        }
    } catch (error) {
        console.error('❌ Erro no tracking (não crítico):', error.message);
    }
}

// ✅ FUNÇÃO CORRIGIDA COM CONTROLE MANUAL
async function handleAutoReply(from, to, content, lead) {
    try {
        console.log('🤖 [AUTO-REPLY] Iniciando para', { from, to, leadId: lead?._id, content });

        const fromNumeric = from.replace(/\D/g, '');
        const isTestNumber = AUTO_TEST_NUMBERS.includes(fromNumeric);

        // ================================
        // 1. LOCK anti-corrida (3s)
        // ================================
        let canProceed = true;
        try {
            if (redis?.set) {
                const lockKey = `ai:lock:${from}`;
                const ok = await redis.set(lockKey, "1", "EX", 10, "NX");
                if (ok !== "OK") {
                    console.log("⏭️ AI lock ativo; evitando corrida", lockKey);
                    canProceed = false;
                }
            }
        } catch (lockError) {
            console.warn("⚠️ Redis lock indisponível:", lockError.message);
        }

        if (!canProceed) return;

        // ================================
        // 2. Evita resposta duplicada (5s)
        // ================================
        const fiveSecondsAgo = new Date(Date.now() - 5 * 1000);
        const veryRecentReply = await Message.findOne({
            to: from,
            direction: "outbound",
            type: "text",
            timestamp: { $gte: fiveSecondsAgo },
        }).lean();

        if (veryRecentReply) {
            console.log("⏭️ Resposta enviada há menos de 5s; evitando duplicação.");
            return;
        }

        // ================================
        // 3. Debounce (3s)
        // ================================
        try {
            if (redis?.set) {
                const key = `ai:debounce:${from}`;
                const ok = await redis.set(key, "1", "EX", 10, "NX");
                if (ok !== "OK") {
                    console.log("⏭️ Debounce ativo (3s); pulando auto-reply");
                    return;
                }
            }
        } catch (debounceError) {
            console.warn("⚠️ Redis debounce indisponível:", debounceError.message);
        }

        // ================================
        // 4. Busca lead completo do banco
        // ================================
        const leadDoc = await Lead.findById(lead._id).lean();
        if (!leadDoc) {
            console.log("⚠️ Lead não encontrado em handleAutoReply:", lead?._id);
            return;
        }

        // ================================
        // 5. Controle manual (human takeover)
        // ================================
        if (!isTestNumber && leadDoc.manualControl?.active) {
            console.log('👤 [CONTROLE MANUAL] Ativo para lead:', leadDoc._id, '-', leadDoc.name);

            const takenAt = leadDoc.manualControl.takenOverAt
                ? new Date(leadDoc.manualControl.takenOverAt)
                : null;

            const timeout = leadDoc.manualControl.autoResumeAfter || 30; // minutos
            let aindaPausada = true;

            if (takenAt) {
                const minutesSince = (Date.now() - takenAt.getTime()) / (1000 * 60);
                console.log(`⏱️ Tempo desde takeover: ${minutesSince.toFixed(1)}min / Timeout: ${timeout}min`);

                if (minutesSince > timeout) {
                    console.log(`⏰ Timeout de ${timeout}min atingido - RETOMANDO Amanda`);

                    await Lead.findByIdAndUpdate(leadDoc._id, {
                        'manualControl.active': false
                    });

                    console.log('✅ Amanda retomou atendimento automaticamente');
                    aindaPausada = false;
                }
            }

            if (aindaPausada) {
                console.log('⏸️ Amanda PAUSADA - humano no controle. Não responderei por IA.');
                return;
            }
        } else if (isTestNumber) {
            console.log('🧪 Número de teste → ignorando controle manual, Amanda sempre ativa.');
        }

        // ================================
        // 6. Flag geral de autoReply
        // ================================
        if (leadDoc.autoReplyEnabled === false) {
            console.log('⛔ autoReplyEnabled = false para lead', leadDoc._id, '- Amanda desativada.');
            return;
        }

        // ================================
        // 7. Histórico para contexto básico
        // (enrichLeadContext faz o resto lá no orquestrador)
        // ================================
        const histDocs = await Message.find({
            $or: [{ from }, { to: from }],
            type: "text",
        }).sort({ timestamp: -1 }).limit(12).lean();

        const lastMessages = histDocs.reverse().map(m => (m.content || m.text || "").toString());
        const greetings = /^(oi|ol[aá]|boa\s*(tarde|noite|dia)|tudo\s*bem|bom\s*dia|fala|e[aíi])[\s!,.]*$/i;
        const isFirstContact = lastMessages.length <= 1 || greetings.test(content.trim());

        // ================================
        // 8. Gera resposta da Amanda (orquestrador já usa enrichLeadContext)
        // ================================
        console.log('🤖 Gerando resposta da Amanda...');

        const aiText = await getOptimizedAmandaResponse({
            content,
            userText: content,
            lead: {
                _id: leadDoc._id,
                name: leadDoc?.name || "",
                reason: leadDoc?.reason || "avaliação/terapia",
                origin: leadDoc?.origin || "WhatsApp",
            },
            // context hoje não é usado, mas deixa se quiser evoluir depois
            context: { lastMessages, isFirstContact },
        });

        console.log("[AmandaReply] Texto gerado:", aiText ? aiText.substring(0, 80) + '...' : 'vazio');

        // ================================
        // 9. Envia resposta marcada como "amanda"
        // ================================
        if (aiText && aiText.trim()) {
            const finalText = aiText.trim();

            // 🔎 Tenta achar o contact pra vincular na mensagem
            const contactDoc = await Contact.findOne({ phone: from }).lean();
            const patientId = leadDoc.convertedToPatient || null;

            // 📤 Envia e REGISTRA (sendTextMessage + registerMessage)
            const result = await sendTextMessage({
                to: from,
                text: finalText,
                lead: leadDoc._id,
                contactId: contactDoc?._id || null,
                patientId,
                sentBy: 'amanda'
            });

            const waMessageId = result?.messages?.[0]?.id || null;

            // Dá um respiro pro Mongo gravar
            await new Promise(resolve => setTimeout(resolve, 200));

            // 🔍 Busca a mensagem salva pelo waMessageId
            let savedOut = null;
            if (waMessageId) {
                savedOut = await Message.findOne({ waMessageId }).lean();
                console.log('🔍 Busca Amanda por waMessageId:', savedOut ? 'ENCONTROU' : 'NÃO ACHOU');
            }

            // Fallback: última outbound para esse número
            if (!savedOut) {
                savedOut = await Message.findOne({
                    to: from,
                    direction: "outbound",
                    type: "text"
                }).sort({ timestamp: -1 }).lean();
                console.log('🔍 Busca Amanda por to + outbound:', savedOut ? 'ENCONTROU' : 'NÃO ACHOU');
            }

            if (savedOut) {
                const io = getIo();
                io.emit("message:new", {
                    id: String(savedOut._id),
                    from: savedOut.from,
                    to: savedOut.to,
                    direction: savedOut.direction,
                    type: savedOut.type,
                    content: savedOut.content,
                    text: savedOut.content,
                    status: savedOut.status,
                    timestamp: savedOut.timestamp,
                    leadId: String(savedOut.lead || leadDoc._id),
                    contactId: String(savedOut.contact || contactDoc?._id || ''),
                    metadata: savedOut.metadata || {
                        sentBy: 'amanda'
                    }
                });

                console.log("✅ Amanda respondeu e emitiu via socket:", String(savedOut._id));
            } else {
                console.warn('⚠️ Não achei a mensagem da Amanda no banco pra emitir socket');
            }
        }
    } catch (error) {
        console.error('❌ Erro no auto-reply (não crítico):', error);
    }
}
