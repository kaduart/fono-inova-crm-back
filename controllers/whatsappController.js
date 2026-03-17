// controllers/whatsappController.js - VERSÃO CORRIGIDA

import mongoose from 'mongoose';
import { redisConnection as redis } from '../config/redisConnection.js';
import { getIo } from "../config/socket.js";
import Contacts from '../models/Contacts.js';
import Followup from "../models/Followup.js";
import Lead from '../models/Leads.js';
import Message from "../models/Message.js";
import Patient from '../models/Patient.js';
import { describeWaImage, transcribeWaAudio } from "../services/aiAmandaService.js";
import * as bookingService from '../services/amandaBookingService.js';
import { createSmartFollowupForLead } from "../services/followupOrchestrator.js";
import { analyzeLeadMessage } from '../services/intelligence/leadIntelligence.js';
import { checkFollowupResponse } from "../services/responseTrackingService.js";
import Logger from '../services/utils/Logger.js';
import { resolveMediaUrl, sendTemplateMessage, sendTextMessage } from "../services/whatsappService.js";

import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import WhatsAppOrchestrator from '../orchestrators/WhatsAppOrchestrator.js';
import { withLeadLock } from '../services/LockManager.js';
import { mapFlagsToBookingProduct } from '../utils/bookingProductMapper.js';
import { deriveFlagsFromText } from "../utils/flagsDetector.js";
import { normalizeE164BR, sanitizePhoneBeforeSend } from "../utils/phone.js";
import { resolveLeadByPhone } from './leadController.js';
import { cancelRecovery } from '../services/leadRecoveryService.js';

const AUTO_TEST_NUMBERS = [
    "5561981694922", "5561981694922", "556292013573", "5562992013573"
];

// 🛡️ FIX: Cache para evitar processamento duplicado de mensagens
const processedWamids = new Set();
const MAX_WAMID_CACHE_SIZE = 1000;

const logger = new Logger('whatsappController');

// ============================================================
// 📝 FORMATAÇÃO DE TEXTO PARA WHATSAPP (melhor legibilidade)
// ============================================================
/**
 * Formata texto para WhatsApp garantindo espaçamento adequado entre parágrafos
 * Isso melhora a leitura no celular
 */
function formatWhatsAppResponse(text) {
    if (!text || typeof text !== 'string') return text;
    
    // 1. Normaliza quebras de linha
    let formatted = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // 2. Remove múltiplas quebras consecutivas (mais de 2) → reduz para 2
    formatted = formatted.replace(/\n{3,}/g, '\n\n');
    
    // 3. Adiciona espaçamento após pontos finais seguidos de texto (se não houver quebra)
    // Detecta padrões como: "...desenvolvimento.El" e converte para "...desenvolvimento.\n\nEl"
    formatted = formatted.replace(/([.!?])([A-Z][a-z])/g, '$1\n\n$2');
    
    // 4. Garante que bullets/listas tenham espaçamento antes
    formatted = formatted.replace(/([^\n])(\n[•\-\*]\s)/g, '$1\n$2');
    
    // 5. Remove espaços extras no final de linhas
    formatted = formatted.split('\n').map(line => line.trimEnd()).join('\n');
    
    return formatted.trim();
}

// ============================================================
// ROTEADOR DE ORQUESTRADORES (feature flag USE_STATE_MACHINE)
// USE_STATE_MACHINE=true  → WhatsAppOrchestrator (FSM nova)
// USE_STATE_MACHINE=false → AmandaOrchestrator (legado)
// ============================================================
const fsmOrchestrator = new WhatsAppOrchestrator(); // singleton — evita overhead por mensagem

async function runOrchestrator(lead, userText, context) {
    const leadId = lead?._id;
    if (process.env.USE_STATE_MACHINE === 'true') {
        const isMidConversationLegacyLead = !lead.currentState && lead.triageStep;
        if (!isMidConversationLegacyLead) {
            logger.info('ORCHESTRATOR_FSM', { leadId, currentState: lead.currentState, textLen: userText?.length });
            try {
                const result = await fsmOrchestrator.process({
                    lead,
                    message: { content: userText },
                    context,
                });
                logger.info('ORCHESTRATOR_FSM_RESULT', { leadId, command: result?.command });
                return result;
            } catch (err) {
                logger.error('FSM_ERROR_FALLBACK', { error: err.message, stack: err.stack, leadId });
            }
        } else {
            logger.warn('ORCHESTRATOR_LEGACY_MID_CONVERSATION', { leadId, triageStep: lead.triageStep, currentState: lead.currentState });
        }
    } else {
        logger.info('ORCHESTRATOR_LEGACY', { leadId, USE_STATE_MACHINE: process.env.USE_STATE_MACHINE });
    }
    const text = await getOptimizedAmandaResponse({ content: userText, userText, lead, context });
    return text ? { command: 'SEND_MESSAGE', payload: { text } } : { command: 'NO_REPLY' };
}

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

            // 🔴 PAUSA AMANDA automaticamente ao enviar mensagem manual
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
        console.log("=========================== >>> 🔔MENSAGEM RECEBIDA DE CLIENTE <<< ===========================", new Date().toISOString());
        try {
            res.sendStatus(200); // Responde imediato pro Meta

            const change = req.body.entry?.[0]?.changes?.[0]; // Pega o change
            const value = change?.value; // GUARDA O VALUE

            // 🆕 PROCESSAR STATUS DE ENTREGA (mensagens enviadas)
            if (value?.statuses && value.statuses.length > 0) {
                for (const status of value.statuses) {
                    await processMessageStatus(status);
                }
                return; // Não processa como mensagem recebida
            }

            const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || value?.messages?.[0];
            if (!msg) return;

            const from = msg.from;
            const content = msg.text?.body || '';

            // 🆕 DEBOUNCE CORRETO AQUI (3.5s, não 30s)
            const debounceKey = `webhook:buffer:${from}`;
            const existing = await redis?.get(debounceKey);

            if (existing) {
                // Acumula
                const data = JSON.parse(existing);
                data.messages.push(content);
                data.lastTime = Date.now();
                await redis.set(debounceKey, JSON.stringify(data), 'EX', 10);
                console.log(`[BUFFER] Acumulado: ${data.messages.length} msgs`);
                return; // Não processa ainda!
            }

            // Primeira mensagem - inicia timer
            await redis?.set(debounceKey, JSON.stringify({
                messages: [content],
                startTime: Date.now(),
                msgData: msg
            }), 'EX', 4); // 4 segundos de espera

            // Aguarda 3.5s e processa tudo junto
            setTimeout(async () => {
                const buffer = await redis?.get(debounceKey);
                if (!buffer) return; // Já processado por outra instância

                await redis?.del(debounceKey);
                const data = JSON.parse(buffer);
                const combinedText = data.messages.join(' ');

                // Substitui o texto da mensagem pelo combinado
                if (!msg.text) {
                    msg.text = { body: combinedText };
                } else {
                    msg.text.body = combinedText;
                }
                await processInboundMessage(msg, value);
            }, 3500);

        } catch (err) {
            console.error("❌ Erro crítico no webhook:", err);
        }
    },

    async listContacts(req, res) {
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

            const sendResult = await sendTextMessage({
                to,
                text: formattedText,
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
                    content: formattedText,
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

// ✅ FUNÇÃO SEPARADA (não depende do this)
async function processInboundMessage(msg, value) {
    try {
        const io = getIo();

        const wamid = msg.id;
        
        // 🛡️ FIX: Verifica duplicidade de mensagem
        if (processedWamids.has(wamid)) {
            console.log(`⚠️ Mensagem ${wamid} já processada, ignorando duplicidade.`);
            return { success: true, duplicate: true };
        }
        
        // Adiciona ao cache e mantém tamanho limitado
        processedWamids.add(wamid);
        if (processedWamids.size > MAX_WAMID_CACHE_SIZE) {
            const firstItem = processedWamids.values().next().value;
            processedWamids.delete(firstItem);
        }
        
        const fromRaw = msg.from || "";
        const toRaw =
            value?.metadata?.display_phone_number ||
            process.env.CLINIC_PHONE_E164 ||
            "";

        // 🔧 CORREÇÃO: Normalização robusta do telefone
        const from = normalizeE164BR(fromRaw);
        const to = normalizeE164BR(toRaw);

        // 🆕 LOG DEBUG: Mostrar transformação do número
        console.log("📞 [WEBHOOK PHONE] Normalização:", {
            fromRaw,
            fromNormalized: from,
            toRaw,
            toNormalized: to,
            fromLength: from?.length,
            toLength: to?.length
        });

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
            content = await transcribeWaAudio({ mediaId });

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
                const description = await describeWaImage({ mediaId, mediaUrl, mimeType: msg.image?.mime_type });

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

        // 🎯 PASSAR METADADOS PARA DETECÇÃO DE CAMPANHA
        const leadDefaults = patient
            ? {
                name: patient.fullName,
                status: "virou_paciente",
                convertedToPatient: patient._id,
                conversionScore: 100,
                firstMessage: contentToSave  // Passa primeira mensagem para detecção
            }
            : {
                status: "novo",
                conversionScore: 0,
                firstMessage: contentToSave  // Passa primeira mensagem para detecção
            };
        
        const lead = await resolveLeadByPhone(from, leadDefaults);

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
        console.log("📡 [SOCKET] Preparando para emitir message:new...");
        console.log("📡 [SOCKET] io existe:", !!io);
        console.log("📡 [SOCKET] io.engine.clientsCount:", io?.engine?.clientsCount || 0);
        
        const socketPayload = {
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
            leadId: String(lead._id),
            contactId: String(contact._id)
        };
        
        console.log("📡 [SOCKET] Emitindo payload:", JSON.stringify(socketPayload, null, 2));
        
        io.emit("message:new", socketPayload);
        io.emit("whatsapp:new_message", socketPayload);
        
        console.log("✅ [SOCKET] Eventos emitidos com sucesso!");

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

            // 🔁 CANCELAR LEAD RECOVERY se estiver ativo (lead respondeu)
            if (lead.recovery && !lead.recovery.finishedAt && !lead.recovery.cancelledAt) {
                cancelRecovery(lead._id, 'lead_respondeu')
                    .catch(err => console.warn("⚠️ Falha ao cancelar recovery (não crítico):", err.message));
            }

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
                triageStep: lead.triageStep, // 🆕 CRÍTICO: verificar se está vindo
                pendingPatientInfoForScheduling: lead.pendingPatientInfoForScheduling,
                pendingPatientInfoStep: lead.pendingPatientInfoStep,
                pendingChosenSlot: lead.pendingChosenSlot ? "SIM" : "NÃO",
            });

            await handleAutoReply(from, to, contentToSave, lead)
                .catch(err => console.error("⚠️ Auto-reply não crítico falhou:", err));
        }

        // 🔥 AUTO-AGENDADOR DE FOLLOW-UP (Amanda 2.0)
        // ✅ FIX: agora a supressão só impede o auto-followup, sem quebrar o processamento da mensagem
        try {
            if (!suppressAutoFollowup) {
                const freshLead = await Lead.findById(lead._id).select('+triageStep').lean();

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
        // 2. Evita mensagem duplicada IDÊNTICA (10s) - FIX BUG #1
        // ================================
        // 🔧 CORREÇÃO: Usar hash MD5 do conteúdo ao invés de tempo genérico
        try {
            if (redis?.set) {
                const crypto = await import('crypto');
                const contentHash = crypto.createHash('md5').update(content).digest('hex');
                const recentKey = `msg:inbound:${from}:${contentHash}`;

                const exists = await redis.get(recentKey);
                if (exists) {
                    console.log("⏭️ Mensagem idêntica recebida recentemente; evitando duplicação:", content.substring(0, 50));
                    return;
                }

                // Marca como processada por 10s
                await redis.setex(recentKey, 10, '1');
            }
        } catch (hashError) {
            console.warn("⚠️ Redis hash indisponível:", hashError.message);
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

        // ✅ FIX: Recarrega lead do banco para garantir dados mais recentes (incluindo manualControl)
        // O lead passado pode estar desatualizado se manualControl foi ativado após o carregamento inicial
        let leadDoc = await Lead.findById(lead._id).select('+triageStep').lean();
        
        if (!leadDoc) {
            console.log("⏭️ Lead não encontrado no banco; ignorando mensagem", lead?._id);
            return;
        }

        // ✅ FIX: Removido lock manual redundante (isProcessing: true sem processingStartedAt)
        // O withLeadLock na L1702 já faz o lock atômico correto com processingStartedAt

        // No handleAutoReply, após carregar o lead:
        if (leadDoc.pendingChosenSlot === 'NÃO' || leadDoc.pendingSchedulingSlots === 'NÃO') {
            await Lead.findByIdAndUpdate(leadDoc._id, {
                $unset: { pendingChosenSlot: "", pendingSchedulingSlots: "" }
            });
            // Recarrega limpo
            leadDoc = await Lead.findById(leadDoc._id).select('+triageStep').lean();
        }
        // 🔍 DEBUG: Lead carregado do banco no handleAutoReply
        console.log("🔍 [DEBUG HANDLE-AUTO-REPLY] Lead carregado do banco:", {
            leadId: leadDoc?._id,
            triageStep: leadDoc?.triageStep,
            pendingPatientInfoForScheduling: leadDoc?.pendingPatientInfoForScheduling,
            pendingPatientInfoStep: leadDoc?.pendingPatientInfoStep,
            pendingChosenSlot: leadDoc?.pendingChosenSlot ? "SIM" : "NÃO",
            pendingSchedulingSlots: leadDoc?.pendingSchedulingSlots?.primary ? "SIM" : "NÃO",
            manualControl: leadDoc?.manualControl ? {
                active: leadDoc.manualControl.active,
                takenOverAt: leadDoc.manualControl.takenOverAt,
                autoResumeAfter: leadDoc.manualControl.autoResumeAfter
            } : 'NÃO DEFINIDO'
        });

        if (!leadDoc) {
            console.log("⏭️ Lead não encontrado; ignorando mensagem", lead?._id);
            return;
        }

        mongoLockedLeadId = leadDoc._id;

        // ================================
        // 5. Controle manual (human takeover)
        // ================================
        if (!isTestNumber && leadDoc.manualControl?.active) {
            console.log('👤 [CONTROLE MANUAL] Ativo para lead:', leadDoc._id, '-', leadDoc.name);

            const takenAt = leadDoc.manualControl.takenOverAt
                ? new Date(leadDoc.manualControl.takenOverAt)
                : null;

            let aindaPausada = true;
            // 🔧 FIX: Só reativa automaticamente se autoResumeAfter for um número positivo
            // Se for null/undefined/0, mantém pausado indefinidamente (só volta clicando no botão "Ativar")
            const timeout = leadDoc.manualControl?.autoResumeAfter;
            if (typeof timeout === "number" && timeout > 0) {
                // 🔄 Modo com timeout: verifica se já passou o tempo
                if (takenAt) {
                    const minutesSince = (Date.now() - takenAt.getTime()) / (1000 * 60);
                    if (minutesSince > timeout) {
                        await Lead.findByIdAndUpdate(lead._id, { 'manualControl.active': false });
                        aindaPausada = false;
                    }
                }
            } else if (timeout === null || timeout === undefined) {
                // 🔒 Modo sem timeout: mantém pausado indefinidamente
                // Só volta quando o usuário clicar no botão "Ativar"
                console.log('🔒 [CONTROLE MANUAL] Modo permanente ativo - Amanda não volta sozinha');
                aindaPausada = true;
            } else if (!takenAt) {
                // ⚠️ Se não tem takenAt e não tem timeout definido, desativa por segurança
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
        const leadIdStr = leadDoc?._id ? String(leadDoc._id) : null;
        let aiText = null;

        // 🚀 Contexto enriquecido para evitar loadContext redundante no orquestrador
        const enrichedContext = {
            preferredPeriod: leadDoc.preferredPeriod || leadDoc.qualificationData?.extractedInfo?.disponibilidade,
            preferredDate: leadDoc.preferredDate || leadDoc.qualificationData?.extractedInfo?.dataPreferida,
            therapy: leadDoc.therapy || leadDoc.qualificationData?.extractedInfo?.especialidade,
            source: 'whatsapp-inbound'
        };

        // 🚀 ORQUESTRADOR COM LOCK ATÔMICO (feature flag via runOrchestrator)
        const lockResult = await withLeadLock(leadDoc._id, async (lockedLead) => {
            return runOrchestrator(lockedLead, aggregatedContent, enrichedContext);
        });

        if (!lockResult.locked) {
            console.log('🔒 Lead em processamento por outra requisição, ignorando duplicata');
            return;
        }

        const result = lockResult;
        if (result?.command === 'SEND_MESSAGE') {
            aiText = result.payload.text;
        }

        console.log("[AmandaReply] Texto gerado:", aiText ? aiText.substring(0, 80) + '...' : 'vazio');

        // ================================
        // 9. Envia resposta marcada como "amanda"
        // ================================
        if (aiText && aiText.trim()) {
            // 📝 Formata texto para melhor legibilidade no WhatsApp
            const finalText = formatWhatsAppResponse(aiText.trim());

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
        // ✅ FIX: Lock manual removido — withLeadLock() cuida de tudo
        // O releaseLock() no finally do withLeadLock já limpa isProcessing + processingStartedAt

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
        // 🛡️ FIX: Nunca sobrescrever valores existentes com null/undefined/vazio
        if (v === null || v === undefined || v === "") {
            // Se o valor atual existe no out, mantenha-o
            if (out[k] !== undefined && out[k] !== null && out[k] !== "") {
                continue; // Mantém o valor existente
            }
            // Se não existe valor atual e o incoming é nulo, define como null apenas se não existir
            if (!(k in out)) {
                out[k] = v;
            }
            continue;
        }
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
