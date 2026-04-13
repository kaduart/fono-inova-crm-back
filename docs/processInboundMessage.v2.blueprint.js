/**
 * processInboundMessage — V2 BLUEPRINT
 *
 * Este arquivo é um RASCUNHO DE REVISÃO — não é código de produção ainda.
 * Objetivo: mostrar o fluxo limpo antes de aplicar no controller real.
 *
 * DIFERENÇAS DO V1 → V2:
 *  [1] Sem processedWamids Set em memória — Redis SET NX é suficiente e funciona multi-node
 *  [2] contact + patient carregados em paralelo (Promise.all)
 *  [3] lead.save() 3x → Lead.findByIdAndUpdate() único e atômico
 *  [4] analyzeLeadMessage sai da hot path → MESSAGE_RESPONSE_DETECTED já roteia pro worker correto
 *  [5] createSmartFollowup → publishEvent(FOLLOWUP_REQUESTED) — sai do pipeline principal
 *  [6] handleAutoReply permanece mas é o ÚLTIMO passo — nada bloqueia depois dele
 *  [7] cancelRecovery via setImmediate — não bloqueia
 *  [8] Flags de lead (alreadyScheduled etc) consolidadas no único findByIdAndUpdate
 */

import mongoose from 'mongoose';
import { redisConnection as redis } from '../config/redisConnection.js';
import { getIo } from '../config/socket.js';
import Contacts from '../models/Contacts.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
import Patient from '../models/Patient.js';
import { describeWaImage, transcribeWaAudio } from '../services/aiAmandaService.js';
import Logger from '../services/utils/Logger.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { resolveMediaUrl } from '../services/whatsappService.js';
import { normalizeE164BR } from '../utils/phone.js';
import { resolveLeadByPhone } from './leadController.js';
import { deriveFlagsFromText } from '../utils/flagsDetector.js';
import { cancelRecovery } from '../services/leadRecoveryService.js';
import { extractTrackingFromMessage } from '../utils/trackingExtractor.js'; // [V2] extraído para util
import { extractMessageContent } from '../utils/whatsappMediaExtractor.js'; // [V2] extraído para util

const logger = new Logger('whatsappController.v2');

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK — entry point (chamado pelo Meta)
// ─────────────────────────────────────────────────────────────────────────────
export async function webhook(req, res) {
    // [V2] ACK IMEDIATO — antes de qualquer lógica
    res.sendStatus(200);

    // [V2] Raw log APÓS o ACK — não adiciona latência percebida pelo Meta
    mongoose.connection.collection('raw_webhook_logs').insertOne({
        body: req.body,
        receivedAt: new Date(),
        source: 'whatsapp_webhook'
    }).catch(err => logger.warn('raw_log_fail', { err: err.message }));

    try {
        const change = req.body.entry?.[0]?.changes?.[0];
        const value  = change?.value;

        // Statuses de entrega (não é mensagem recebida)
        if (value?.statuses?.length > 0) {
            for (const status of value.statuses) {
                await processMessageStatus(status); // mantido igual ao V1
            }
            return;
        }

        const msg = value?.messages?.[0];
        if (!msg) return;

        const messageId = msg.id;
        const from      = msg.from;

        // [V2] ÚNICA camada de dedup — Redis SET NX atômico, funciona multi-node
        const idempotencyKey = `msg:processed:${messageId}`;
        try {
            const lock = await redis?.set(idempotencyKey, '1', 'NX', 'EX', 300);
            if (!lock) {
                logger.info('webhook_dedup_skip', { messageId });
                return;
            }
        } catch (redisErr) {
            logger.warn('webhook_dedup_redis_unavailable', { err: redisErr.message });
            // continua sem dedup se Redis cair
        }

        // Debounce buffer (3.5s) — acumula mensagens rápidas do mesmo número
        const debounceKey    = `webhook:buffer:${from}`;
        const processingKey  = `webhook:processing:${from}`;

        try {
            const existing = await redis?.get(debounceKey);
            if (existing) {
                const data = JSON.parse(existing);
                data.messages.push(msg.text?.body || '');
                data.lastTime = Date.now();
                await redis?.set(debounceKey, JSON.stringify(data), 'EX', 10);
                logger.info('webhook_buffer_accumulated', { from, count: data.messages.length });
                return;
            }

            await redis?.set(debounceKey, JSON.stringify({
                messages: [msg.text?.body || ''],
                startTime: Date.now(),
                msgData: msg,
                messageId: msg.id
            }), 'EX', 10);
        } catch (redisErr) {
            logger.warn('webhook_debounce_redis_unavailable', { err: redisErr.message });
            // [V2] fallback direto — sem setTimeout, só publica sem delay
            await publishEvent(EventTypes.WHATSAPP_MESSAGE_RECEIVED, { msg, value });
            return;
        }

        // Agenda processamento com delay para o worker consumir o buffer
        await publishEvent(
            EventTypes.WHATSAPP_MESSAGE_RECEIVED,
            { msg, value, _debounceKey: debounceKey, _processingKey: processingKey, _isDebounced: true },
            { delay: 3500, correlationId: `webhook:${msg.id}`, idempotencyKey: `webhook:${from}:${msg.id}` }
        );

        logger.info('webhook_scheduled', { messageId, from });

    } catch (err) {
        logger.error('webhook_critical_error', { err: err.message, stack: err.stack });
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// CORE — chamado pelo whatsappInboundWorker
// ─────────────────────────────────────────────────────────────────────────────
export async function processInboundMessage(msg, value) {
    const wamid = msg.id;

    // [V2] Sem processedWamids Set — Redis no webhook já garante dedup
    // (worker pode ter concurrency > 1, Redis é a única fonte de verdade)

    try {
        const io = getIo();

        // ── 1. NORMALIZAÇÃO DE TELEFONE ──────────────────────────────────────
        const fromRaw = msg.from || '';
        const toRaw   = value?.metadata?.display_phone_number || process.env.CLINIC_PHONE_E164 || '0000000000000';
        const from    = normalizeE164BR(fromRaw);
        const to      = normalizeE164BR(toRaw) || '0000000000000';
        const type    = msg.type;

        logger.info('inbound_message_start', { wamid, from, type });

        // ── 2. EXTRAÇÃO DE CONTEÚDO (media/text/audio/image) ─────────────────
        // [V2] extraído para util — controller não conhece detalhes de mídia
        const { content, mediaUrl, mediaId, caption } = await extractMessageContent(msg, type);
        //
        // extractMessageContent encapsula toda a lógica de:
        //   text → msg.text.body
        //   audio → transcribeWaAudio({ mediaId })
        //   image → describeWaImage({ mediaId, mediaUrl, mimeType })
        //   video/document/sticker → resolveMediaUrl
        //   location → msg.location.name || address

        const contentToSave = (
            type === 'text' || type === 'audio' || type === 'image' || type === 'location'
                ? content
                : (caption || `[${String(type || 'unknown').toUpperCase()}]`)
        );

        const timestamp = new Date((parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000);

        // ── 3. TRACKING (Google Ads / Meta) ──────────────────────────────────
        const trackingData = extractTrackingFromMessage(contentToSave);

        // ── 4. FLAGS RÁPIDAS ─────────────────────────────────────────────────
        const quickFlags = deriveFlagsFromText(contentToSave || '');
        const suppressAutoFollowup =
            quickFlags.alreadyScheduled   ||
            quickFlags.wantsCancel        ||
            quickFlags.wantsReschedule    ||
            quickFlags.refusesOrDenies    ||
            quickFlags.wantsPartnershipOrResume ||
            quickFlags.saysThanks         ||
            quickFlags.saysBye;

        // ── 5. RESOLUÇÃO DE ENTIDADES (PARALELO) ─────────────────────────────
        // [V2] contact + patient em paralelo — independentes entre si
        const [contactResult, patient] = await Promise.all([
            Contacts.findOne({ phone: from }).then(c =>
                c || Contacts.create({
                    phone: from,
                    name: msg.profile?.name || `WhatsApp ${from.slice(-4)}`
                })
            ),
            Patient.findOne({ phone: from }).lean().catch(() => null),
        ]);
        const contact = contactResult;

        // Lead depende do patient (para leadDefaults) — sequencial após Promise.all
        const leadDefaults = buildLeadDefaults(patient, contentToSave, trackingData);
        const lead = await resolveLeadByPhone(from, leadDefaults);

        if (!lead?._id) {
            logger.error('resolve_lead_failed', { from, patientId: patient?._id });
            return;
        }

        // Destrava lead de teste automaticamente
        const fromNumeric  = from.replace(/\D/g, '');
        const AUTO_TEST_NUMBERS = ['5561981694922', '556292013573', '5562992013573'];
        if (AUTO_TEST_NUMBERS.includes(fromNumeric)) {
            await Lead.findByIdAndUpdate(lead._id, {
                $set: {
                    'manualControl.active': false,
                    'manualControl.takenOverAt': null,
                    'manualControl.takenOverBy': null,
                    'manualControl.autoResumeAfter': 0,
                    autoReplyEnabled: true,
                }
            });
            lead.manualControl = { active: false };
            lead.autoReplyEnabled = true;
        }

        // ── 6. PERSISTÊNCIA DA MENSAGEM ──────────────────────────────────────
        const savedMessage = await Message.create({
            waMessageId: wamid,
            wamid,
            from,
            to,
            direction: 'inbound',
            type,
            content: contentToSave,
            mediaUrl,
            mediaId,
            caption,
            status: 'received',
            needs_human_review: !(type === 'text' || type === 'audio' || type === 'image'),
            timestamp,
            contact: contact._id,
            lead: lead._id,
            ...(type === 'location' && msg.location ? { location: msg.location } : {}),
            raw: msg,
        });

        // ── 7. NOTIFICAÇÃO UI (imediata) ─────────────────────────────────────
        const socketPayload = {
            id:          String(savedMessage._id),
            from, to,
            direction:   'inbound',
            type,
            content:     contentToSave,
            text:        contentToSave,
            mediaUrl, mediaId, caption,
            status:      'received',
            timestamp:   timestamp.toISOString(),
            timestampMs: timestamp.getTime(),
            leadId:      String(lead._id),
            contactId:   String(contact._id),
        };
        io.emit('message:new', socketPayload);
        io.emit('whatsapp:new_message', socketPayload);

        // ── 8. UPDATE DO LEAD (ÚNICO WRITE ATÔMICO) ──────────────────────────
        // [V2] Substitui lead.save() x3 — um único findByIdAndUpdate com tudo
        const leadUpdate = {
            $set: {
                lastInteractionAt: new Date(),
                ...(quickFlags.alreadyScheduled && { alreadyScheduled: true }),
                ...(quickFlags.wantsPartnershipOrResume && { reason: 'parceria_profissional' }),
            },
            $push: {
                interactions: {
                    date: new Date(),
                    channel: 'whatsapp',
                    direction: 'inbound',
                    message: contentToSave,
                    status: 'received',
                },
            },
            ...(quickFlags.alreadyScheduled || quickFlags.wantsPartnershipOrResume
                ? {
                    $addToSet: {
                        flags: quickFlags.alreadyScheduled ? 'already_scheduled' : 'parceria_profissional',
                    },
                }
                : {}),
        };
        await Lead.findByIdAndUpdate(lead._id, leadUpdate);

        // Update de lastMessageAt no contact (não bloqueia)
        contact.lastMessageAt       = timestamp;
        contact.lastMessagePreview  = contentToSave?.substring(0, 100) || `[${String(type).toUpperCase()}]`;
        contact.save().catch(err => logger.warn('contact_save_failed', { err: err.message }));

        // ── 9. CANCELAR RECOVERY SE ATIVO (fire-and-forget) ─────────────────
        if (lead.recovery && !lead.recovery.finishedAt && !lead.recovery.cancelledAt) {
            setImmediate(() =>
                cancelRecovery(lead._id, 'lead_respondeu')
                    .catch(err => logger.warn('cancel_recovery_failed', { err: err.message }))
            );
        }

        // ── 10. ANÁLISE DE LEAD (ASYNC — sai da hot path) ───────────────────
        // [V2] MESSAGE_RESPONSE_DETECTED já roteia para 'whatsapp-message-response' worker
        //      que roda analyzeLeadMessage + atualiza qualificationData/score de forma assíncrona
        //      sem bloquear a resposta da Amanda
        const isRealText = contentToSave?.trim() && !contentToSave.startsWith('[');
        if ((type === 'text' || type === 'audio' || type === 'image') && isRealText) {
            publishEvent(EventTypes.MESSAGE_RESPONSE_DETECTED, {
                leadId:      String(lead._id),
                waMessageId: wamid,
                messageId:   savedMessage._id?.toString() || null,
                content:     contentToSave, // [V2] passa o texto para o worker fazer análise
            }).catch(err => logger.warn('message_response_event_failed', { err: err.message }));
        }

        // ── 11. AUTO-REPLY (Amanda) ──────────────────────────────────────────
        // Permanece aqui pois é o core do fluxo Amanda
        // handleAutoReply usa withLeadLock internamente — já tem proteção contra corrida
        if ((type === 'text' || type === 'audio' || type === 'image') && isRealText) {
            await handleAutoReply(from, to, contentToSave, lead)
                .catch(err => logger.warn('auto_reply_failed', { err: err.message }));
        }

        // ── 12. FOLLOW-UP INTELIGENTE (ASYNC — sai da hot path) ─────────────
        // [V2] publishEvent(FOLLOWUP_REQUESTED) → followup-processing worker
        //      substitui createSmartFollowupForLead inline
        if (!suppressAutoFollowup) {
            publishEvent(EventTypes.FOLLOWUP_REQUESTED, {
                leadId:    String(lead._id),
                objective: 'reengajamento_inbound',
                attempt:   1,
                source:    'inbound_message',
            }).catch(err => logger.warn('followup_event_failed', { err: err.message }));
        }

        logger.info('inbound_message_done', { wamid, from });

    } catch (error) {
        logger.error('inbound_message_critical_error', { wamid, err: error.message, stack: error.stack });
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// HELPERS EXTRAÍDOS (inline → util)
// ─────────────────────────────────────────────────────────────────────────────

function buildLeadDefaults(patient, contentToSave, trackingData) {
    const trackingFields = trackingData
        ? {
            origin:      trackingData.source === 'google_ads' ? 'Google Ads' : trackingData.source === 'meta_ads' ? 'Meta Ads' : trackingData.utmSource || 'WhatsApp',
            gclid:       trackingData.clickId?.startsWith('gclid')  ? trackingData.clickId : undefined,
            fbclid:      trackingData.clickId?.startsWith('fbclid') ? trackingData.clickId : undefined,
            utmCampaign: trackingData.campaign,
            utmSource:   trackingData.utmSource,
            utmMedium:   trackingData.utmMedium,
        }
        : {};

    if (patient) {
        return {
            name:               patient.fullName,
            status:             'virou_paciente',
            convertedToPatient: patient._id,
            conversionScore:    100,
            firstMessage:       contentToSave,
            ...trackingFields,
        };
    }

    return {
        status:         'novo',
        conversionScore: 0,
        firstMessage:   contentToSave,
        ...trackingFields,
    };
}


// ─────────────────────────────────────────────────────────────────────────────
// MAPA DE EVENTOS V2 (referência)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * webhook
 *   └─ publishEvent(WHATSAPP_MESSAGE_RECEIVED, delay=3500)
 *         └─ whatsapp-inbound worker
 *               └─ processInboundMessage()
 *                     ├─ Message.create()
 *                     ├─ io.emit(message:new)               ← UI imediato
 *                     ├─ Lead.findByIdAndUpdate()           ← único write
 *                     ├─ publishEvent(MESSAGE_RESPONSE_DETECTED)
 *                     │     └─ whatsapp-message-response worker
 *                     │           └─ analyzeLeadMessage()
 *                     │           └─ Lead.findByIdAndUpdate(qualificationData, score)
 *                     ├─ handleAutoReply()                  ← Amanda responde
 *                     └─ publishEvent(FOLLOWUP_REQUESTED)
 *                           └─ followup-processing worker
 *                                 └─ createSmartFollowupForLead()
 */
