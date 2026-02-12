// =====================================================================
// RESPONSE TRACKING SERVICE - ENTERPRISE GRADE
// =====================================================================
// Responsável por rastrear respostas de leads a follow-ups
// e tomar ações automatizadas baseadas em comportamento
//
// Autor: Sistema Amanda 2.0
// Versão: 2.0.0
// =====================================================================

import chalk from 'chalk';
import { getIo } from '../config/socket.js';
import Followup from '../models/Followup.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
import { analyzeLeadMessage } from './intelligence/leadIntelligence.js';

// =====================================================================
// CONFIGURAÇÕES CENTRALIZADAS
// =====================================================================

const CONFIG = {
    RESPONSE_WINDOW_HOURS: 72, // Janela para considerar resposta válida
    BATCH_SIZE: 50, // Leads processados por lote
    NON_RESPONDER_THRESHOLD_HOURS: 48, // Tempo para considerar lead frio
    MIN_FOLLOWUPS_FOR_COLD: 2, // Mínimo de follow-ups para marcar como frio
    SCORE_PENALTY_COLD: 30, // Penalidade de score para leads frios

    // Timeouts e retries
    DB_OPERATION_TIMEOUT: 10000, // 10s
    MAX_RETRIES: 3,
    RETRY_DELAY: 1000 // 1s
};

// =====================================================================
// TIPOS E INTERFACES (para documentação)
// =====================================================================

/**
 * @typedef {Object} ResponseResult
 * @property {boolean} responded - Se o lead respondeu
 * @property {number} [responseTime] - Tempo de resposta em minutos
 * @property {Object} [analysis] - Análise da resposta
 * @property {string} [message] - Conteúdo da mensagem
 */

/**
 * @typedef {Object} ProcessingResult
 * @property {number} processed - Quantidade processada
 * @property {number} responded - Quantidade que respondeu
 * @property {number} errors - Quantidade com erro
 * @property {Array<string>} errorDetails - Detalhes dos erros
 */

// =====================================================================
// UTILS INTERNOS
// =====================================================================

/**
 * Logger estruturado
 */
const logger = {
    info: (msg, data = {}) => {
        console.log(chalk.blue(`[INFO] ${msg}`), data);
    },
    success: (msg, data = {}) => {
        console.log(chalk.green(`[SUCCESS] ${msg}`), data);
    },
    warn: (msg, data = {}) => {
        console.warn(chalk.yellow(`[WARN] ${msg}`), data);
    },
    error: (msg, error, data = {}) => {
        console.error(chalk.red(`[ERROR] ${msg}`), { error: error.message, ...data });
    }
};


export async function handleInboundMessageForFollowups(leadId) {
    if (!leadId) return;

    // Pega o último followup enviado pra esse lead
    const lastSent = await Followup.findOne({
        lead: leadId,
        status: 'sent',
        responded: false,
    })
        .sort({ sentAt: -1 })
        .lean();

    if (!lastSent) return;

    // Reaproveita TODA a inteligência já feita em checkFollowupResponse
    await checkFollowupResponse(lastSent._id);
}

/**
 * Retry wrapper para operações de banco
 */
async function withRetry(operation, context = '', maxRetries = CONFIG.MAX_RETRIES) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            logger.warn(`Tentativa ${attempt}/${maxRetries} falhou: ${context}`, {
                error: error.message
            });

            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY * attempt));
            }
        }
    }

    throw new Error(`Operação falhou após ${maxRetries} tentativas: ${context}. Erro: ${lastError.message}`);
}

/**
 * Calcula tempo de resposta em minutos
 */
function calculateResponseTime(sentAt, respondedAt) {
    const diff = new Date(respondedAt) - new Date(sentAt);
    return Math.round(diff / 60000); // ms -> minutos
}

/**
 * Verifica se timestamp está dentro da janela válida
 */
function isWithinResponseWindow(sentAt, receivedAt, windowHours = CONFIG.RESPONSE_WINDOW_HOURS) {
    const diff = new Date(receivedAt) - new Date(sentAt);
    const diffHours = diff / (1000 * 60 * 60);
    return diffHours <= windowHours && diffHours >= 0;
}

// =====================================================================
// CORE: VERIFICAÇÃO DE RESPOSTA
// =====================================================================

/**
 * Verifica se um follow-up específico foi respondido
 * 
 * @param {string} followupId - ID do follow-up
 * @param {Object} options - Opções adicionais
 * @returns {Promise<ResponseResult|null>}
 */
export async function checkFollowupResponse(followupId, options = {}) {
    const startTime = Date.now();

    try {
        // Validação de entrada
        if (!followupId) {
            throw new Error('followupId é obrigatório');
        }

        // 1. BUSCAR FOLLOW-UP COM POPULATE
        const followup = await withRetry(
            async () => {
                const doc = await Followup.findById(followupId)
                    .populate('lead')
                    .lean()
                    .maxTimeMS(CONFIG.DB_OPERATION_TIMEOUT);

                if (!doc) {
                    throw new Error(`Follow-up ${followupId} não encontrado`);
                }

                return doc;
            },
            `buscar follow-up ${followupId}`
        );

        // 2. VALIDAÇÕES DE ESTADO
        if (followup.status !== 'sent') {
            logger.warn('Follow-up não está em estado "sent"', {
                followupId,
                status: followup.status
            });
            return null;
        }

        if (followup.responded) {
            logger.info('Follow-up já marcado como respondido', { followupId });
            return { responded: true };
        }

        const lead = followup.lead;
        if (!lead) {
            logger.error('Lead não encontrado', new Error('Missing lead'), { followupId });
            return null;
        }

        // 3. BUSCAR RESPOSTAS APÓS ENVIO DO FOLLOW-UP
        const responses = await withRetry(
            async () => Message.find({
                lead: lead._id,
                direction: 'inbound',
                timestamp: { $gt: followup.sentAt }
            })
                .sort({ timestamp: 1 })
                .lean()
                .maxTimeMS(CONFIG.DB_OPERATION_TIMEOUT),
            `buscar respostas do lead ${lead._id}`
        );

        // 4. PROCESSAR SE HOUVER RESPOSTA
        if (responses.length === 0) {
            return { responded: false };
        }

        const firstResponse = responses[0];

        // Verificar se resposta está dentro da janela válida
        if (!isWithinResponseWindow(followup.sentAt, firstResponse.timestamp)) {
            logger.warn('Resposta fora da janela de tempo válida', {
                followupId,
                sentAt: followup.sentAt,
                respondedAt: firstResponse.timestamp
            });
            return { responded: false };
        }

        const responseTime = calculateResponseTime(followup.sentAt, firstResponse.timestamp);

        // 5. MARCAR FOLLOW-UP COMO RESPONDIDO
        await withRetry(
            async () => {
                const followupDoc = await Followup.findById(followupId);
                if (followupDoc && !followupDoc.responded) {
                    await followupDoc.markRespondedAt(firstResponse.timestamp);
                }
            },
            `marcar follow-up ${followupId} como respondido`
        );

        logger.success('Follow-up marcado como respondido', {
            followupId,
            leadName: lead.name,
            responseTime: `${responseTime}min`
        });

        // 6. ANÁLISE INTELIGENTE DA RESPOSTA
        let analysis = null;
        try {
            analysis = await analyzeLeadMessage({
                text: firstResponse.content,
                lead: {
                    _id: lead._id,
                    name: lead.name,
                    origin: lead.origin,
                    lastInteractionAt: lead.lastInteractionAt
                },
                history: responses.slice(0, 5).map(m => m.content)
            });

            logger.info('Análise de resposta concluída', {
                leadId: lead._id,
                score: analysis.score,
                intent: analysis.intent.primary,
                sentiment: analysis.intent.sentiment
            });
        } catch (analysisError) {
            logger.error('Erro na análise de resposta', analysisError, {
                followupId,
                leadId: lead._id
            });
            // Não propaga erro - análise é opcional
        }

        // 7. ATUALIZAR LEAD COM NOVA INTELIGÊNCIA
        if (analysis) {
            await withRetry(
                async () => Lead.findByIdAndUpdate(
                    lead._id, {
                    $set: {
                        conversionScore: analysis.score,
                        status: analysis.score >= 80 ? 'lead_quente' : analysis.score < 50 ? 'lead_frio' : lead.status,
                        'qualificationData.extractedInfo': analysis.extracted,
                        'qualificationData.intent': analysis.intent.primary,
                        'qualificationData.sentiment': analysis.intent.sentiment,
                        lastScoreUpdate: new Date()
                    },
                    $push: {
                        scoreHistory: {
                            score: analysis.score,
                            reason: `Resposta a follow-up: ${analysis.intent.primary}`,
                            date: new Date()
                        }
                    }
                }, { new: false }
                ),
                `atualizar lead ${lead._id} após resposta`
            );
        }

        // 8. CANCELAR FOLLOW-UPS FUTUROS (lead está engajado)
        const cancelResult = await withRetry(
            async () => Followup.updateMany({
                lead: lead._id,
                status: 'scheduled',
                scheduledAt: { $gt: new Date() }
            }, {
                $set: {
                    status: 'cancelled',
                    error: 'Lead respondeu - sequência cancelada',
                    updatedAt: new Date()
                }
            }),
            `cancelar follow-ups futuros do lead ${lead._id}`
        );

        if (cancelResult.modifiedCount > 0) {
            logger.success('Follow-ups futuros cancelados', {
                leadId: lead._id,
                cancelledCount: cancelResult.modifiedCount
            });
        }

        // 9. EMITIR EVENTO EM TEMPO REAL
        try {
            const io = getIo();
            io.emit('followup:responded', {
                followupId,
                leadId: lead._id,
                leadName: lead.name,
                responseTime,
                score: analysis?.score,
                segment: analysis?.segment?.label,
                timestamp: new Date()
            });
        } catch (socketError) {
            logger.warn('Erro ao emitir evento Socket.IO', { error: socketError.message });
            // Não propaga erro - socket é opcional
        }

        // 10. MÉTRICAS
        const duration = Date.now() - startTime;
        logger.info('Processamento concluído', {
            followupId,
            duration: `${duration}ms`
        });

        return {
            responded: true,
            responseTime,
            analysis,
            message: firstResponse.content
        };

    } catch (error) {
        logger.error('Erro ao verificar resposta', error, { followupId });
        return null;
    }
}

// =====================================================================
// BATCH: PROCESSAMENTO EM LOTE
// =====================================================================

/**
 * Processa lote de follow-ups enviados sem resposta
 * 
 * @param {Object} options - Opções de processamento
 * @returns {Promise<ProcessingResult>}
 */
export async function processPendingResponses(options = {}) {
    const {
        batchSize = CONFIG.BATCH_SIZE,
        minAge = 24 // horas
    } = options;

    const startTime = Date.now();
    const stats = {
        processed: 0,
        responded: 0,
        errors: 0,
        errorDetails: []
    };

    try {
        logger.info('Iniciando processamento de respostas pendentes', {
            batchSize,
            minAge: `${minAge}h`
        });

        // 1. BUSCAR FOLLOW-UPS PENDENTES
        const cutoffDate = new Date(Date.now() - minAge * 60 * 60 * 1000);

        const pending = await withRetry(
            async () => Followup.find({
                status: 'sent',
                responded: false,
                sentAt: { $lte: cutoffDate }
            })
                .sort({ sentAt: 1 }) // Mais antigos primeiro
                .limit(batchSize)
                .lean()
                .maxTimeMS(CONFIG.DB_OPERATION_TIMEOUT),
            'buscar follow-ups pendentes'
        );

        if (pending.length === 0) {
            logger.info('Nenhum follow-up pendente encontrado');
            return stats;
        }

        logger.info(`Processando ${pending.length} follow-ups...`);

        // 2. PROCESSAR EM PARALELO (com controle de concorrência)
        const CONCURRENT_LIMIT = 5;
        const chunks = [];

        for (let i = 0; i < pending.length; i += CONCURRENT_LIMIT) {
            chunks.push(pending.slice(i, i + CONCURRENT_LIMIT));
        }

        for (const chunk of chunks) {
            const promises = chunk.map(async (followup) => {
                try {
                    const result = await checkFollowupResponse(followup._id);

                    stats.processed++;

                    if (result?.responded) {
                        stats.responded++;

                        logger.success('Lead respondeu', {
                            followupId: followup._id,
                            responseTime: result.responseTime
                        });
                    }

                } catch (error) {
                    stats.errors++;
                    stats.errorDetails.push({
                        followupId: followup._id,
                        error: error.message
                    });

                    logger.error('Erro ao processar follow-up', error, {
                        followupId: followup._id
                    });
                }
            });

            await Promise.allSettled(promises);
        }

        // 3. MÉTRICAS FINAIS
        const duration = Date.now() - startTime;
        const responseRate = stats.processed > 0 ?
            ((stats.responded / stats.processed) * 100).toFixed(1) :
            0;

        logger.success('Processamento em lote concluído', {
            ...stats,
            responseRate: `${responseRate}%`,
            duration: `${duration}ms`
        });

        return stats;

    } catch (error) {
        logger.error('Erro crítico no processamento em lote', error);
        return { ...stats, error: error.message };
    }
}

// =====================================================================
// IDENTIFICAÇÃO DE LEADS FRIOS
// =====================================================================

/**
 * Identifica leads que não responderam após múltiplas tentativas
 * 
 * @param {Object} options - Opções de identificação
 * @returns {Promise<Array>}
 */
export async function identifyNonResponders(options = {}) {
    const {
        minAge = CONFIG.NON_RESPONDER_THRESHOLD_HOURS,
        minFollowups = CONFIG.MIN_FOLLOWUPS_FOR_COLD,
        scorePenalty = CONFIG.SCORE_PENALTY_COLD
    } = options;

    const startTime = Date.now();

    try {
        logger.info('Identificando leads frios', {
            minAge: `${minAge}h`,
            minFollowups
        });

        const cutoffDate = new Date(Date.now() - minAge * 60 * 60 * 1000);

        // 1. AGREGAÇÃO PARA ENCONTRAR NÃO RESPONDENTES
        const nonResponders = await withRetry(
            async () => Followup.aggregate([{
                $match: {
                    status: 'sent',
                    responded: false,
                    sentAt: { $lte: cutoffDate }
                }
            },
            {
                $group: {
                    _id: '$lead',
                    totalFollowups: { $sum: 1 },
                    lastFollowupSent: { $max: '$sentAt' },
                    firstFollowupSent: { $min: '$sentAt' },
                    followupIds: { $push: '$_id' }
                }
            },
            {
                $match: {
                    totalFollowups: { $gte: minFollowups }
                }
            },
            {
                $sort: { totalFollowups: -1 }
            }
            ], { maxTimeMS: CONFIG.DB_OPERATION_TIMEOUT }),
            'agregar leads frios'
        );

        logger.info(`${nonResponders.length} leads frios identificados`);

        if (nonResponders.length === 0) {
            return [];
        }

        // 2. ATUALIZAR LEADS EM LOTE
        const bulkOps = [];

        for (const item of nonResponders) {
            // Buscar lead atual para calcular novo score
            const lead = await Lead.findById(item._id).lean();

            if (lead) {
                const newScore = Math.max(0, (lead.conversionScore || 50) - scorePenalty);

                bulkOps.push({
                    updateOne: {
                        filter: { _id: item._id },
                        update: {
                            $set: {
                                status: 'lead_frio',
                                conversionScore: newScore,
                                'qualificationData.needsHumanReview': true,
                                'qualificationData.reviewReason': `${item.totalFollowups} follow-ups sem resposta há ${minAge}h+`
                            },
                            $push: {
                                scoreHistory: {
                                    score: newScore,
                                    reason: `Lead frio: ${item.totalFollowups} tentativas sem resposta`,
                                    date: new Date()
                                }
                            }
                        }
                    }
                });
            }
        }

        if (bulkOps.length > 0) {
            const result = await withRetry(
                async () => Lead.bulkWrite(bulkOps),
                'atualizar leads frios em lote'
            );

            logger.success('Leads marcados como frios', {
                updated: result.modifiedCount,
                total: nonResponders.length
            });
        }

        // 3. EMITIR EVENTO
        try {
            const io = getIo();
            io.emit('leads:cold-identified', {
                count: nonResponders.length,
                timestamp: new Date()
            });
        } catch (socketError) {
            logger.warn('Erro ao emitir evento', { error: socketError.message });
        }

        // 4. MÉTRICAS
        const duration = Date.now() - startTime;
        logger.info('Identificação concluída', {
            duration: `${duration}ms`
        });

        return nonResponders.map(item => ({
            leadId: item._id,
            totalFollowups: item.totalFollowups,
            lastFollowupSent: item.lastFollowupSent,
            daysSinceFirst: Math.round(
                (Date.now() - new Date(item.firstFollowupSent).getTime()) / (1000 * 60 * 60 * 24)
            )
        }));

    } catch (error) {
        logger.error('Erro ao identificar não respondentes', error);
        return [];
    }
}

// =====================================================================
// ANALYTICS: MÉTRICAS E INSIGHTS
// =====================================================================

/**
 * Gera analytics de resposta para período específico
 * 
 * @param {number} days - Dias para análise
 * @returns {Promise<Object>}
 */
export async function getResponseAnalytics(days = 7) {
    const startTime = Date.now();

    try {
        logger.info('Gerando analytics de resposta', { days });

        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // 1. MÉTRICAS GERAIS
        const overall = await withRetry(
            async () => Followup.aggregate([{
                $match: {
                    sentAt: { $gte: since },
                    status: 'sent'
                }
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    responded: {
                        $sum: { $cond: [{ $eq: ['$responded', true] }, 1, 0] }
                    },
                    avgResponseTime: {
                        $avg: {
                            $cond: [
                                { $gt: ['$responseTimeMinutes', 0] },
                                '$responseTimeMinutes',
                                null
                            ]
                        }
                    }
                }
            },
            {
                $project: {
                    _id: 0,
                    total: 1,
                    responded: 1,
                    notResponded: { $subtract: ['$total', '$responded'] },
                    responseRate: {
                        $round: [
                            { $multiply: [{ $divide: ['$responded', '$total'] }, 100] },
                            1
                        ]
                    },
                    avgResponseTime: { $round: ['$avgResponseTime', 0] }
                }
            }
            ], { maxTimeMS: CONFIG.DB_OPERATION_TIMEOUT }),
            'calcular métricas gerais'
        );

        // 2. POR ORIGEM
        const byOrigin = await withRetry(
            async () => Followup.aggregate([{
                $match: {
                    sentAt: { $gte: since },
                    status: 'sent'
                }
            },
            {
                $group: {
                    _id: '$origin',
                    total: { $sum: 1 },
                    responded: {
                        $sum: { $cond: [{ $eq: ['$responded', true] }, 1, 0] }
                    }
                }
            },
            {
                $project: {
                    origin: '$_id',
                    total: 1,
                    responded: 1,
                    responseRate: {
                        $round: [
                            { $multiply: [{ $divide: ['$responded', '$total'] }, 100] },
                            1
                        ]
                    }
                }
            },
            { $sort: { responseRate: -1 } }
            ], { maxTimeMS: CONFIG.DB_OPERATION_TIMEOUT }),
            'calcular métricas por origem'
        );

        // 3. POR HORÁRIO
        const byHour = await withRetry(
            async () => Followup.aggregate([{
                $match: {
                    sentAt: { $gte: since },
                    status: 'sent'
                }
            },
            {
                $project: {
                    hour: { $hour: { date: '$sentAt', timezone: 'America/Sao_Paulo' } },
                    responded: '$responded'
                }
            },
            {
                $group: {
                    _id: '$hour',
                    total: { $sum: 1 },
                    responded: {
                        $sum: { $cond: [{ $eq: ['$responded', true] }, 1, 0] }
                    }
                }
            },
            {
                $project: {
                    hour: '$_id',
                    total: 1,
                    responseRate: {
                        $round: [
                            { $multiply: [{ $divide: ['$responded', '$total'] }, 100] },
                            1
                        ]
                    }
                }
            },
            { $sort: { responseRate: -1 } }
            ], { maxTimeMS: CONFIG.DB_OPERATION_TIMEOUT }),
            'calcular métricas por horário'
        );

        const bestHour = byHour[0];

        // 4. MÉTRICAS FINAIS
        const duration = Date.now() - startTime;

        const analytics = {
            overall: overall[0] || {
                total: 0,
                responded: 0,
                notResponded: 0,
                responseRate: 0,
                avgResponseTime: 0
            },
            byOrigin,
            insights: {
                bestHour: bestHour ? `${bestHour.hour}h` : 'N/A',
                bestOrigin: byOrigin[0]?.origin || 'N/A',
                recommendations: generateRecommendations(overall[0], byOrigin, byHour)
            },
            metadata: {
                period: `últimos ${days} dias`,
                generatedAt: new Date(),
                duration: `${duration}ms`
            }
        };

        logger.success('Analytics gerado', {
            responseRate: `${analytics.overall.responseRate}%`,
            duration: `${duration}ms`
        });

        return analytics;

    } catch (error) {
        logger.error('Erro ao gerar analytics', error);
        return null;
    }
}

/**
 * Gera recomendações baseadas nos dados
 */
function generateRecommendations(overall, byOrigin, byHour) {
    const recommendations = [];

    if (!overall) return recommendations;

    // Taxa de resposta
    if (overall.responseRate < 30) {
        recommendations.push('⚠️ Taxa de resposta baixa - revisar mensagens e timing');
    } else if (overall.responseRate > 60) {
        recommendations.push('✅ Taxa de resposta excelente - manter estratégia');
    }

    // Melhor origem
    if (byOrigin.length > 0) {
        const best = byOrigin[0];
        if (best.responseRate > 50) {
            recommendations.push(`🎯 Foco em ${best.origin} - taxa de ${best.responseRate}%`);
        }
    }

    // Melhor horário
    if (byHour.length > 0) {
        const best = byHour[0];
        if (best.responseRate > 50) {
            recommendations.push(`⏰ Enviar preferencialmente às ${best.hour}h`);
        }
    }

    // Tempo de resposta
    if (overall.avgResponseTime) {
        if (overall.avgResponseTime < 60) {
            recommendations.push('⚡ Leads respondem rápido - priorizar atendimento imediato');
        } else if (overall.avgResponseTime > 240) {
            recommendations.push('🐌 Respostas demoradas - considerar follow-up mais frequente');
        }
    }

    return recommendations;
}

// =====================================================================
// HEALTH CHECK
// =====================================================================

/**
 * Verifica saúde do sistema de tracking
 */
export async function healthCheck() {
    const checks = {
        database: false,
        socket: false,
        recentActivity: false
    };

    try {
        // 🔹 DB Check
        const count = await Followup.countDocuments(); // maxTimeMS not supported on countDocuments in this context
        checks.database = true;

        // 🔹 Socket Check
        try {
            const io = getIo();
            checks.socket = !!io;
        } catch {
            checks.socket = false;
        }

        // 🔹 Activity Check (follow-ups nas últimas 24h) – só pra métrica/log
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentCount = await Followup.countDocuments({
            createdAt: { $gte: oneDayAgo }
        }).maxTimeMS(5000);
        checks.recentActivity = recentCount > 0;

        // ✅ Saúde depende só de DB + socket
        const healthy = checks.database && checks.socket;

        return {
            healthy,
            checks,
            timestamp: new Date()
        };

    } catch (error) {
        logger.error('Health check falhou', error);
        return {
            healthy: false,
            checks,
            error: error.message,
            timestamp: new Date()
        };
    }
}

// =====================================================================
// EXPORTS
// =====================================================================

export default {
    // Core
    checkFollowupResponse,
    processPendingResponses,
    identifyNonResponders,

    // Analytics
    getResponseAnalytics,

    // Utils
    healthCheck,
    CONFIG
};