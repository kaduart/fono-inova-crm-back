// controllers/whatsappController.js - VERSÃO CORRIGIDA

import mongoose from 'mongoose';
import { redisConnection as redis } from '../config/redisConnection.js';
import { getIo } from "../config/socket.js";
import Contacts from '../models/Contacts.js';
import Lead from '../models/Leads.js';
import Message from "../models/Message.js";
import Patient from '../models/Patient.js';
import * as bookingService from '../services/amandaBookingService.js';
import Logger from '../services/utils/Logger.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";

import { withLeadLock } from '../services/LockManager.js';
import { deriveFlagsFromText } from "../utils/flagsDetector.js";
import { normalizeE164BR, sanitizePhoneBeforeSend } from "../utils/phone.js";
import { resolveLeadByPhone } from './leadController.js';
import { extractTrackingFromMessage } from '../utils/trackingExtractor.js';
import { extractMessageContent } from '../utils/whatsappMediaExtractor.js';
import { formatWhatsAppResponse } from '../utils/whatsappFormatter.js';
import { createContextLogger } from '../utils/logger.js';
import { runOrchestrator } from '../services/orchestrator/runOrchestrator.js';

const logger = new Logger('whatsappController');

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

            // Busca contato associado para incluir no socket
            const contact = await Contacts.findOne({ phone: to }).lean();

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
                leadId: leadId || null,
                contactId: contact?._id || null,
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
            console.log('✅ [sendText] VERSÃO CORRIGIDA — pausa Amanda ANTES do envio');
            if (!phone || !text) {
                return res.status(400).json({
                    success: false,
                    error: "Campos obrigatórios: phone e text"
                });
            }

            // 🔧 PRÉ-VALIDAÇÃO: Sanitiza número antes de enviar
            const sanitized = sanitizePhoneBeforeSend(phone);
            if (!sanitized.success) {
                console.error('❌ [SANITIZE] Número inválido:', sanitized.error, phone);
                return res.status(400).json({
                    success: false,
                    error: `Número de telefone inválido: ${sanitized.error}`,
                    received: phone,
                    normalized: sanitized.phone
                });
            }
            
            const to = sanitized.phone;
            console.log('📞 [SANITIZE] Número sanitizado:', { original: phone, sanitized: to });

            // 🔎 Tenta achar Contact pelo telefone (tenta vários formatos)
            let contact = await Contacts.findOne({ phone: to }).lean();
            if (!contact) {
                // Tenta sem 55 no início
                contact = await Contacts.findOne({ phone: to.replace(/^55/, '') }).lean();
            }
            if (!contact && to.length === 13) {
                // Tenta sem o 9 (formato antigo): 556292013573 → 55622013573
                const sem9 = to.substring(0, 4) + to.substring(5);
                contact = await Contacts.findOne({ phone: sem9 }).lean();
            }

            // 🔎 Tenta achar Lead (ou pelo id, ou pelo telefone com vários formatos)
            let leadDoc = null;
            if (leadId) {
                leadDoc = await Lead.findById(leadId).lean();
            } else {
                // Busca exata
                leadDoc = await Lead.findOne({ 'contact.phone': to }).lean();
                
                // Se não achou, tenta com + na frente
                if (!leadDoc) {
                    leadDoc = await Lead.findOne({ 'contact.phone': '+' + to }).lean();
                }
                
                // Se não achou e tem 13 dígitos, tenta sem o 9 (formato antigo da Meta)
                if (!leadDoc && to.length === 13) {
                    const sem9 = to.substring(0, 4) + to.substring(5); // 556292013573 → 55622013573
                    leadDoc = await Lead.findOne({ 'contact.phone': sem9 }).lean();
                    if (!leadDoc) {
                        leadDoc = await Lead.findOne({ 'contact.phone': '+' + sem9 }).lean();
                    }
                }
                
                // Se não achou, tenta sem 55 no início
                if (!leadDoc) {
                    const sem55 = to.replace(/^55/, '');
                    leadDoc = await Lead.findOne({ 'contact.phone': sem55 }).lean();
                    if (!leadDoc) {
                        leadDoc = await Lead.findOne({ 'contact.phone': '+' + sem55 }).lean();
                    }
                }
            }

            const resolvedLeadId = leadDoc?._id || leadId || null;
            const patientId = leadDoc?.convertedToPatient || null;
            
            if (leadDoc && leadDoc.contact?.phone !== to) {
                console.log(`🔍 [LEAD FOUND] Encontrado com formato alternativo: "${leadDoc.contact?.phone}" (buscava: "${to}")`);
            } else if (!leadDoc) {
                console.log(`⚠️ [LEAD NOT FOUND] Nenhum lead encontrado para: "${to}"`);
            }

            // 🔴 PAUSA AMANDA automaticamente ao enviar mensagem manual
            // Faz ANTES do envio para evitar race condition com inbound webhooks
            if (resolvedLeadId && sentBy === 'manual') {
                console.log(`⏸️ [SEND-TEXT] Pausando Amanda para lead ${resolvedLeadId}`);
                await Lead.findByIdAndUpdate(resolvedLeadId, {
                    $set: {
                        'manualControl.active': true,
                        'manualControl.takenOverAt': new Date(),
                        'manualControl.takenOverBy': userId || null,
                        'manualControl.autoResumeAfter': null  // 🔧 FIX: Não volta sozinha - só ativa quando clicar no botão
                    }
                });
                
                // 🔄 NOTIFICAR FRONTEND em tempo real sobre a mudança de estado
                const io = getIo();
                io.emit('lead:manualControl', {
                    leadId: resolvedLeadId,
                    manualActive: true,
                    phone: to,
                    reason: 'mensagem_manual_enviada',
                    timestamp: new Date()
                });
                console.log(`📡 [SEND-TEXT] Emitido lead:manualControl para lead ${resolvedLeadId}`);
            }

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
        // 🆕 LOG IMEDIATO - Confirma que a função foi chamada
        console.log("[WEBHOOK VERIFY] ➡️ Requisição recebida:", {
            url: req.url,
            query: req.query,
            headers: req.headers['user-agent']?.substring(0, 50),
            ip: req.ip
        });
        
        try {
            // 🆕 Trim para remover espaços acidentais
            const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN?.trim();
            const mode = req.query["hub.mode"];
            const token = req.query["hub.verify_token"]?.trim();
            const challenge = req.query["hub.challenge"];

            // 🆕 DEBUG: Log detalhado
            console.log("[WEBHOOK VERIFY] Debug:", {
                envTokenPresente: !!verifyToken,
                envToken: verifyToken,
                receivedToken: token,
                mode: mode,
                challenge: challenge,
                match: token === verifyToken,
                envTokenLength: verifyToken?.length,
                receivedTokenLength: token?.length
            });

            if (mode && token && mode === "subscribe" && token === verifyToken) {
                console.log("[WEBHOOK VERIFY] ✅ Sucesso - retornando challenge");
                return res.status(200).send(challenge);
            }
            
            console.log("[WEBHOOK VERIFY] ❌ Falha na verificação - 403");
            return res.sendStatus(403);
        } catch (err) {
            console.error("❌ Erro na verificação do webhook:", err);
            res.sendStatus(500);
        }
    },

    async webhook(req, res) {
        // [V2] ACK IMEDIATO — Meta exige resposta < 5s, antes de qualquer lógica
        res.sendStatus(200);

        // [V2] Raw log APÓS o ACK — não adiciona latência percebida pelo Meta
        mongoose.connection.collection('raw_webhook_logs').insertOne({
            body: req.body,
            receivedAt: new Date(),
            source: 'whatsapp_webhook'
        }).catch(() => {});

        try {
            const value = req.body.entry?.[0]?.changes?.[0]?.value;
            if (!value) return;

            // Statuses de entrega (read receipts, delivered, etc.) — não é mensagem recebida
            if (value.statuses?.length > 0) {
                for (const status of value.statuses) {
                    await processMessageStatus(status);
                }
                return;
            }

            const msg = value.messages?.[0];
            if (!msg) return;

            const { id: messageId, from } = msg;

            // [V2] Única camada de dedup — Redis SET NX atômico, funciona multi-node
            // Remove necessidade do processedWamids Set em memória
            const idempotencyKey = `msg:processed:${messageId}`;
            try {
                const acquired = await redis?.set(idempotencyKey, '1', 'NX', 'EX', 300);
                if (!acquired) return;
            } catch {
                // Redis indisponível — continua sem dedup
            }

            // Debounce buffer: acumula mensagens rápidas do mesmo remetente por 3.5s
            const debounceKey   = `webhook:buffer:${from}`;
            const processingKey = `webhook:processing:${from}`;

            try {
                const existing = await redis?.get(debounceKey);
                if (existing) {
                    const data = JSON.parse(existing);
                    data.messages.push(msg.text?.body || '');
                    await redis?.set(debounceKey, JSON.stringify(data), 'EX', 10);
                    return; // acumulado, não agenda novo job
                }
                await redis?.set(debounceKey, JSON.stringify({
                    messages: [msg.text?.body || ''],
                    msgData: msg,
                }), 'EX', 10);
            } catch {
                // [V2] Redis caiu: publica sem debounce — sem setTimeout como fallback
                await publishEvent(EventTypes.WHATSAPP_MESSAGE_RECEIVED, { msg, value });
                return;
            }

            await publishEvent(
                EventTypes.WHATSAPP_MESSAGE_RECEIVED,
                { msg, value, _debounceKey: debounceKey, _processingKey: processingKey, _isDebounced: true },
                { delay: 3500, correlationId: `wh:${messageId}`, idempotencyKey: `webhook:${from}:${messageId}` }
            );

        } catch (err) {
            createContextLogger('webhook').error('webhook_critical', { err: err.message });
        }
    },

    async listContacts(req, res) {
        try {
            const page = Math.max(parseInt(req.query.page || "1", 10), 1);
            const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
            const search = (req.query.search || "").trim();
            const hasNewMessage = req.query.hasNewMessage;
            const unreadOnly = req.query.unreadOnly === 'true';
            const tag = req.query.tag;
            const dateFrom = req.query.dateFrom;
            const dateTo = req.query.dateTo;
            const sortBy = req.query.sortBy || 'lastMessageAt'; // lastMessageAt, name, unreadCount
            const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
            const skip = (page - 1) * limit;

            const filter = {};
            if (search) {
                filter.$or = [
                    { name: { $regex: search, $options: "i" } },
                    { phone: { $regex: search } }
                ];
            }

            // Filtro de mensagens não lidas
            if (hasNewMessage === 'true') {
                filter.hasNewMessage = true;
            } else if (hasNewMessage === 'false') {
                filter.hasNewMessage = { $ne: true };
            }

            if (unreadOnly) {
                filter.unreadCount = { $gt: 0 };
            }

            // Filtro por tag
            if (tag) {
                filter.tags = tag;
            }

            // Filtro por data da última mensagem
            if (dateFrom || dateTo) {
                filter.lastMessageAt = {};
                if (dateFrom) filter.lastMessageAt.$gte = new Date(dateFrom);
                if (dateTo) filter.lastMessageAt.$lte = new Date(dateTo + 'T23:59:59.999Z');
            }

            const pipeline = [
                { $match: filter },

                { $sort: { [sortBy]: sortOrder, name: sortOrder } },
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
                Contacts.countDocuments(filter)
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
            // 🔧 FIX: Amanda só volta quando clicar no botão "Ativar" - não automaticamente
            await Lead.findByIdAndUpdate(lead._id, {
                'manualControl.active': true,
                'manualControl.takenOverAt': new Date(),
                'manualControl.takenOverBy': userId,
                'manualControl.autoResumeAfter': null  // null = não volta sozinha
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
            // Se estava em HANDOFF (estado terminal), reseta para GREETING para Amanda poder responder
            const leadBeforeResume = await Lead.findById(leadId).select('currentState').lean();
            const wasHandoff = leadBeforeResume?.currentState === 'HANDOFF';

            const updateSet = {
                'manualControl.active': false,
                autoReplyEnabled: true,
                lastAmandaInteraction: new Date()
            };
            if (wasHandoff) {
                updateSet.currentState = 'GREETING';
                updateSet.retryCount = 0;
                console.log(`🔄 [AMANDA-RESUME] Lead estava em HANDOFF — resetando FSM para GREETING`);
            }

            await Lead.findByIdAndUpdate(leadId, {
                $set: updateSet,
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

            console.log(`🤖 [AMANDA-RESUME] Gerando resposta (USE_STATE_MACHINE=${process.env.USE_STATE_MACHINE})`);

            // 🚀 ORQUESTRADOR COM LOCK ATÔMICO (feature flag via runOrchestrator)
            const lockResult = await withLeadLock(leadId, async (lockedLead) => {
                return runOrchestrator(lockedLead, message.content, context);
            });

            if (!lockResult.locked) {
                console.log('🔒 [AMANDA-RESUME] Lead em processamento, ignorando duplicata');
                return res.json({ success: true, responded: false });
            }
            result = lockResult;

            if (result?.command === 'SEND_MESSAGE') aiText = result.payload.text;
            else return res.json({ success: true, responded: false });

            if (!aiText?.trim()) {
                return res.json({ success: true, responded: false });
            }

            // 6. Formata texto para melhor legibilidade no WhatsApp
            const formattedText = formatWhatsAppResponse(aiText.trim());

            // 7. Envia WhatsApp
            const rawPhone = lead.contact?.phone;
            const to = normalizeE164BR(rawPhone);
            const contact = await Contacts.findOne({ phone: to }).lean();

            // 📤 Enfileira envio assíncrono → WhatsappSendWorker (retry automático)
            await publishEvent(EventTypes.WHATSAPP_MESSAGE_REQUESTED, {
                to,
                text: formattedText,
                leadId: String(leadId),
                contactId: contact?._id ? String(contact._id) : null,
                patientId: lead.convertedToPatient ? String(lead.convertedToPatient) : null,
                sentBy: 'amanda',
                source: 'amanda-resume',
                idempotencyKey: `amanda-resume:${String(leadId)}:${Date.now()}`,
            });

            console.log(`✅ [AMANDA-RESUME] Envio enfileirado para WhatsappSendWorker`);

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

    // 🔴 PAUSAR AMANDA MANUALMENTE
    async amandaPause(req, res) {
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

            console.log(`⏸️ [AMANDA-PAUSE] Pausando para lead ${leadId}`);

            // 🔴 ATIVA CONTROLE MANUAL (PAUSA AMANDA)
            await Lead.findByIdAndUpdate(leadId, {
                $set: {
                    'manualControl.active': true,
                    'manualControl.takenOverAt': new Date(),
                    'manualControl.takenOverBy': req.user?._id || null,
                    'manualControl.autoResumeAfter': null  // 🔧 FIX: Só volta quando clicar em "Ativar"
                }
            });

            console.log(`✅ [AMANDA-PAUSE] Amanda pausada para lead ${leadId}`);

            return res.json({
                success: true,
                message: 'Amanda pausada. Você pode enviar mensagens manualmente.',
                paused: true
            });

        } catch (error) {
            console.error('❌ [AMANDA-PAUSE] Erro:', error);
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
    },

    // 🎬 UPLOAD DE MÍDIA
    async uploadMedia(req, res) {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    error: 'Nenhum arquivo enviado'
                });
            }

            const { buffer, originalname, mimetype } = req.file;

            console.log('📤 Upload de mídia recebido:', {
                name: originalname,
                type: mimetype,
                size: buffer.length
            });

            // Upload para Meta/WhatsApp
            const { sendWhatsAppMediaMessage } = await import('../services/whatsappService.js');

            // Apenas faz upload e retorna o mediaId (não envia mensagem)
            const token = await getMetaToken();
            const PHONE_ID = process.env.META_WABA_PHONE_ID;
            const META_URL = "https://graph.facebook.com/v21.0";

            const FormData = (await import('form-data')).default;
            const formData = new FormData();
            formData.append('file', buffer, originalname);
            formData.append('type', mimetype.split('/')[0]);
            formData.append('messaging_product', 'whatsapp');

            const fetch = (await import('node-fetch')).default;
            const uploadRes = await fetch(`${META_URL}/${PHONE_ID}/media`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                },
                body: formData
            });

            const uploadData = await uploadRes.json();

            if (!uploadRes.ok) {
                throw new Error(uploadData.error?.message || 'Falha no upload');
            }

            res.json({
                success: true,
                mediaId: uploadData.id,
                mediaUrl: uploadData.url
            });

        } catch (error) {
            console.error('❌ Erro no upload de mídia:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    },

    // 🎬 ENVIO DE MÍDIA
    async sendMedia(req, res) {
        try {
            const { phone, type, caption, leadId } = req.body;
            const file = req.file;

            if (!phone || !file || !type) {
                return res.status(400).json({
                    success: false,
                    error: 'Telefone, arquivo e tipo são obrigatórios'
                });
            }

            const to = normalizeE164BR(phone);
            
            console.log('📤 [SEND-MEDIA] Números:', {
                original: phone,
                formatted: to
            });

            console.log('📤 Enviando mídia:', {
                to,
                type,
                filename: file.originalname,
                size: file.buffer.length,
                mimetype: file.mimetype
            });

            const { sendWhatsAppMediaMessage } = await import('../services/whatsappService.js');

            // Enviar para WhatsApp
            const result = await sendWhatsAppMediaMessage({
                to,
                file: file.buffer,
                type, // 'image', 'audio', 'video', 'document'
                caption: caption || undefined,
                filename: file.originalname,
                lead: leadId || null
            });

            // Adicionar headers CORS manualmente
            res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
            res.header('Access-Control-Allow-Credentials', 'true');
            
            res.json({
                success: true,
                messageId: result.messages?.[0]?.id,
                mediaId: result.mediaId
            });

        } catch (error) {
            console.error('❌ Erro ao enviar mídia:', error);
            // Adicionar headers CORS mesmo em erro
            res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
            res.header('Access-Control-Allow-Credentials', 'true');
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
};

// 🆕 FUNÇÃO PARA PROCESSAR STATUS DE ENTREGA
async function processMessageStatus(status) {
    const { id: messageId, status: msgStatus, recipient_id, timestamp, errors } = status;
    
    console.log(`[WEBHOOK-STATUS] Mensagem ${messageId} para ${recipient_id}: ${msgStatus}`);
    
    try {
        // Buscar mensagem no banco pelo waMessageId
        const Message = (await import('../models/Message.js')).default;
        let msg = await Message.findOne({ waMessageId: messageId });

        // Race condition: webhook pode chegar antes de registerMessage salvar no banco
        // Retenta até 3x com delay crescente
        if (!msg) {
            console.log(`[WEBHOOK-STATUS] Mensagem ${messageId} não encontrada no banco — aguardando...`);
            const delays = [600, 1000, 1500];
            for (const delay of delays) {
                await new Promise(r => setTimeout(r, delay));
                msg = await Message.findOne({ waMessageId: messageId });
                if (msg) {
                    console.log(`[WEBHOOK-STATUS] Mensagem ${messageId} encontrada após retry (${delay}ms)`);
                    break;
                }
            }
        }

        if (!msg) {
            console.log(`[WEBHOOK-STATUS] Mensagem ${messageId} não encontrada no banco após retries — ignorando`);
            return;
        }
        
        // Atualizar status
        const oldStatus = msg.status;
        msg.status = msgStatus;
        
        // Log de transição de status
        console.log(`[WEBHOOK-STATUS] ${messageId}: ${oldStatus} → ${msgStatus}`);
        
        // Se enviada (aceita pelo WhatsApp)
        if (msgStatus === 'sent') {
            console.log(`[WEBHOOK-STATUS] ✅ Mensagem aceita pelo WhatsApp para ${recipient_id}`);
        }
        
        // Se falhou, marcar como failed e tentar fallback
        if (msgStatus === 'failed' && errors) {
            console.error(`[WEBHOOK-STATUS] ❌ FALHA ao entregar para ${recipient_id}:`, errors);

            // Atualizar status da mensagem para failed (não deletar - usuário precisa ver)
            msg.status = 'failed';
            msg.error = errors[0]?.title || errors[0]?.message || 'Unknown error';
            msg.errorCode = errors[0]?.code || null;
            await msg.save();
            console.log(`[WEBHOOK-STATUS] ⚠️ Mensagem ${messageId} marcada como 'failed' no BD`);

            // 🔄 FALLBACK 131047: janela de 24h expirada → envia template de recontato
            const is24hError = errors.some(e => e.code === 131047);
            if (is24hError) {
                // 🛡️ DEDUP duplo: Redis (curto prazo) + banco (24h) — nunca spam
                const dedupKey = `recontato_sent:${recipient_id}`;
                const redisBlock = await redis?.get(dedupKey);
                if (redisBlock) {
                    console.log(`[WEBHOOK-STATUS] ⏭️ [REDIS] Template recontato_clinica já enviado recentemente para ${recipient_id} — ignorando`);
                    return;
                }
                // Verifica também no banco: se já enviou o mesmo template nas últimas 24h
                const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
                const recentTemplate = await Message.findOne({
                    to: recipient_id,
                    templateName: 'recontato_clinica',
                    direction: 'outbound',
                    timestamp: { $gte: oneDayAgo },
                }).lean();
                if (recentTemplate) {
                    console.log(`[WEBHOOK-STATUS] ⏭️ [DB] Template recontato_clinica já enviado nas últimas 24h para ${recipient_id} — ignorando`);
                    await redis?.set(dedupKey, '1', 'EX', 4 * 60 * 60); // sincroniza Redis
                    return;
                }
                // Marca no Redis por 4 horas (guard rápido para rajadas)
                await redis?.set(dedupKey, '1', 'EX', 4 * 60 * 60);

                console.log(`[WEBHOOK-STATUS] ⏰ Janela 24h expirada para ${recipient_id} — enviando template recontato_clinica`);
                try {
                    await sendTemplateMessage({
                        to: recipient_id,
                        template: 'recontato_clinica',
                        params: [],
                        lead: msg.lead || null,
                        contactId: msg.contact || null,
                        patientId: msg.patient || null,
                        sentBy: 'system',
                    });
                    console.log(`[WEBHOOK-STATUS] ✅ Template recontato_clinica enviado para ${recipient_id}`);

                    const io = getIo();
                    if (io) {
                        io.emit('whatsapp:template:sent', {
                            phone: recipient_id,
                            leadId: msg.lead,
                            template: 'recontato_clinica',
                            reason: '24h_window_expired',
                            originalMessage: msg.content?.substring(0, 100),
                            timestamp: new Date()
                        });
                    }
                } catch (templateErr) {
                    console.error(`[WEBHOOK-STATUS] ❌ Falha ao enviar template fallback:`, templateErr.message);
                }
                return;
            }

            // Emitir alerta via socket para outros erros
            const io = getIo();
            if (io) {
                io.emit('whatsapp:message:failed', {
                    messageId,
                    leadId: msg.lead,
                    phone: recipient_id,
                    error: errors[0],
                    content: msg.content?.substring(0, 100),
                    timestamp: new Date()
                });
            }

            return; // Não salva, já deletou
        }
        
        // Se entregue, logar sucesso
        if (msgStatus === 'delivered') {
            console.log(`[WEBHOOK-STATUS] ✅ Mensagem entregue no dispositivo ${recipient_id}`);
        }
        
        // Se lida, logar
        if (msgStatus === 'read') {
            console.log(`[WEBHOOK-STATUS] 👁️ Mensagem lida por ${recipient_id}`);
        }
        
        await msg.save();
        
    } catch (error) {
        console.error('[WEBHOOK-STATUS] Erro ao processar status:', error.message);
    }
}

// ✅ FUNÇÃO HARDENED - Stripe-level Ingestion Layer (NUNCA QUEBRA)
// ✅ FUNÇÃO HARDENED - Stripe-level Ingestion Layer
async function processInboundMessage(msg, value) {
    const wamid = msg.id;
    const correlationId = `inbound:${wamid}`;
    const log = createContextLogger('processInboundMessage');

    let savedMessage = null;
    let contact = null;
    let lead = null;

    try {
        const from = normalizeE164BR(msg.from || '');
        const to = normalizeE164BR(
            value?.metadata?.display_phone_number || process.env.CLINIC_PHONE_E164
        ) || '0000000000000';

        const type = msg.type;

        log.info('start', { wamid, from, type, correlationId });

        // ─────────────────────────────────────────────
        // 1. EXTRACT CONTENT (ISOLADO)
        // ─────────────────────────────────────────────
        let contentToSave = '';
        let mediaUrl = null;
        let mediaId = null;
        let caption = null;

        try {
            const extracted = await extractMessageContent(msg, type);
            contentToSave = extracted.content;
            mediaUrl = extracted.mediaUrl;
            mediaId = extracted.mediaId;
            caption = extracted.caption;
        } catch (err) {
            log.warn('extract_failed', { err: err.message });
            contentToSave = '[UNREADABLE MESSAGE]';
        }

        const timestamp = new Date(
            (parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000
        );

        // ─────────────────────────────────────────────
        // 2. CONTACT (NON CRITICAL)
        // ─────────────────────────────────────────────
        try {
            contact = await Contacts.findOne({ phone: from }) ||
                await Contacts.create({
                    phone: from,
                    name: msg.profile?.name || `WhatsApp ${from.slice(-4)}`
                });

            // 🔄 Atualiza lastMessageAt para manter inbox ordenado no frontend
            if (contact) {
                await Contacts.findByIdAndUpdate(contact._id, {
                    lastMessageAt: timestamp,
                    lastMessagePreview: contentToSave?.slice(0, 120) || '',
                });
                contact.lastMessageAt = timestamp;
                contact.lastMessagePreview = contentToSave?.slice(0, 120) || '';
            }
        } catch (err) {
            log.warn('contact_error', { err: err.message });
        }

        // ─────────────────────────────────────────────
        // 3. LEAD RESOLVE (SAFE FALLBACK)
        // ─────────────────────────────────────────────
        try {
            lead = await resolveLeadByPhone(from, {});
        } catch (err) {
            log.error('lead_resolve_failed', { err: err.message });
            lead = { _id: null };
        }

        if (!lead?._id) {
            log.warn('lead_missing_fallback_mode', { from });
        }

        // ─────────────────────────────────────────────
        // 4. SAVE MESSAGE (🔥 CRITICAL STEP)
        // ─────────────────────────────────────────────
        try {
            savedMessage = await Message.create({
                waMessageId: wamid,
                from,
                to,
                direction: 'inbound',
                type,
                content: contentToSave,
                mediaUrl,
                mediaId,
                caption,
                status: 'received',
                timestamp,
                contact: contact?._id,
                lead: lead?._id,
                raw: msg,
            });
        } catch (err) {
            log.error('message_save_failed', { err: err.message });

            // 🚨 HARD STOP ONLY HERE (nothing else is reliable)
            return;
        }

        // ─────────────────────────────────────────────
        // 4.5. CONVERSATION STATE (memória de curto prazo - fire & forget)
        // ─────────────────────────────────────────────
        try {
            publishEvent(EventTypes.CONVERSATION_STATE_UPDATE, {
                leadId: String(lead?._id),
                from,
                content: contentToSave,
                type,
                direction: 'inbound',
                timestamp: timestamp.toISOString(),
            }, { correlationId }).catch(() => {});
        } catch {}

        // ─────────────────────────────────────────────
        // 5. SOCKET (NON BLOCKING)
        // ─────────────────────────────────────────────
        try {
            const io = getIo();

            const socketPayload = {
                id: String(savedMessage._id),
                from,
                to,
                type,
                content: contentToSave,
                timestamp: timestamp.toISOString(),
                contactId: contact?._id ? String(contact._id) : null,
                contactName: contact?.name || msg.profile?.name || null,
            };

            io?.emit('message:new', socketPayload);
            io?.emit('whatsapp:new_message', socketPayload);
        } catch (err) {
            log.warn('socket_failed', { err: err.message });
        }

        // ─────────────────────────────────────────────
        // 6. LEAD UPDATE (NON CRITICAL)
        // ─────────────────────────────────────────────
        try {
            if (lead?._id) {
                await Lead.findByIdAndUpdate(lead._id, {
                    $set: {
                        lastInteractionAt: new Date(),
                    },
                    $push: {
                        interactions: {
                            date: new Date(),
                            channel: 'whatsapp',
                            direction: 'inbound',
                            message: contentToSave,
                        },
                    },
                });
            }
        } catch (err) {
            log.warn('lead_update_failed', { err: err.message });
        }

        // ─────────────────────────────────────────────
        // 7. EVENTS (FIRE AND FORGET - NEVER BLOCK)
        // ─────────────────────────────────────────────

        try {
            publishEvent(EventTypes.MESSAGE_RESPONSE_DETECTED, {
                leadId: String(lead?._id),
                messageId: savedMessage._id?.toString(),
                content: contentToSave,
            }, { correlationId }).catch(() => {});
        } catch {}

        try {
            publishEvent(EventTypes.CONTEXT_BUILD_REQUESTED, {
                leadId: String(lead?._id),
                from,
                content: contentToSave,
                type,
                wamid,
                messageId: savedMessage._id?.toString(),
            }, {
                correlationId,
                jobId: `context:${lead?._id || wamid}`,
            }).catch(() => {});
        } catch {}

        try {
            publishEvent(EventTypes.FOLLOWUP_REQUESTED, {
                leadId: String(lead?._id),
                source: 'inbound',
            }, { correlationId }).catch(() => {});
        } catch {}

        try {
            publishEvent(EventTypes.LEAD_RECOVERY_CANCEL_REQUESTED, {
                leadId: String(lead?._id),
                reason: 'lead_respondeu',
            }, { correlationId }).catch(() => {});
        } catch {}

        // ─────────────────────────────────────────────
        // 8. LOG FINAL
        // ─────────────────────────────────────────────
        log.info('done', {
            wamid,
            leadId: lead?._id,
            messageId: savedMessage?._id,
            correlationId
        });

    } catch (err) {
        // 🔥 NEVER BREAK WEBHOOK PIPELINE
        log.error('critical_but_safe_error', {
            err: err.message,
            wamid,
            correlationId
        });
    }
}

export { processInboundMessage };



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


// ============================================================================
// 🛡️ WHATSAPP GUARD - ALERTA DE SILÊNCIO E ANOMALIA
// ============================================================================

let silenceMonitorStarted = false;
let lastAnomalyAlert = null; // 🆕 Controle de tempo do alerta de anomalia

export function startSilenceMonitor() {
    if (silenceMonitorStarted) return;
    silenceMonitorStarted = true;

    const SILENCE_THRESHOLD_MINUTES = parseInt(process.env.SILENCE_THRESHOLD_MINUTES) || 720; // 12 horas padrão
    const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutos
    const ANOMALY_ALERT_INTERVAL = 4 * 60 * 60 * 1000; // 🆕 4 horas entre alertas de anomalia

    setInterval(async () => {
        try {
            // Verifica última interação
            const lastLead = await Lead.findOne().sort({ lastInteractionAt: -1 });
            
            if (!lastLead?.lastInteractionAt) {
                logger.warn('[GUARD-SILENCE] Nenhuma interação encontrada no sistema');
                return;
            }

            const minutesSinceLastInteraction = (Date.now() - new Date(lastLead.lastInteractionAt).getTime()) / (1000 * 60);

            if (minutesSinceLastInteraction > SILENCE_THRESHOLD_MINUTES) {
                logger.error(`🚨 [GUARD-SILENCE] ALERTA: ${Math.floor(minutesSinceLastInteraction)} minutos sem mensagens! Última: ${lastLead.contact?.phone}`);
                
                // Envia alerta via socket pro dashboard
                const io = getIo();
                if (io) {
                    io.emit('system:alert', {
                        type: 'silence',
                        message: `Nenhuma mensagem há ${Math.floor(minutesSinceLastInteraction)} minutos`,
                        lastInteraction: lastLead.lastInteractionAt,
                        timestamp: new Date()
                    });
                }
            }

            // 🧨 ALERTA DE ANOMALIA: volume abaixo do esperado
            const now = new Date();
            const hour = now.getHours();
            const isBusinessHours = hour >= 8 && hour <= 20;
            
            if (isBusinessHours) {
                const oneHourAgo = new Date(now - 60 * 60 * 1000);
                const messagesLastHour = await mongoose.connection.collection('raw_webhook_logs').countDocuments({
                    receivedAt: { $gte: oneHourAgo },
                    'body.entry.changes.value.messages': { $exists: true }
                });

                // Se menos de 2 mensagens na última hora durante horário comercial
                if (messagesLastHour < 2) {
                    const now = Date.now();
                    
                    // 🆕 Só alerta se passaram 4 horas desde o último alerta
                    if (!lastAnomalyAlert || (now - lastAnomalyAlert) > ANOMALY_ALERT_INTERVAL) {
                        lastAnomalyAlert = now;
                        
                        logger.warn(`🚨 [GUARD-ANOMALY] Volume anormal: apenas ${messagesLastHour} mensagem(ns) na última hora`);
                        
                        const io = getIo();
                        if (io) {
                            io.emit('system:alert', {
                                type: 'anomaly',
                                message: `Volume anormal de mensagens (${messagesLastHour}/hora)`,
                                timestamp: new Date()
                            });
                        }
                    }
                }
            }

        } catch (err) {
            logger.error('[GUARD-SILENCE] Erro no monitor:', err.message);
        }
    }, CHECK_INTERVAL);

    logger.info(`[GUARD-SILENCE] Monitor iniciado (threshold: ${SILENCE_THRESHOLD_MINUTES}min, check: 5min)`);
}

// Inicia automaticamente
startSilenceMonitor();
