/**
 * Context Builder Worker
 * 
 * 🧠 WRAPPER EVENT-DRIVEN para messageContextBuilder.js existente
 * 
 * Responsabilidade: Receber evento → chamar buildMessageContext → publicar para auto-reply
 * 
 * NÃO duplica lógica - usa o service existente que já tem:
 * - Detecção de terapias (TDAH, TEA, etc)
 * - Flags de intenção e emoção
 * - Inteligência clínica completa
 * - Dados unificados do lead
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../../../config/redisConnection.js';
import { createContextLogger } from '../../../utils/logger.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { buildMessageContext } from '../../../services/messageContextBuilder.js';
import { getConversationContext } from './conversationStateWorker.js';
import Lead from '../../../models/Leads.js';

const logger = createContextLogger('contextBuilderWorker');

export function createContextBuilderWorker() {
    const worker = new Worker(
        'context-builder',
        async (job) => {
            const { leadId, from, content, type, wamid, messageId } = job.data.payload ?? job.data;
            const correlationId = job.data.metadata?.correlationId || `context:${wamid}`;

            if (!leadId || !content) {
                logger.warn('missing_fields', { jobId: job.id, leadId, hasContent: !!content });
                return { status: 'skipped', reason: 'MISSING_DATA' };
            }

            logger.info('building_context', { leadId, wamid, correlationId });

            try {
                // 1. Carrega lead fresh do banco
                const lead = await Lead.findById(leadId).lean();
                if (!lead) {
                    throw new Error('LEAD_NOT_FOUND');
                }

                // 2. Busca conversation state do Redis (se disponível)
                const conversationState = await getConversationContext(leadId);
                
                // 3. 🧠 USA O SERVICE EXISTENTE (messageContextBuilder.js)
                // Isso garante todas as detecções complexas (TDAH, TEA, terapias, etc)
                const messageContext = await buildMessageContext(
                    content,
                    lead,
                    lead.stage || 'novo',
                    conversationState || {}, // hot state do Redis (últimas msgs, intenção prévia)
                    null // insights - pode vir de amandaLearningService no futuro
                );

                // 4. Monta contexto enriquecido para Amanda
                const enrichedContext = {
                    // Dados básicos
                    leadId,
                    from,
                    wamid,
                    messageId,
                    
                    // 🎯 CONTEXTO INTELIGENTE DO SERVICE EXISTENTE
                    intent: {
                        primary: messageContext.flags?.wantsSchedule ? 'agendamento' :
                                 messageContext.flags?.refusesOrDenies ? 'recusa' :
                                 messageContext.globalIntent?.toLowerCase() || 'general',
                        flags: messageContext.flags,
                        manualIntent: messageContext.manualIntent,
                    },
                    
                    // Dados clínicos
                    clinical: {
                        primaryTherapy: messageContext.primaryTherapy,
                        therapies: messageContext.therapies,
                        isTDAH: messageContext.isTDAH,
                        teaStatus: messageContext.teaStatus,
                        medicalSpecialty: messageContext.medicalSpecialty,
                    },
                    
                    // Dados do lead unificados
                    leadData: messageContext.leadData,
                    
                    // Estratégia
                    strategy: {
                        canOfferScheduling: messageContext.canOfferScheduling,
                        promptMode: messageContext.promptMode,
                    },
                    
                    // Histórico da conversa (do Redis)
                    conversation: conversationState ? {
                        messages: conversationState.messages,
                        messageCount: conversationState.context?.messageCount,
                    } : null,
                    
                    // Metadados
                    _meta: {
                        contextVersion: '2.0',
                        builtAt: new Date().toISOString(),
                        source: 'messageContextBuilder.js',
                    },
                };

                logger.info('context_built', {
                    leadId,
                    intent: enrichedContext.intent.primary,
                    therapy: enrichedContext.clinical.primaryTherapy?.id || 'none',
                    canOfferScheduling: enrichedContext.strategy.canOfferScheduling,
                });

                // 5. 📤 PUBLICA PARA AUTO-REPLY COM CONTEXTO ENRIQUECIDO
                await publishEvent(
                    EventTypes.WHATSAPP_AUTO_REPLY_REQUESTED,
                    {
                        leadId,
                        from,
                        to: process.env.CLINIC_PHONE_E164 || '0000000000000',
                        content,
                        wamid,
                        messageId,
                        context: enrichedContext,
                    },
                    {
                        correlationId,
                        jobId: `auto-reply:${leadId}`,
                    }
                );

                return {
                    status: 'context_built',
                    leadId,
                    intent: enrichedContext.intent.primary,
                    therapy: enrichedContext.clinical.primaryTherapy?.id,
                };

            } catch (error) {
                logger.error('context_build_failed', {
                    leadId,
                    wamid,
                    error: error.message,
                });

                // 🛡️ FALLBACK: Publica evento mesmo sem contexto enriquecido
                await publishEvent(
                    EventTypes.WHATSAPP_AUTO_REPLY_REQUESTED,
                    {
                        leadId,
                        from,
                        to: process.env.CLINIC_PHONE_E164 || '0000000000000',
                        content,
                        wamid,
                        messageId,
                        context: null, // Amanda roda com contexto mínimo
                    },
                    {
                        correlationId,
                        jobId: `auto-reply:${leadId}`,
                    }
                ).catch(() => {});

                return {
                    status: 'fallback',
                    leadId,
                    error: error.message,
                };
            }
        },
        {
            connection: bullMqConnection,
            concurrency: 5,
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'fixed', delay: 1000 },
                removeOnComplete: 100,
                removeOnFail: 50,
            },
        }
    );

    worker.on('completed', (job, result) => {
        logger.info('job_completed', { jobId: job.id, result });
    });

    worker.on('failed', (job, err) => {
        logger.error('job_failed', { jobId: job?.id, err: err.message });
    });

    logger.info('worker_started', { queue: 'context-builder', concurrency: 5 });
    return worker;
}

export default createContextBuilderWorker;
