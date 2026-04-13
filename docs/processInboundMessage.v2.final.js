/**
 * processInboundMessage — V2 FINAL (production-grade)
 *
 * Correções aplicadas sobre o blueprint anterior:
 *
 *  [FIX-1] handleAutoReply saiu do hot path → publishEvent(WHATSAPP_AUTO_REPLY_REQUESTED)
 *          - elimina risco de dupla resposta com MESSAGE_RESPONSE_DETECTED
 *          - separa AI de análise vs AI de resposta
 *          - worker de auto-reply pode ter concurrency=1 por lead (LockManager)
 *
 *  [FIX-2] contact.save() → Contacts.updateOne() — escrita controlada, sem side-effect
 *
 *  [FIX-3] cancelRecovery → publishEvent(LEAD_RECOVERY_CANCEL_REQUESTED) — rastreável
 *
 *  [FIX-4] correlationId propagado em TODOS os eventos — permite rastrear uma mensagem
 *          do webhook até o envio da resposta da Amanda
 *
 *  [MANTIDO] debounce buffer inline no webhook — funciona, mover para worker é fase 2
 *  [MANTIDO] resolveLeadByPhone inline — refatorar para worker é fase 2
 *
 * NOVOS EVENTOS NECESSÁRIOS (adicionar no EventTypes + roteador):
 *   WHATSAPP_AUTO_REPLY_REQUESTED → 'whatsapp-auto-reply'   (worker novo)
 *   LEAD_RECOVERY_CANCEL_REQUESTED → 'lead-recovery'        (worker existente ou novo)
 *
 * WORKERS RESULTANTES:
 *   whatsapp-inbound         → processInboundMessage (este arquivo)
 *   whatsapp-message-response → analyzeLeadMessage + updateQualificationData
 *   whatsapp-auto-reply      → handleAutoReply (Amanda FSM / orquestrador)   ← NOVO
 *   followup-processing      → createSmartFollowupForLead
 *   lead-recovery            → cancelRecovery
 */

import { getIo }           from '../config/socket.js';
import { redisConnection as redis } from '../config/redisConnection.js';
import Contacts             from '../models/Contacts.js';
import Lead                 from '../models/Leads.js';
import Message              from '../models/Message.js';
import Patient              from '../models/Patient.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { normalizeE164BR }  from '../utils/phone.js';
import { resolveLeadByPhone } from './leadController.js';
import { deriveFlagsFromText } from '../utils/flagsDetector.js';
import { extractTrackingFromMessage } from '../utils/trackingExtractor.js';
import { extractMessageContent }      from '../utils/whatsappMediaExtractor.js';
import { createContextLogger }        from '../utils/logger.js';

const AUTO_TEST_NUMBERS = ['5561981694922', '556292013573', '5562992013573'];


// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK — ultra leve, só ingestão
// ─────────────────────────────────────────────────────────────────────────────
export async function webhook(req, res) {
    // ACK antes de tudo — Meta exige resposta < 5s
    res.sendStatus(200);

    // Raw log após ACK — não adiciona latência percebida pelo Meta
    mongoose.connection.collection('raw_webhook_logs')
        .insertOne({ body: req.body, receivedAt: new Date(), source: 'whatsapp_webhook' })
        .catch(() => {}); // nunca quebra o fluxo

    try {
        const value = req.body.entry?.[0]?.changes?.[0]?.value;
        if (!value) return;

        // Statuses de entrega (read receipts, delivered, etc.)
        if (value.statuses?.length > 0) {
            for (const status of value.statuses) {
                await processMessageStatus(status);
            }
            return;
        }

        const msg = value.messages?.[0];
        if (!msg) return;

        const { id: messageId, from } = msg;

        // Dedup atômico — única camada, funciona multi-node
        const idempotencyKey = `msg:processed:${messageId}`;
        try {
            const acquired = await redis?.set(idempotencyKey, '1', 'NX', 'EX', 300);
            if (!acquired) return; // já processado
        } catch {
            // Redis indisponível — continua sem dedup (aceitável, worker tem dedup próprio)
        }

        // Debounce buffer: acumula mensagens rápidas do mesmo remetente por 3.5s
        const debounceKey = `webhook:buffer:${from}`;
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
            // Redis caiu: publica sem debounce (mensagem não será combinada, mas não se perde)
            await publishEvent(EventTypes.WHATSAPP_MESSAGE_RECEIVED, { msg, value });
            return;
        }

        // Agenda processamento com delay — worker lê o buffer e combina mensagens acumuladas
        await publishEvent(
            EventTypes.WHATSAPP_MESSAGE_RECEIVED,
            { msg, value, _debounceKey: debounceKey, _isDebounced: true },
            {
                delay:          3500,
                correlationId:  `wh:${messageId}`,
                idempotencyKey: `webhook:${from}:${messageId}`,
            }
        );

    } catch (err) {
        // Log sem crash — webhook nunca deve lançar exceção para o Meta
        createContextLogger('webhook').error('webhook_critical', { err: err.message });
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// CORE — chamado pelo whatsappInboundWorker
// ─────────────────────────────────────────────────────────────────────────────
export async function processInboundMessage(msg, value) {
    const wamid          = msg.id;
    const correlationId  = `inbound:${wamid}`; // propagado em TODOS os eventos filhos
    const log            = createContextLogger('processInboundMessage');

    try {
        const io = getIo();

        // ── 1. NORMALIZAÇÃO ──────────────────────────────────────────────────
        const from = normalizeE164BR(msg.from || '');
        const to   = normalizeE164BR(
            value?.metadata?.display_phone_number || process.env.CLINIC_PHONE_E164
        ) || '0000000000000';
        const type = msg.type;

        log.info('start', { wamid, from, type, correlationId });

        // ── 2. EXTRAÇÃO DE CONTEÚDO ──────────────────────────────────────────
        // Toda lógica de mídia fica em utils/whatsappMediaExtractor.js
        const { content, mediaUrl, mediaId, caption } = await extractMessageContent(msg, type);
        const contentToSave = (
            ['text', 'audio', 'image', 'location'].includes(type)
                ? content
                : (caption || `[${String(type || 'unknown').toUpperCase()}]`)
        );
        const timestamp = new Date((parseInt(msg.timestamp, 10) || Date.now() / 1000) * 1000);

        // ── 3. CLASSIFICAÇÃO RÁPIDA ──────────────────────────────────────────
        const trackingData      = extractTrackingFromMessage(contentToSave);
        const quickFlags        = deriveFlagsFromText(contentToSave || '');
        const suppressFollowup  = (
            quickFlags.alreadyScheduled         ||
            quickFlags.wantsCancel              ||
            quickFlags.wantsReschedule          ||
            quickFlags.refusesOrDenies          ||
            quickFlags.wantsPartnershipOrResume ||
            quickFlags.saysThanks               ||
            quickFlags.saysBye
        );
        const isRealText = !!(contentToSave?.trim() && !contentToSave.startsWith('['));

        // ── 4. ENTIDADES (PARALELO) ──────────────────────────────────────────
        // contact + patient são independentes → Promise.all
        // lead depende de patient (para leadDefaults) → depois
        const [contact, patient] = await Promise.all([
            Contacts.findOne({ phone: from })
                .then(c => c || Contacts.create({
                    phone: from,
                    name:  msg.profile?.name || `WhatsApp ${from.slice(-4)}`,
                })),
            Patient.findOne({ phone: from }).lean().catch(() => null),
        ]);

        const lead = await resolveLeadByPhone(from, buildLeadDefaults(patient, contentToSave, trackingData));
        if (!lead?._id) {
            log.error('resolve_lead_failed', { from });
            return;
        }

        // Destrava leads de teste (nunca entram em manualControl)
        if (AUTO_TEST_NUMBERS.includes(from.replace(/\D/g, ''))) {
            await Lead.findByIdAndUpdate(lead._id, {
                $set: {
                    'manualControl.active':          false,
                    'manualControl.takenOverAt':     null,
                    'manualControl.takenOverBy':     null,
                    'manualControl.autoResumeAfter': 0,
                    autoReplyEnabled:                true,
                },
            });
            lead.manualControl   = { active: false };
            lead.autoReplyEnabled = true;
        }

        // ── 5. PERSISTÊNCIA DA MENSAGEM ──────────────────────────────────────
        const savedMessage = await Message.create({
            waMessageId:        wamid,
            wamid,
            from, to,
            direction:          'inbound',
            type,
            content:            contentToSave,
            mediaUrl, mediaId, caption,
            status:             'received',
            needs_human_review: !['text', 'audio', 'image'].includes(type),
            timestamp,
            contact:            contact._id,
            lead:               lead._id,
            ...(type === 'location' && msg.location ? { location: msg.location } : {}),
            raw: msg,
        });

        // ── 6. NOTIFICAÇÃO UI (imediata, não bloqueia nada) ──────────────────
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
        io.emit('message:new',          socketPayload);
        io.emit('whatsapp:new_message', socketPayload);

        // ── 7. LEAD UPDATE — ÚNICO WRITE ATÔMICO ────────────────────────────
        // [FIX-1] Substitui lead.save() x3
        // Todas as mutações do lead neste fluxo consolidadas aqui
        await Lead.findByIdAndUpdate(lead._id, {
            $set: {
                lastInteractionAt: new Date(),
                ...(quickFlags.alreadyScheduled        && { alreadyScheduled: true }),
                ...(quickFlags.wantsPartnershipOrResume && { reason: 'parceria_profissional' }),
            },
            $push: {
                interactions: {
                    date:      new Date(),
                    channel:   'whatsapp',
                    direction: 'inbound',
                    message:   contentToSave,
                    status:    'received',
                },
            },
            ...(quickFlags.alreadyScheduled || quickFlags.wantsPartnershipOrResume
                ? { $addToSet: { flags: quickFlags.alreadyScheduled ? 'already_scheduled' : 'parceria_profissional' } }
                : {}),
        });

        // ── 8. CONTACT UPDATE — escrita controlada ───────────────────────────
        // [FIX-2] contact.save() → updateOne (sem side-effect de full-document save)
        await Contacts.updateOne(
            { _id: contact._id },
            { $set: { lastMessageAt: timestamp, lastMessagePreview: contentToSave?.substring(0, 100) } }
        );

        // ── 9. CANCELAR RECOVERY — rastreável ────────────────────────────────
        // [FIX-3] setImmediate → evento explícito
        if (lead.recovery && !lead.recovery.finishedAt && !lead.recovery.cancelledAt) {
            publishEvent('LEAD_RECOVERY_CANCEL_REQUESTED', {   // adicionar ao EventTypes
                leadId: String(lead._id),
                reason: 'lead_respondeu',
            }, { correlationId }).catch(() => {});
        }

        // ── 10. ANÁLISE DE LEAD (worker separado, sem bloquear) ──────────────
        // MESSAGE_RESPONSE_DETECTED → whatsapp-message-response worker
        //   faz: analyzeLeadMessage() + Lead.findByIdAndUpdate(qualificationData, score)
        // [FIX-1] NÃO faz mais auto-reply — separação limpa de responsabilidade
        if (isRealText && ['text', 'audio', 'image'].includes(type)) {
            publishEvent(EventTypes.MESSAGE_RESPONSE_DETECTED, {
                leadId:      String(lead._id),
                waMessageId: wamid,
                messageId:   savedMessage._id?.toString(),
                content:     contentToSave,
            }, { correlationId }).catch(() => {});
        }

        // ── 11. AUTO-REPLY AMANDA (worker separado, sem bloquear) ────────────
        // [FIX-1] handleAutoReply SAI do hot path → WHATSAPP_AUTO_REPLY_REQUESTED
        //
        // Worker 'whatsapp-auto-reply' recebe o evento e faz:
        //   1. Lead.findById() para pegar estado mais recente (inclui qualificationData fresco)
        //   2. Verifica manualControl.active → se true, não responde
        //   3. withLeadLock() → garante que só 1 instância responde por vez
        //   4. runOrchestrator(lead, content, context) → Amanda FSM ou legacy
        //   5. sendTextMessage() + Message.create(outbound)
        //   6. io.emit(message:new, outbound)
        //
        // NOTA: worker deve ter concurrency=1 por leadId para evitar respostas paralelas
        //       Usar jobId: `auto-reply:${leadId}` + removeOnFail: false para observabilidade
        if (isRealText && ['text', 'audio', 'image'].includes(type)) {
            publishEvent('WHATSAPP_AUTO_REPLY_REQUESTED', {   // adicionar ao EventTypes
                leadId:    String(lead._id),
                from, to,
                content:   contentToSave,
                messageId: savedMessage._id?.toString(),
                wamid,
            }, {
                correlationId,
                jobId: `auto-reply:${lead._id}`,  // dedup por lead — sem resposta duplicada
            }).catch(() => {});
        }

        // ── 12. FOLLOW-UP INTELIGENTE (worker separado) ──────────────────────
        // followup-processing worker verifica se já existe followup futuro antes de criar
        if (!suppressFollowup) {
            publishEvent(EventTypes.FOLLOWUP_REQUESTED, {
                leadId:    String(lead._id),
                objective: 'reengajamento_inbound',
                attempt:   1,
                source:    'inbound_message',
            }, { correlationId }).catch(() => {});
        }

        log.info('done', { wamid, from, correlationId });

    } catch (err) {
        createContextLogger('processInboundMessage')
            .error('critical_error', { wamid, correlationId, err: err.message, stack: err.stack });
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// HELPER — buildLeadDefaults
// ─────────────────────────────────────────────────────────────────────────────
function buildLeadDefaults(patient, contentToSave, trackingData) {
    const tracking = trackingData ? {
        origin:      trackingData.source === 'google_ads' ? 'Google Ads'
                   : trackingData.source === 'meta_ads'   ? 'Meta Ads'
                   : trackingData.utmSource || 'WhatsApp',
        gclid:       trackingData.clickId?.startsWith('gclid')  ? trackingData.clickId : undefined,
        fbclid:      trackingData.clickId?.startsWith('fbclid') ? trackingData.clickId : undefined,
        utmCampaign: trackingData.campaign,
        utmSource:   trackingData.utmSource,
        utmMedium:   trackingData.utmMedium,
    } : {};

    return patient
        ? { name: patient.fullName, status: 'virou_paciente', convertedToPatient: patient._id, conversionScore: 100, firstMessage: contentToSave, ...tracking }
        : { status: 'novo', conversionScore: 0, firstMessage: contentToSave, ...tracking };
}


// ─────────────────────────────────────────────────────────────────────────────
// PENDÊNCIAS DE INFRA (o que precisa ser adicionado além deste arquivo)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 1. EventTypes (eventPublisher.js) — adicionar:
 *      WHATSAPP_AUTO_REPLY_REQUESTED: 'WHATSAPP_AUTO_REPLY_REQUESTED'
 *      LEAD_RECOVERY_CANCEL_REQUESTED: 'LEAD_RECOVERY_CANCEL_REQUESTED'
 *
 * 2. Roteador de filas (eventPublisher.js) — adicionar:
 *      [EventTypes.WHATSAPP_AUTO_REPLY_REQUESTED]: 'whatsapp-auto-reply'
 *      [EventTypes.LEAD_RECOVERY_CANCEL_REQUESTED]: 'lead-recovery'
 *
 * 3. Novo worker: domains/whatsapp/workers/whatsappAutoReplyWorker.js
 *      - Extrai handleAutoReply do controller atual
 *      - Adiciona concurrency=1 via jobId único por leadId
 *      - Carrega lead fresh do banco (qualificationData atualizado pelo worker de análise)
 *
 * 4. Utilitários novos (extração de código já existente no controller):
 *      utils/whatsappMediaExtractor.js   — extractMessageContent()
 *      utils/trackingExtractor.js        — extractTrackingFromMessage()
 *
 * 5. whatsapp-message-response worker — AJUSTAR para:
 *      - receber o campo 'content' no payload (adicionado no passo 10)
 *      - rodar analyzeLeadMessage(content, lead) e atualizar qualificationData
 *      - NÃO mais disparar auto-reply (responsabilidade do novo worker)
 */


// ─────────────────────────────────────────────────────────────────────────────
// MAPA FINAL DE EVENTOS (grafo completo)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Meta WhatsApp
 *   └─ POST /webhook
 *         ├─ res.sendStatus(200)                    ← ACK imediato
 *         └─ publishEvent(WHATSAPP_MESSAGE_RECEIVED, delay=3500)
 *               └─ whatsapp-inbound worker
 *                     └─ processInboundMessage()
 *                           ├─ Message.create()
 *                           ├─ io.emit(message:new)          ← UI imediato
 *                           ├─ Lead.findByIdAndUpdate()      ← 1 write
 *                           ├─ Contacts.updateOne()          ← 1 write
 *                           │
 *                           ├─ publishEvent(LEAD_RECOVERY_CANCEL_REQUESTED)
 *                           │     └─ lead-recovery worker
 *                           │           └─ cancelRecovery()
 *                           │
 *                           ├─ publishEvent(MESSAGE_RESPONSE_DETECTED)
 *                           │     └─ whatsapp-message-response worker
 *                           │           ├─ analyzeLeadMessage()
 *                           │           └─ Lead.findByIdAndUpdate(qualificationData, score)
 *                           │
 *                           ├─ publishEvent(WHATSAPP_AUTO_REPLY_REQUESTED)  ← NOVO
 *                           │     └─ whatsapp-auto-reply worker
 *                           │           ├─ Lead.findById() (fresh, com qualificationData)
 *                           │           ├─ verifica manualControl
 *                           │           ├─ withLeadLock()
 *                           │           ├─ runOrchestrator() (Amanda FSM)
 *                           │           ├─ sendTextMessage()
 *                           │           └─ io.emit(message:new, outbound)
 *                           │
 *                           └─ publishEvent(FOLLOWUP_REQUESTED)
 *                                 └─ followup-processing worker
 *                                       └─ createSmartFollowupForLead()
 */
