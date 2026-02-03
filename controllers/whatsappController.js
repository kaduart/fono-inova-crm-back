// controllers/whatsappController.js - VERSÃO CORRIGIDA

import mongoose from 'mongoose';
import { redisConnection as redis } from '../config/redisConnection.js';
import { getIo } from "../config/socket.js";
import Contacts from '../models/Contacts.js';
import Followup from "../models/Followup.js";
import Lead from '../models/Leads.js';
import Message from "../models/Message.js";
import Patient from '../models/Patient.js';
import { WhatsAppOrchestrator } from '../orchestrators/WhatsAppOrchestrator.js';
import { describeWaImage, transcribeWaAudio } from "../services/aiAmandaService.js";
import * as bookingService from '../services/amandaBookingService.js';
import { createSmartFollowupForLead } from "../services/followupOrchestrator.js";
import { analyzeLeadMessage } from '../services/intelligence/leadIntelligence.js';
import { checkFollowupResponse } from "../services/responseTrackingService.js";
import Logger from '../services/utils/Logger.js';
import { resolveMediaUrl, sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";

import { mapFlagsToBookingProduct } from '../utils/bookingProductMapper.js';
import { deriveFlagsFromText } from "../utils/flagsDetector.js";
import { normalizeE164BR } from "../utils/phone.js";
import { resolveLeadByPhone } from './leadController.js';

const AUTO_TEST_NUMBERS = [
    "5561981694922", "5561981694922", "556292013573", "5562992013573"
];

const logger = new Logger('whatsappController');
const orchestrator = new WhatsAppOrchestrator();

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
                text: saved.content,
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
            const contact = await Contacts.findOne({ phone: to }).lean();

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
                saved = await Message.create({
                    waMessageId,
                    from: process.env.CLINIC_PHONE_E164,
                    to,
                    direction: "outbound",
                    type: "text",
                    content: text,
                    status: "sent",
                    timestamp: new Date(),
                    lead: resolvedLeadId,
                    contact: contact?._id,
                    patient: patientId,
                    metadata: { sentBy, userId },
                });
                console.log('🔍 Busca por to + outbound:', saved ? 'ENCONTROU' : 'NÃO ACHOU');

                return { ...result, savedMessage: saved };
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
        console.log('chamoiu contactssss')
        try {
            const page = Math.max(parseInt(req.query.page || "1", 10), 1);
            const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
            const search = (req.query.search || "").trim();
            const skip = (page - 1) * limit;

            const filter = {};
            if (search) {
                filter.$or = [
                    { name: { $regex: search, $options: "i" } },
                    { phone: { $regex: search } }
                ];
            }

            const pipeline = [
                {
                    $match: {
                        ...filter,
                        phone: { $regex: /^\d+$/ }
                    }
                },

                { $sort: { lastMessageAt: -1, name: 1 } },
                { $skip: skip },
                { $limit: limit },

                {
                    $lookup: {
                        from: "leads",
                        let: { contactPhone: "$phone" },
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $and: [
                                            { $ne: ["$contact.phone", null] },
                                            { $ne: ["$contact.phone", ""] },
                                            { $eq: ["$contact.phone", "$$contactPhone"] }
                                        ]
                                    }
                                }
                            },
                            { $sort: { updatedAt: -1 } },
                            { $limit: 1 },
                            {
                                $project: {
                                    _id: 1,
                                    manualActive: "$manualControl.active",
                                    autoReplyEnabled: 1
                                }
                            }
                        ],
                        as: "leadMatches"
                    }
                },

                {
                    $addFields: {
                        leadId: {
                            $cond: {
                                if: { $gt: [{ $size: "$leadMatches" }, 0] },
                                then: { $arrayElemAt: ["$leadMatches._id", 0] },
                                else: null
                            }
                        },
                        manualActive: {
                            $cond: {
                                if: { $gt: [{ $size: "$leadMatches" }, 0] },
                                then: { $ifNull: [{ $arrayElemAt: ["$leadMatches.manualActive", 0] }, false] },
                                else: false
                            }
                        },
                        autoReplyEnabled: {
                            $cond: {
                                if: { $gt: [{ $size: "$leadMatches" }, 0] },
                                then: { $ifNull: [{ $arrayElemAt: ["$leadMatches.autoReplyEnabled", 0] }, true] },
                                else: true
                            }
                        }
                    }
                },
                {
                    $project: {
                        leadMatches: 0
                    }
                }
            ];

            const [rawData, total] = await Promise.all([
                Contacts.aggregate(pipeline),
                Contacts.countDocuments({
                    ...filter,
                    phone: { $regex: /^\d+$/ }
                })
            ]);

            // ✅ SERIALIZA ObjectIds pra STRING
            const data = rawData.map(contact => ({
                _id: String(contact._id),
                phone: contact.phone,
                name: contact.name,
                lastMessageAt: contact.lastMessageAt,
                lastMessagePreview: contact.lastMessagePreview || null,
                lastMessage: contact.lastMessagePreview || null, leadId: contact.leadId ? String(contact.leadId) : null,
                // ✅ inclua outros campos que você precisa
                tags: contact.tags || [],
                phoneE164: contact.phoneE164,
                phoneRaw: contact.phoneRaw,
                avatar: contact.avatar,
                unreadCount: contact.unreadCount || 0,
                manualActive: !!contact.manualActive,
                autoReplyEnabled: contact.autoReplyEnabled !== false,
                hasNewMessage: contact.hasNewMessage || false
            }));

            console.log(`✅ [CONTACTS] Retornando ${data.length} de ${total} contacts`);
            console.log(`📊 [CONTACTS] ${data.filter(c => c.leadId).length}/${data.length} têm leadId`);

            // ✅ LOG DO PRIMEIRO
            if (data.length > 0) {
                console.log("🔍 [FIRST CONTACT]", {
                    phone: data[0].phone,
                    leadId: data[0].leadId,
                    type: typeof data[0].leadId
                });
            }

            res.json({
                success: true,
                data,
                pagination: {
                    page,
                    limit,
                    total,
                    hasMore: skip + data.length < total
                }
            });

        } catch (err) {
            console.error("❌ Erro ao listar contatos:", err);
            res.status(500).json({ success: false, error: err.message });
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
            const existing = await Contacts.findOne({ phone: p });
            if (existing) return res.status(400).json({ error: "Contato com esse telefone já existe" });

            const contact = await Contacts.create({ name, phone: p, avatar });
            res.status(201).json(contact);
        } catch (err) {
            console.error("❌ Erro ao adicionar contato:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async updateContact(req, res) {
        try {
            if (req.body?.phone) req.body.phone = normalizeE164BR(req.body.phone);
            const updated = await Contacts.findByIdAndUpdate(req.params.id, req.body, { new: true });
            res.json(updated);
        } catch (err) {
            console.error("❌ Erro ao atualizar contato:", err);
            res.status(500).json({ error: err.message });
        }
    },

    async deleteContact(req, res) {
        try {
            await Contacts.findByIdAndDelete(req.params.id);
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

            const contact = await Contacts.findOne({ phone: chatPhone }).lean();
            const patientId = lead.convertedToPatient || null;

            // 🧠 Ativa controle manual (Amanda PAUSADA) — FAÇA ANTES DO ENVIO
            // 🔧 CORREÇÃO: Adicionar autoResumeAfter padrão de 30 minutos
            await Lead.findByIdAndUpdate(lead._id, {
                'manualControl.active': true,
                'manualControl.takenOverAt': new Date(),
                'manualControl.takenOverBy': userId,
                'manualControl.autoResumeAfter': 30  // 30 minutos padrão
            });
            console.log(`✅ Mensagem manual enviada - Amanda pausada para o lead ${lead._id}`);

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
                        text: saved.content,
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
    },

    async amandaResume(req, res) {
        try {
            const { leadId: rawId } = req.params;

            if (!rawId) {
                return res.status(400).json({ success: false, error: 'leadId obrigatório' });
            }

            let leadId = null;

            // 1) Resolve leadId (Lead > Contact > Phone)
            if (mongoose.Types.ObjectId.isValid(rawId)) {
                const lead = await Lead.findById(rawId).lean();
                if (lead) leadId = lead._id;
                else {
                    const contactDoc = await Contacts.findById(rawId).lean();
                    if (contactDoc?.phone) {
                        const phoneNorm = normalizeE164BR(contactDoc.phone);
                        const leadByPhone = await Lead.findOne({ 'contact.phone': phoneNorm }).lean();
                        if (leadByPhone) leadId = leadByPhone._id;
                    }
                }
            }

            if (!leadId) {
                const phoneNorm = normalizeE164BR(rawId);
                const leadByPhone = await Lead.findOne({ 'contact.phone': phoneNorm }).lean();
                if (leadByPhone) leadId = leadByPhone._id;
            }

            if (!leadId) {
                return res.status(404).json({ success: false, error: 'Lead não encontrado' });
            }

            console.log(`🔄 [AMANDA-RESUME] Reativando para lead ${leadId}`);

            // 🔥 LIMPA ESTADO QUE ESTÁ TRAVANDO A AMANDA
            await Lead.findByIdAndUpdate(leadId, {
                $set: {
                    'manualControl.active': false,
                    autoReplyEnabled: true,
                    lastAmandaInteraction: new Date()
                },
                $unset: {
                    'manualControl.takenOverAt': "",
                    'manualControl.takenOverBy': "",
                    pendingChosenSlot: "",
                    pendingSchedulingSlots: "",
                    pendingPatientInfoForScheduling: "",
                    pendingPatientInfoStep: ""
                }
            });

            // Recarrega lead LIMPO
            const lead = await Lead.findById(leadId).lean();

            // 3. Busca última inbound
            const lastInbound = await Message.findOne({
                lead: leadId,
                direction: 'inbound'
            }).sort({ timestamp: -1 }).lean();

            if (!lastInbound) {
                return res.json({ success: true, message: 'Sem mensagem pendente', responded: false });
            }

            // 4. Já respondeu?
            const alreadyReplied = await Message.findOne({
                lead: leadId,
                direction: 'outbound',
                timestamp: { $gte: lastInbound.timestamp }
            }).lean();

            if (alreadyReplied) {
                return res.json({ success: true, message: 'Já respondida', responded: false });
            }

            const message = {
                content: lastInbound.content,
                from: lastInbound.from,
                waMessageId: lastInbound.waMessageId,
                timestamp: lastInbound.timestamp
            };

            const context = {
                source: 'amanda-resume',
                resumedAt: new Date(),
                forceSend: true
            };

            let result;
            let aiText = null;

            console.log(`🤖 [AMANDA-RESUME] Gerando resposta (Novo Orquestrador)`);

            // 🚀 NOVO FLOW SEMPRE ATIVO - LEGADO REMOVIDO
            result = await orchestrator.process({
                lead,
                message,
                context,
                services: { bookingService }
            });

            if (result?.command === 'SEND_MESSAGE') aiText = result.payload.text;
            else return res.json({ success: true, responded: false });

            if (!aiText?.trim()) {
                return res.json({ success: true, responded: false });
            }

            // 6. Envia WhatsApp
            const rawPhone = lead.contact?.phone;
            const to = normalizeE164BR(rawPhone);
            const contact = await Contacts.findOne({ phone: to }).lean();

            const sendResult = await sendTextMessage({
                to,
                text: aiText.trim(),
                lead: leadId,
                contactId: contact?._id || null,
                patientId: lead.convertedToPatient || null,
                sentBy: 'amanda',
                forceSend: true
            });

            const waMessageId = sendResult?.messages?.[0]?.id || null;

            await new Promise(r => setTimeout(r, 200));

            let savedMsg = await Message.findOne({ waMessageId }).lean();

            if (!savedMsg) {
                savedMsg = await Message.create({
                    waMessageId,
                    lead: leadId,
                    contact: contact?._id || null,
                    from: process.env.WHATSAPP_PHONE_NUMBER_ID || 'whatsapp:amanda',
                    to,
                    direction: 'outbound',
                    type: 'text',
                    content: aiText.trim(),
                    status: 'sent',
                    timestamp: new Date(),
                    metadata: { sentBy: 'amanda', source: 'amanda-resume' }
                });
            }

            const io = getIo();
            io.emit("message:new", {
                id: String(savedMsg._id),
                from: savedMsg.from,
                to: savedMsg.to,
                direction: savedMsg.direction,
                type: savedMsg.type,
                content: savedMsg.content,
                text: savedMsg.content,
                status: savedMsg.status,
                timestamp: savedMsg.timestamp,
                leadId: String(leadId),
                contactId: String(savedMsg.contact || ''),
                metadata: savedMsg.metadata
            });

            console.log(`✅ [AMANDA-RESUME] Respondido`);

            return res.json({
                success: true,
                responded: true,
                response: aiText.substring(0, 100) + '...'
            });

        } catch (error) {
            console.error('❌ [AMANDA-RESUME] Erro:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    },

    async contactsSearch(req, res) {
        try {
            const { q } = req.query;

            if (!q || q.length < 2) {
                return res.json({ success: true, data: [] });
            }

            const regex = new RegExp(q, 'i');

            // 1. Busca IDs de contatos que têm mensagem com o termo
            const contactIdsFromMessages = await Message.distinct('contact', {
                content: regex,
                contact: { $ne: null }
            });

            // 2. Busca contatos por nome/phone OU que apareceram nas mensagens
            const contacts = await Contacts.find({
                $or: [
                    { name: regex },
                    { phone: regex },
                    { _id: { $in: contactIdsFromMessages } }
                ]
            })
                .sort({ updatedAt: -1 })
                .limit(50)
                .lean();

            res.json({ success: true, data: contacts });

        } catch (err) {
            console.error('Erro na busca:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    }
};

// ✅ FUNÇÃO SEPARADA (não depende do this)
async function processInboundMessage(msg, value) {
    try {
        const io = getIo();

        const wamid = msg.id;
        const fromRaw = msg.from || "";
        const toRaw =
            value?.metadata?.display_phone_number ||
            process.env.CLINIC_PHONE_E164 ||
            "";

        const from = normalizeE164BR(fromRaw);
        const to = normalizeE164BR(toRaw);

        // ✅ FIX: define `type` logo no início (antes de qualquer uso)
        const type = msg.type;

        const fromNumeric = from.replace(/\D/g, "");
        console.log('[DEBUG CANARY ENV]', process.env.AMANDA_CANARY_PHONES);

        const isTestNumber = AUTO_TEST_NUMBERS.includes(fromNumeric);

        console.log("🔎 isTestNumber?", fromNumeric, isTestNumber);

        const timestamp = new Date(
            (parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000
        );

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
        }
        // 📍 LOCALIZAÇÃO (mensagens de localização do WhatsApp)
        else if (type === "location" && msg.location) {
            content =
                msg.location.name ||
                msg.location.address ||
                "Localização enviada";
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

        // ✅ FIX: agora sim calcula contentToSave (depois de definir type/content/caption)
        const contentToSave =
            type === "text" || type === "audio" || type === "image" || type === "location"
                ? content
                : (caption || `[${String(type || "unknown").toUpperCase()}]`);

        // ✅ flags rápidas agora com texto real
        const quickFlags = deriveFlagsFromText(contentToSave || "");
        const suppressAutoFollowup =
            quickFlags.alreadyScheduled ||
            quickFlags.wantsCancel ||
            quickFlags.wantsReschedule ||
            quickFlags.refusesOrDenies ||
            quickFlags.wantsPartnershipOrResume ||
            quickFlags.saysThanks ||
            quickFlags.saysBye;

        // ✅ BUSCA UNIFICADA INTELIGENTE
        let contact = await Contacts.findOne({ phone: from });
        if (!contact) {
            contact = await Contacts.create({
                phone: from,
                name: msg.profile?.name || `WhatsApp ${from.slice(-4)}`
            });
        }

        // ✅ VERIFICA SE EXISTE PATIENT COM ESTE TELEFONE (ANTES de usar)
        let patient = null;
        try {
            patient = await Patient.findOne({ phone: from }).lean();
            console.log("🔍 Patient encontrado:", patient ? patient._id : "Nenhum");
        } catch (e) {
            console.log("ℹ️ Model Patient não disponível");
        }

        const lead = await resolveLeadByPhone(
            from,
            patient
                ? {
                    name: patient.fullName,
                    status: "virou_paciente",
                    convertedToPatient: patient._id,
                    conversionScore: 100
                }
                : {
                    status: "novo",
                    conversionScore: 0
                }
        );

        if (!lead?._id) {
            console.error("❌ resolveLeadByPhone retornou lead inválido", { from, patientId: patient?._id });
            return;
        }

        // 🧪 Se for número de teste, sempre garantir que NÃO esteja em manual
        if (isTestNumber && lead) {
            await Lead.findByIdAndUpdate(lead._id, {
                $set: {
                    "manualControl.active": false,
                    "manualControl.takenOverAt": null,
                    "manualControl.takenOverBy": null,
                    "manualControl.autoResumeAfter": 0,
                    autoReplyEnabled: true,
                }
            });
            lead.manualControl = { active: false, autoResumeAfter: 0 };
            lead.autoReplyEnabled = true;

            console.log("🧪 Lead de teste destravado de controle manual:", String(lead._id));
        }

        // ✅ Se tiver flags que impactam o lead, atualiza (agora lead existe)
        if (suppressAutoFollowup) {
            const $set = {};
            const $addToSet = {};

            if (quickFlags.alreadyScheduled) {
                $set.alreadyScheduled = true;
                $addToSet.flags = "already_scheduled";
            }
            if (quickFlags.wantsPartnershipOrResume) {
                $set.reason = "parceria_profissional";
                $addToSet.flags = "parceria_profissional";
            }

            if (Object.keys($set).length || Object.keys($addToSet).length) {
                await Lead.findByIdAndUpdate(lead._id, {
                    ...(Object.keys($set).length ? { $set } : {}),
                    ...(Object.keys($addToSet).length ? { $addToSet } : {}),
                }).catch(() => { });
            }

            console.log("ℹ️ Auto follow-up suprimido por flags:", {
                leadId: String(lead._id),
                suppressAutoFollowup,
                quickFlags: {
                    alreadyScheduled: quickFlags.alreadyScheduled,
                    partnership: quickFlags.wantsPartnershipOrResume,
                    saysThanks: quickFlags.saysThanks,
                }
            });
        }

        // ✅ SALVAR MENSAGEM NO CRM
        const messageData = {
            waMessageId: wamid,
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
            needs_human_review: !(type === "text" || type === "audio" || type === "image"),
            timestamp,
            contact: contact._id,
            lead: lead._id,
            raw: msg,
        };

        // 🧭 Só adiciona o campo location se for mensagem de localização
        if (type === "location" && msg.location) {
            messageData.location = msg.location;
        }

        const savedMessage = await Message.create(messageData);

        try {
            contact.lastMessageAt = timestamp;
            contact.lastMessagePreview =
                contentToSave?.substring(0, 100) || `[${String(type).toUpperCase()}]`;
            await contact.save();
        } catch (e) {
            console.error("⚠️ Erro ao atualizar lastMessageAt no Contact:", e.message);
        }

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
            console.log("🔍 [DEBUG PRE-SAVE #1] Estado do lead ANTES do save:", {
                leadId: lead._id,
                pendingPatientInfoForScheduling: lead.pendingPatientInfoForScheduling,
                pendingPatientInfoStep: lead.pendingPatientInfoStep,
                pendingChosenSlot: lead.pendingChosenSlot ? "SIM" : "NÃO",
                pendingSchedulingSlots: lead.pendingSchedulingSlots?.primary ? "SIM" : "NÃO",
            });

            lead.lastInteractionAt = new Date();
            lead.interactions.push({
                date: new Date(),
                channel: "whatsapp",
                direction: "inbound",
                message: contentToSave,
                status: "received"
            });
            await lead.save();
            console.log("📅 Interação atualizada no lead");

            // 🧠 Amanda 2.0: atualizar "memória" estruturada a cada inbound
            try {
                const analysis = await analyzeLeadMessage({
                    text: contentToSave,
                    lead,
                    history: (lead.interactions || []).map(i => i.message).filter(Boolean),
                });

                lead.qualificationData = lead.qualificationData || {};
                lead.qualificationData.extractedInfo = mergeNonNull(
                    lead.qualificationData.extractedInfo || {},
                    analysis.extractedInfo  // ✅
                );

                lead.qualificationData.intent = analysis.intent.primary;
                lead.qualificationData.sentiment = analysis.intent.sentiment;
                lead.conversionScore = analysis.score;
                lead.lastScoreUpdate = new Date();

                await lead.save();

                console.log("🔍 [DEBUG POST-SAVE #2] Estado do lead DEPOIS do save:", {
                    leadId: lead._id,
                    pendingPatientInfoForScheduling: lead.pendingPatientInfoForScheduling,
                    pendingPatientInfoStep: lead.pendingPatientInfoStep,
                });

                console.log("🧠 qualificationData atualizado:", {
                    idade: lead.qualificationData?.extractedInfo?.idade,
                    idadeRange: lead.qualificationData?.extractedInfo?.idadeRange,
                    disponibilidade: lead.qualificationData?.extractedInfo?.disponibilidade,
                });
            } catch (e) {
                console.warn("⚠️ Falha ao atualizar intelligence (não crítico):", e.message);
            }
        } catch (updateError) {
            console.error("⚠️ Erro ao atualizar interação:", updateError.message);
        }

        const isRealText = contentToSave?.trim() && !contentToSave.startsWith("[");


        // ✅ AMANDA 2.0 TRACKING (texto, áudio transcrito ou imagem descrita)
        if ((type === "text" || type === "audio" || type === "image") && isRealText) {
            handleResponseTracking(lead._id, contentToSave)
                .catch(err => console.error("⚠️ Tracking não crítico falhou:", err));
        }

        // ✅ RESPOSTA AUTOMÁTICA (Amanda)
        if ((type === "text" || type === "audio" || type === "image") && isRealText) {
            console.log("🔍 [DEBUG PRE-ORCHESTRATOR] Lead sendo passado pro handleAutoReply:", {
                leadId: lead._id,
                pendingPatientInfoForScheduling: lead.pendingPatientInfoForScheduling,
                pendingPatientInfoStep: lead.pendingPatientInfoStep,
                pendingChosenSlot: lead.pendingChosenSlot ? "SIM" : "NÃO",
            });

            handleAutoReply(from, to, contentToSave, lead)
                .catch(err => console.error("⚠️ Auto-reply não crítico falhou:", err));
        }

        // 🔥 AUTO-AGENDADOR DE FOLLOW-UP (Amanda 2.0)
        // ✅ FIX: agora a supressão só impede o auto-followup, sem quebrar o processamento da mensagem
        try {
            if (!suppressAutoFollowup) {
                const freshLead = await Lead.findById(lead._id).lean();

                const autoReplyOn = freshLead?.autoReplyEnabled !== false;
                const manualActive = freshLead?.manualControl?.active === true;

                if (autoReplyOn && !manualActive) {
                    const existing = await Followup.findOne({
                        lead: freshLead._id,
                        status: { $in: ["scheduled", "processing"] },
                        scheduledAt: { $gte: new Date() },
                    }).lean();

                    if (!existing) {
                        await createSmartFollowupForLead(freshLead._id, {
                            explicitScheduledAt: null,
                            objective: "reengajamento_inbound",
                            attempt: 1,
                        });

                        console.log("💚🤍 Follow-up inteligente auto-agendado via Amanda 2.0:", {
                            leadId: String(freshLead._id),
                        });
                    } else {
                        console.log("ℹ️ Já existe follow-up futuro para este lead, não vou duplicar:", {
                            leadId: String(freshLead._id),
                            followupId: String(existing._id),
                            status: existing.status,
                            scheduledAt: existing.scheduledAt,
                        });
                    }
                } else {
                    console.log("ℹ️ Auto follow-up ignorado (manualControl ativo ou autoReply desativado).");
                }
            }
        } catch (autoFuError) {
            console.error("⚠️ Erro ao auto-agendar follow-up via inbound WhatsApp (não crítico):", autoFuError.message);
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
    // ✅ Commit 2: anti-corrida (Redis 30s + trava no Mongo)
    let lockKey = null;
    let lockAcquired = false;
    let debounceKey = null;
    let debounceAcquired = false;
    let mongoLockAcquired = false;
    let mongoLockedLeadId = null;
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
                lockKey = `ai:lock:${from}`;
                const ok = await redis.set(lockKey, "1", "EX", 30, "NX");
                if (ok === "OK") {
                    lockAcquired = true;
                } else {
                    console.log("⏭️ AI lock ativo; evitando corrida", lockKey);
                    // ✅ FIX: Guarda mensagem pendente pra processar depois
                    try {
                        const pendingKey = `ai:pending:${from}`;
                        const existing = await redis.get(pendingKey);
                        const pendingList = existing ? JSON.parse(existing) : [];
                        pendingList.push({ content, timestamp: Date.now() });
                        await redis.set(pendingKey, JSON.stringify(pendingList), "EX", 300); // 5min TTL
                        console.log("📝 Mensagem guardada para processar depois:", content.substring(0, 50));
                    } catch (e) {
                        console.warn("⚠️ Falha ao guardar mensagem pendente:", e.message);
                    }
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
                debounceKey = `ai:debounce:${from}`;
                const ok = await redis.set(debounceKey, "1", "EX", 30, "NX");
                if (ok === "OK") {
                    debounceAcquired = true;
                } else {
                    console.log("⏭️ Debounce ativo (3s); pulando auto-reply");
                    return;
                }
            }
        } catch (debounceError) {
            console.warn("⚠️ Redis debounce indisponível:", debounceError.message);
        }

        // ================================
        // 4. Busca lead completo do banco + trava no Mongo (anti-corrida)
        // ================================
        const twoMinutesAgo = new Date(Date.now() - 120000);

        // ✅ FIX: Recupera mensagens pendentes e agrega ao contexto
        let aggregatedContent = content;
        try {
            const pendingKey = `ai:pending:${from}`;
            const pending = await redis.get(pendingKey);
            if (pending) {
                const pendingList = JSON.parse(pending);
                if (pendingList.length > 0) {
                    const pendingTexts = pendingList.map(p => p.content).join("\n");
                    aggregatedContent = `${pendingTexts}\n${content}`;
                    await redis.del(pendingKey);
                    console.log("📥 Mensagens pendentes agregadas:", pendingList.length);
                }
            }
        } catch (e) {
            console.warn("⚠️ Falha ao recuperar msgs pendentes:", e.message);
        }

        let leadDoc = await Lead.findOneAndUpdate(
            {
                _id: lead._id,
                $or: [
                    { isProcessing: { $ne: true } },
                    { processingStartedAt: { $exists: false } },
                    { processingStartedAt: { $lt: twoMinutesAgo } },
                ],
            },
            {
                $set: {
                    isProcessing: true,
                    processingStartedAt: new Date(),
                },
            },
            { new: true }
        ).lean();

        // No handleAutoReply, após carregar o lead:
        if (leadDoc.pendingChosenSlot === 'NÃO' || leadDoc.pendingSchedulingSlots === 'NÃO') {
            await Lead.findByIdAndUpdate(leadDoc._id, {
                $unset: { pendingChosenSlot: "", pendingSchedulingSlots: "" }
            });
            // Recarrega limpo
            leadDoc = await Lead.findById(leadDoc._id).lean();
        }
        // 🔍 DEBUG: Lead carregado do banco no handleAutoReply
        console.log("🔍 [DEBUG HANDLE-AUTO-REPLY] Lead carregado do banco:", {
            leadId: leadDoc?._id,
            pendingPatientInfoForScheduling: leadDoc?.pendingPatientInfoForScheduling,
            pendingPatientInfoStep: leadDoc?.pendingPatientInfoStep,
            pendingChosenSlot: leadDoc?.pendingChosenSlot ? "SIM" : "NÃO",
            pendingSchedulingSlots: leadDoc?.pendingSchedulingSlots?.primary ? "SIM" : "NÃO",
        });

        if (!leadDoc) {
            console.log("⏭️ Lead já está processando; ignorando mensagem", lead?._id);
            return;
        }

        mongoLockedLeadId = leadDoc._id;
        mongoLockAcquired = true;

        // ================================
        // 5. Controle manual (human takeover)
        // ================================
        if (!isTestNumber && leadDoc.manualControl?.active) {
            console.log('👤 [CONTROLE MANUAL] Ativo para lead:', leadDoc._id, '-', leadDoc.name);

            const takenAt = leadDoc.manualControl.takenOverAt
                ? new Date(leadDoc.manualControl.takenOverAt)
                : null;

            let aindaPausada = true;
            // 🔧 CORREÇÃO: Usar 30 minutos como padrão se não especificado
            const timeout = leadDoc.manualControl?.autoResumeAfter ?? 30;
            if (takenAt && typeof timeout === "number" && timeout > 0) {
                const minutesSince = (Date.now() - takenAt.getTime()) / (1000 * 60);
                if (minutesSince > timeout) {
                    await Lead.findByIdAndUpdate(lead._id, { 'manualControl.active': false });
                    aindaPausada = false;  // 🔧 CORREÇÃO: Atualizar a variável local!
                }
            } else if (!takenAt) {
                // 🔧 CORREÇÃO: Se não tem takenAt, desativa manualControl automaticamente
                await Lead.findByIdAndUpdate(lead._id, { 'manualControl.active': false });
                aindaPausada = false;
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
        // 8. Gera resposta da Amanda (NOVO ORQUESTRADOR 100%)
        // ================================
        console.log('🤖 Gerando resposta da Amanda (Novo Orquestrador)...');
        const leadIdStr = String(leadDoc._id);
        let aiText = null;

        // 🚀 NOVO FLOW SEMPRE ATIVO - LEGADO REMOVIDO
        const result = await orchestrator.process({
            lead: leadDoc,
            message: { content: aggregatedContent },
            context: {
                preferredPeriod: leadDoc.preferredPeriod || leadDoc.qualificationData?.extractedInfo?.disponibilidade,
                preferredDate: leadDoc.preferredDate || leadDoc.qualificationData?.extractedInfo?.dataPreferida,
                therapy: leadDoc.therapy || leadDoc.qualificationData?.extractedInfo?.especialidade,
                source: 'whatsapp-inbound'
            },
            services: {
                bookingService,
                productService: mapFlagsToBookingProduct
            }
        });

        if (result?.command === 'SEND_MESSAGE') {
            aiText = result.payload.text;
        }

        console.log("[AmandaReply] Texto gerado:", aiText ? aiText.substring(0, 80) + '...' : 'vazio');

        // ================================
        // 9. Envia resposta marcada como "amanda"
        // ================================
        if (aiText && aiText.trim()) {
            const finalText = aiText.trim();

            // 🔎 Tenta achar o contact pra vincular na mensagem
            const contactDoc = await Contacts.findOne({ phone: from }).lean();
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
    } finally {
        // ✅ Libera trava no Mongo (best-effort)
        if (mongoLockAcquired && mongoLockedLeadId) {
            try {
                await Lead.updateOne({ _id: mongoLockedLeadId }, { $set: { isProcessing: false } });
            } catch (unlockErr) {
                console.warn('⚠️ Falha ao liberar isProcessing:', unlockErr.message);
            }
        }

        // ✅ Libera locks no Redis (best-effort)
        try {
            if (redis?.del) {
                if (lockAcquired && lockKey) await redis.del(lockKey);
                if (debounceAcquired && debounceKey) await redis.del(debounceKey);
            }
        } catch (redisDelErr) {
            console.warn('⚠️ Falha ao liberar locks Redis:', redisDelErr.message);
        }
    }
}


function mergeNonNull(base = {}, incoming = {}) {
    const out = { ...(base || {}) };
    for (const [k, v] of Object.entries(incoming || {})) {
        if (v === null || v === undefined || v === "") continue;
        if (Array.isArray(v)) { if (v.length) out[k] = v; continue; }
        if (typeof v === "object") out[k] = mergeNonNull(out[k], v);
        else out[k] = v;
    }
    return out;
}


export async function handleIncomingMessage(req, res) {
    try {
        const message = req.body;

        if (!message?.from || !message?.content) {
            return res.status(200).json({ ok: true });
        }

        logger.info('Mensagem recebida', {
            from: message.from,
            useNew: USE_NEW_ORCHESTRATOR
        });

        return res.status(200).json({ ok: true });

    } catch (error) {
        logger.error('Erro no whatsappController', error);
        return res.status(500).json({ ok: false });
    }
}
