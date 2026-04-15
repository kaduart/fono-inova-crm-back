/**
 * Conversation State Worker
 * 
 * HARDENED LAYER:
 * Mantém estado consolidado da conversa por lead em Redis + fallback Mongo.
 * 
 * Resolve:
 * - perda de contexto em conversa longa
 * - mensagens soltas sem histórico
 * - IA sem memória estruturada de curto prazo
 * 
 * Complementa: leadStateWorker (validação) + contextBuilder (inteligência)
 */

import { Worker } from 'bullmq';
import { bullMqConnection, redisConnection as redis } from '../../../config/redisConnection.js';
import Lead from '../../../models/Leads.js';
import { createContextLogger } from '../../../utils/logger.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';

const logger = createContextLogger('conversationStateWorker');

const TTL = 60 * 60 * 24 * 7; // 7 dias de retenção
const MAX_MESSAGES = 10; // últimas 10 mensagens em hot state

/**
 * Recupera estado atual da conversa do Redis
 */
async function getConversationState(leadId) {
    try {
        const redisKey = `lead:state:${leadId}`;
        const existingRaw = await redis?.get(redisKey);
        return existingRaw ? JSON.parse(existingRaw) : null;
    } catch (err) {
        logger.warn('redis_get_failed', { leadId, err: err.message });
        return null;
    }
}

/**
 * Salva estado da conversa no Redis
 */
async function saveConversationState(leadId, state) {
    try {
        const redisKey = `lead:state:${leadId}`;
        await redis?.set(redisKey, JSON.stringify(state), 'EX', TTL);
        return true;
    } catch (err) {
        logger.warn('redis_save_failed', { leadId, err: err.message });
        return false;
    }
}

/**
 * Atualiza snapshot de fallback no Mongo (leve, fire-and-forget)
 */
async function updateMongoSnapshot(leadId, state) {
    try {
        await Lead.findByIdAndUpdate(leadId, {
            $set: {
                lastConversationSnapshot: {
                    lastMessage: state.context?.lastMessage,
                    lastUpdatedAt: state.lastUpdatedAt,
                    messageCount: state.context?.messageCount,
                    lastDirection: state.context?.lastDirection,
                },
            },
        });
    } catch (err) {
        // Silent fail - Redis é fonte de verdade, Mongo é fallback
        logger.debug('mongo_snapshot_failed', { leadId, err: err.message });
    }
}

export function createConversationStateWorker() {
    const worker = new Worker(
        'conversation-state',
        async (job) => {
            const { leadId, from, content, type, direction = 'inbound', timestamp,
                    wamid, messageId } = job.data.payload ?? job.data;
            const correlationId = job.data.metadata?.correlationId || `conv:${leadId}`;

            if (!leadId || !from) {
                logger.warn('missing_fields', { jobId: job.id });
                return { status: 'skipped', reason: 'MISSING_DATA' };
            }

            try {
                // 1. Recupera estado atual do Redis
                const existing = await getConversationState(leadId);
                const now = timestamp || new Date().toISOString();

                // 2. Monta mensagem
                const message = {
                    content: content?.substring(0, 500), // limita tamanho
                    type,
                    direction,
                    timestamp: now,
                };

                // 3. Atualiza estado
                const updatedState = {
                    leadId,
                    from,
                    lastUpdatedAt: now,

                    // Histórico leve (últimas N msgs) - FIFO
                    messages: [
                        ...(existing?.messages || []).slice(-(MAX_MESSAGES - 1)),
                        message,
                    ],

                    // Contexto enriquecido
                    context: {
                        lastMessage: content?.substring(0, 200),
                        lastType: type,
                        lastDirection: direction,
                        messageCount: (existing?.context?.messageCount || 0) + 1,
                        firstMessageAt: existing?.context?.firstMessageAt || now,
                    },

                    // Metadados
                    _meta: {
                        version: '1.0',
                        updatedBy: 'conversationStateWorker',
                    },
                };

                // 4. Salva no Redis (hot state - fonte de verdade)
                const saved = await saveConversationState(leadId, updatedState);
                
                if (!saved) {
                    logger.warn('state_not_saved_redis_unavailable', { leadId });
                }

                // 5. Atualiza fallback no Mongo (fire-and-forget)
                updateMongoSnapshot(leadId, updatedState).catch(() => {});

                // 6. Publica CONTEXT_BUILD_REQUESTED APÓS estado salvo no Redis
                // Garante que contextBuilderWorker sempre lê estado fresco (sem race condition)
                if (direction === 'inbound' && content) {
                    publishEvent(EventTypes.CONTEXT_BUILD_REQUESTED, {
                        leadId,
                        from,
                        content,
                        type,
                        wamid,
                        messageId,
                    }, {
                        correlationId,
                        jobId: `context:${leadId || wamid}`,
                    }).catch(() => {});
                }

                logger.info('state_updated', {
                    leadId,
                    messages: updatedState.context.messageCount,
                    direction,
                    correlationId,
                });

                return {
                    status: 'ok',
                    leadId,
                    messageCount: updatedState.context.messageCount,
                };

            } catch (err) {
                logger.error('state_error', { leadId, err: err.message, correlationId });
                // Não relança - este worker é best-effort, não crítico
                return {
                    status: 'error',
                    leadId,
                    error: err.message,
                };
            }
        },
        {
            connection: bullMqConnection,
            concurrency: 10,
            defaultJobOptions: {
                attempts: 2, // poucas tentativas - não é crítico
                backoff: { type: 'fixed', delay: 500 },
                removeOnComplete: 100,
                removeOnFail: 50,
            },
        }
    );

    worker.on('completed', (job, result) => {
        logger.debug('job_completed', { jobId: job.id, result });
    });

    worker.on('failed', (job, err) => {
        logger.error('job_failed', { jobId: job?.id, err: err.message });
    });

    logger.info('conversation_state_worker_started', { concurrency: 10 });
    return worker;
}

/**
 * API pública para outros workers consumirem o estado
 */
export async function getConversationContext(leadId) {
    return await getConversationState(leadId);
}

export default createConversationStateWorker;
