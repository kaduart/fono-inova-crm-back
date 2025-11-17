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
                from: process.env.CLINIC_PHONE_E164 || to,
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
            const {
                phone,
                text,
                leadId,
                userId = null,
                sentBy = 'manual', // padrão: humano mandando do CRM
            } = req.body;

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

            // 🔁 Localiza a mensagem que o service acabou de registrar
            const waMessageId = result?.messages?.[0]?.id || null;
            let saved = null;

            if (waMessageId) {
                saved = await Message.findOne({ waMessageId }).lean();
            }

            // 📡 Notifica o frontend via socket, se achou a mensagem
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
                    leadId: saved.lead || resolvedLeadId,
                    contactId: saved.contact || (contact?._id || null),
                    metadata: saved.metadata || {
                        sentBy,
                        userId
                    }
                });
            }

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

    async getChat(req, res) {
        try {
            const { phone } = req.params;
            if (!phone) return res.status(400).json({ error: "Número de telefone é obrigatório" });

            const pE164 = normalizeE164BR(phone);
            let msgs = await Message.find({
                $or: [{ from: pE164 }, { to: pE164 }],
            }).sort({ timestamp: 1 });

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
            const contacts = await Contact.find()
                .sort({ lastMessageAt: -1, name: 1 }); // 🆕 mais recente primeiro
            res.json(contacts);
        } catch (err) {
            console.error("❌ Erro ao listar contatos:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async listContacts(_req, res) {
        try {
            const contacts = await Contact.find()
                .sort({ lastMessageAt: -1, name: 1 }); // 🆕 mais recente primeiro
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

   async sendManualMessage(req, res) {
    try {
        const { leadId, text, userId } = req.body;

        const lead = await Lead.findById(leadId).populate('contact');

        if (!lead) {
            return res.status(404).json({
                success: false,
                message: 'Lead não encontrado'
            });
        }

        // 🔎 Contact de chat (coleção Contact) pelo telefone do lead
        const normalizedPhone = normalizeE164BR(
            lead.contact?.phone || lead.contact?.phoneWhatsapp || lead.contact?.phoneNumber || ''
        );

        const contact = await Contact.findOne({ phone: normalizedPhone }).lean();
        const patientId = lead.convertedToPatient || null;

        // 📤 Envia mensagem via service centralizado
        const result = await sendTextMessage({
            to: normalizedPhone,
            text,
            lead: leadId,
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
                    leadId: saved.lead || leadId,
                    contactId: saved.contact || (contact?._id || null),
                    metadata: saved.metadata || {
                        sentBy: 'manual',
                        userId
                    }
                });
            }
        }

        // 🧠 Ativa controle manual (Amanda PAUSADA)
        await Lead.findByIdAndUpdate(leadId, {
            'manualControl.active': true,
            'manualControl.takenOverAt': new Date(),
            'manualControl.takenOverBy': userId
        });

        console.log(`✅ Mensagem manual enviada - Amanda pausada para o lead ${leadId}`);

        res.json({
            success: true,
            message: 'Mensagem enviada. Amanda pausada.',
            messageId: result.messages?.[0]?.id || `manual-${Date.now()}`
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
                lead = await Lead.create({
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
                    }
                });
                console.log("🔄 Patient convertido em lead:", lead._id);
            } else {
                // Cria novo lead normal
                lead = await Lead.create({
                    name: contact.name,
                    contact: { phone: from },
                    origin: "WhatsApp",
                    status: "novo",
                    appointment: {
                        seekingFor: "Adulto +18 anos",
                        modality: "Online",
                        healthPlan: "Mensalidade"
                    }
                });
                console.log("✅ Novo lead criado:", lead._id);
            }
        } else {
            console.log("✅ Lead existente encontrado:", lead._id);

            // ✅ ATUALIZA lead se encontrou patient
            if (patient && !lead.convertedToPatient) {
                lead.convertedToPatient = patient._id;
                lead.status = "virou_paciente";
                lead.conversionScore = 100;
                await lead.save();
                console.log("🔄 Lead atualizado com patient:", patient._id);
            }
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
        // ================================
        // 1. LOCK anti-corrida (3s)
        // ================================
        let canProceed = true;
        try {
            if (redis?.set) {
                const lockKey = `ai:lock:${from}`;
                const ok = await redis.set(lockKey, "1", "EX", 3, "NX");
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
                const ok = await redis.set(key, "1", "EX", 3, "NX");
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
        if (leadDoc.manualControl?.active) {
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
                    // ⏰ Passou do tempo → liberar Amanda
                    console.log(`⏰ Timeout de ${timeout}min atingido - RETOMANDO Amanda`);

                    await Lead.findByIdAndUpdate(leadDoc._id, {
                        'manualControl.active': false
                    });

                    console.log('✅ Amanda retomou atendimento automaticamente');
                    aindaPausada = false;
                }
            }

            // Se não tinha takenOverAt ou ainda não passou do tempo, mantém pausada
            if (aindaPausada) {
                console.log('⏸️ Amanda PAUSADA - humano no controle. Não responderei por IA.');
                console.log(`💡 Para reativar antes do tempo: POST /api/lead-control/${leadDoc._id}/resume-amanda`);
                return; // ❌ NADA de IA aqui
            }
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

            await sendTextMessage({
                to: from,
                text: finalText,
                lead: leadDoc._id,
                sentBy: 'amanda'
            });

            const savedOut = await Message.create({
                from: to,
                to: from,
                direction: "outbound",
                type: "text",
                content: finalText,
                status: "sent",
                timestamp: new Date(),
                lead: leadDoc._id,
                metadata: {
                    sentBy: 'amanda'
                }
            });

            const io = getIo();
            io.emit("message:new", {
                id: String(savedOut._id),
                from: savedOut.from,
                to: savedOut.to,
                direction: "outbound",
                type: "text",
                content: savedOut.content,
                status: savedOut.status,
                timestamp: savedOut.timestamp,
                sentBy: 'amanda'
            });

            console.log("✅ Amanda respondeu e enviou:", String(savedOut._id));
        }

    } catch (error) {
        console.error('❌ Erro no auto-reply (não crítico):', error);
    }
}
