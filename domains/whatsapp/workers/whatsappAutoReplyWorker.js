/**
 * whatsappAutoReplyWorker.js
 *
 * Consome: WHATSAPP_AUTO_REPLY_REQUESTED → fila: whatsapp-auto-reply
 *
 * Responsabilidade única: decidir se Amanda responde e enviar a resposta.
 *
 * Extraído de handleAutoReply() (whatsappController.js) + isolado como worker.
 *
 * GARANTIAS DESTE WORKER:
 *  [1] Carrega o lead FRESH do banco — pega qualificationData atualizado pelo
 *      whatsapp-message-response worker (que roda em paralelo com este)
 *  [2] Verifica manualControl antes de qualquer AI call — sem custo desnecessário
 *  [3] withLeadLock() garante que só 1 instância responde por leadId por vez
 *  [4] jobId único por leadId (definido no publishEvent) — BullMQ descarta duplicatas
 *  [5] Redis lock (ai:lock:{from}) liberado no finally — nunca vaza
 *
 * CONCORRÊNCIA:
 *   concurrency: 5  — paraleliza entre leads diferentes
 *   jobId: auto-reply:{leadId}  — serializa por lead (definido no publisher)
 */

import { Worker } from 'bullmq';
import { bullMqConnection, redisConnection as redis } from '../../../config/redisConnection.js';
import { moveToDLQ } from '../../../infrastructure/queue/queueConfig.js';
import Lead     from '../../../models/Leads.js';
import Contacts from '../../../models/Contacts.js';
import Message  from '../../../models/Message.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { withLeadLock }    from '../../../services/LockManager.js';
import { runOrchestrator }      from '../../../services/orchestrator/runOrchestrator.js';
import { formatWhatsAppResponse } from '../../../utils/whatsappFormatter.js';
import { createContextLogger }    from '../../../utils/logger.js';

const logger = createContextLogger('whatsappAutoReplyWorker');

const AUTO_TEST_NUMBERS = ['5561981694922', '556292013573', '5562992013573'];

export function createWhatsappAutoReplyWorker() {
    const worker = new Worker(
        'whatsapp-auto-reply',
        async (job) => {
            const { leadId, from, to, content, messageId, wamid } = job.data.payload ?? job.data;
            const correlationId = job.data.metadata?.correlationId || `auto-reply:${wamid}`;

            logger.info('start', { leadId, from, wamid, correlationId });

            // ── 1. LOCK REDIS — previne corrida entre workers ─────────────────
            // Nota: jobId único por leadId já previne múltiplos jobs simultâneos
            // Este lock protege contra edge cases de restart / requeue
            const lockKey = `ai:lock:${from}`;
            let lockAcquired = false;

            try {
                const ok = await redis?.set(lockKey, '1', 'EX', 60, 'NX');
                if (!ok) {
                    logger.info('lock_busy_skip', { leadId, from, correlationId });
                    // Não relança — job descartado intencionalmente (lead já está sendo processado)
                    return { status: 'skipped', reason: 'LOCK_BUSY' };
                }
                lockAcquired = true;
            } catch (redisErr) {
                logger.warn('lock_redis_unavailable', { err: redisErr.message });
                // Continua sem lock — aceita o risco em favor de disponibilidade
            }

            try {
                // ── 2. CARREGA LEAD FRESH ─────────────────────────────────────
                // Pega qualificationData atualizado pelo whatsapp-message-response worker
                // select('+triageStep') necessário pois é campo privado no schema
                let leadDoc = await Lead.findById(leadId).select('+triageStep').lean();

                if (!leadDoc) {
                    logger.warn('lead_not_found', { leadId, correlationId });
                    return { status: 'skipped', reason: 'LEAD_NOT_FOUND' };
                }

                // Limpa campos corrompidos de estado pendente
                if (leadDoc.pendingChosenSlot === 'NÃO' || leadDoc.pendingSchedulingSlots === 'NÃO') {
                    await Lead.findByIdAndUpdate(leadId, {
                        $unset: { pendingChosenSlot: '', pendingSchedulingSlots: '' },
                    });
                    leadDoc = await Lead.findById(leadId).select('+triageStep').lean();
                }

                // ── 3. VERIFICAÇÕES DE GUARD (sem AI call) ───────────────────
                const fromNumeric = from.replace(/\D/g, '');
                const isTestNumber = AUTO_TEST_NUMBERS.includes(fromNumeric);

                // Guard: controle manual ativo
                if (!isTestNumber && leadDoc.manualControl?.active) {
                    const takenAt  = leadDoc.manualControl.takenOverAt
                        ? new Date(leadDoc.manualControl.takenOverAt)
                        : null;
                    const timeout  = leadDoc.manualControl?.autoResumeAfter;
                    let stillPaused = true;

                    if (typeof timeout === 'number' && timeout > 0 && takenAt) {
                        const minutesSince = (Date.now() - takenAt.getTime()) / (1000 * 60);
                        if (minutesSince > timeout) {
                            await Lead.findByIdAndUpdate(leadId, { 'manualControl.active': false });
                            stillPaused = false;
                        }
                    } else if (!takenAt && timeout == null) {
                        // Sem takenAt e sem timeout → desativa por segurança
                        await Lead.findByIdAndUpdate(leadId, { 'manualControl.active': false });
                        stillPaused = false;
                    }
                    // timeout === null/undefined com takenAt → modo permanente, não desativa

                    if (stillPaused) {
                        logger.info('manual_control_active_skip', { leadId, correlationId });
                        return { status: 'skipped', reason: 'MANUAL_CONTROL' };
                    }
                }

                // Guard: auto reply desativado explicitamente
                if (leadDoc.autoReplyEnabled === false) {
                    logger.info('auto_reply_disabled_skip', { leadId, correlationId });
                    return { status: 'skipped', reason: 'AUTO_REPLY_DISABLED' };
                }

                // ── 4. HISTÓRICO DE CONTEXTO ──────────────────────────────────
                const histDocs = await Message.find({
                    $or: [{ from }, { to: from }],
                    type: 'text',
                }).sort({ timestamp: -1 }).limit(12).lean();

                const lastMessages = histDocs.reverse().map(m => (m.content || m.text || '').toString());
                const greetingsRegex = /^(oi|ol[aá]|boa\s*(tarde|noite|dia)|tudo\s*bem|bom\s*dia|fala|e[aíi])[\s!,.]*$/i;
                const isFirstContact = lastMessages.length <= 1 || greetingsRegex.test(content.trim());

                // ── 5a. INTENT HINT (resposta de follow-up classificada) ─────
                // Escrito pelo fsmRouterWorker quando lead responde a um follow-up.
                // Consumido atomicamente aqui (lê + deleta) para evitar reuso.
                let intentHint = null;
                try {
                    const hintRaw = await redis?.get(`intent:hint:${leadId}`);
                    if (hintRaw) {
                        intentHint = JSON.parse(hintRaw);
                        await redis.del(`intent:hint:${leadId}`);
                        logger.info('intent_hint_consumed', { leadId, intent: intentHint.intent, confidence: intentHint.confidence, correlationId });
                    }
                } catch (hintErr) {
                    logger.warn('intent_hint_read_error', { leadId, err: hintErr.message });
                }

                // ── 5b. CONTEXTO ENRIQUECIDO PARA O ORQUESTRADOR ─────────────
                // 🧠 USA CONTEXTO DO CONTEXT BUILDER se disponível
                const builderContext = job.data.payload?.context || job.data.context;

                const enrichedContext = {
                    // 🎯 Prioriza contexto do Context Builder
                    intent:            builderContext?.intent?.primary,
                    intentConfidence:  builderContext?.intent?.confidence,
                    emotionalTone:     builderContext?.emotionalTone?.primary,
                    urgencyLevel:      builderContext?.emotionalTone?.urgencyLevel,
                    memorySummary:     builderContext?.memorySummary,
                    flags:             builderContext?.flags,
                    
                    // Fallback para dados do lead
                    preferredPeriod:   builderContext?.lead?.preferredPeriod || leadDoc.preferredPeriod,
                    preferredDate:     builderContext?.lead?.preferredDate || leadDoc.preferredDate,
                    therapy:           builderContext?.lead?.therapy || leadDoc.therapy,
                    stage:             builderContext?.lead?.stage || leadDoc.stage,
                    
                    source:            'whatsapp-auto-reply-worker',
                    isFirstContact:    builderContext?.flags?.isFirstContact ?? isFirstContact,
                    correlationId,
                    
                    // Metadados
                    _contextVersion:   builderContext?._meta?.contextVersion || 'legacy',
                    _contextBuiltAt:   builderContext?._meta?.builtAt,

                    // 🧠 Intent hint de follow-up (null se não houver)
                    intentHint,
                };

                // ── 6. ORQUESTRADOR COM LOCK ATÔMICO (Amanda FSM / legacy) ────
                // withLeadLock garante exclusão mútua por leadId no nível de orquestração
                const lockResult = await withLeadLock(leadDoc._id, async (lockedLead) => {
                    return runOrchestrator(lockedLead, content, enrichedContext);
                });

                if (!lockResult?.locked) {
                    logger.info('orchestrator_lock_skip', { leadId, correlationId });
                    return { status: 'skipped', reason: 'ORCHESTRATOR_LOCKED' };
                }

                const result = lockResult;

                if (result?.command !== 'SEND_MESSAGE' || !result.payload?.text) {
                    logger.info('no_reply_generated', { leadId, command: result?.command, correlationId });
                    return { status: 'no_reply', command: result?.command };
                }

                // ── 7. ENVIA RESPOSTA VIA EVENTO ─────────────────────────────
                // Publica para whatsapp-notification worker (WhatsappSendWorker)
                // Não chama sendTextMessage diretamente — mantém separação
                const aiText = formatWhatsAppResponse(result.payload.text.trim());

                const contactDoc = await Contacts.findOne({ phone: from }).lean();

                await publishEvent(EventTypes.WHATSAPP_MESSAGE_REQUESTED, {
                    to:             from,
                    text:           aiText,
                    leadId:         String(leadDoc._id),
                    contactId:      contactDoc?._id ? String(contactDoc._id) : null,
                    patientId:      leadDoc.convertedToPatient ? String(leadDoc.convertedToPatient) : null,
                    sentBy:         'amanda',
                    source:         'amanda-reply',
                    idempotencyKey: `amanda-reply:${String(leadDoc._id)}:${wamid}`, // wamid em vez de Date.now() → idempotente
                }, { correlationId });

                logger.info('reply_enqueued', {
                    leadId,
                    textLen: aiText.length,
                    correlationId,
                });

                return { status: 'replied', leadId, correlationId };

            } finally {
                // Libera lock Redis — sempre, mesmo em erro
                if (lockAcquired && lockKey) {
                    redis?.del(lockKey).catch(() => {});
                }
            }
        },
        {
            connection:  bullMqConnection,
            concurrency: 5, // paraleliza entre leads diferentes
            // jobId por leadId (definido no publisher) serializa dentro do mesmo lead
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 2000
                },
                removeOnComplete: 100,
                removeOnFail: 50
            }
        }
    );

    worker.on('completed', (job, result) => {
        logger.info('job_completed', { jobId: job.id, result });
    });

    worker.on('failed', async (job, err) => {
        logger.error('job_failed', { jobId: job?.id, err: err.message, attempts: job?.attemptsMade });
        
        // 🎯 DLQ: mover para fila de mortos após 3 tentativas
        if (job && job.attemptsMade >= 3) {
            await moveToDLQ(job, err, 'whatsapp-auto-reply-dlq');
            logger.error('moved_to_dlq', { jobId: job.id, queue: 'whatsapp-auto-reply-dlq' });
        }
    });

    logger.info('worker_started', { queue: 'whatsapp-auto-reply', concurrency: 5 });
    return worker;
}
