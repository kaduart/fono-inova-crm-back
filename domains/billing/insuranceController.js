// insurance/insuranceController.js
/**
 * Insurance Controller
 * 
 * API endpoints para gestão de faturamento de convênios.
 * Controller → Evento → Worker (padrão event-driven)
 */

import InsuranceBatch from '../../models/InsuranceBatch.js';
import { createBatch } from './domain/insuranceDomain.js';
import { publishEvent } from '../../infrastructure/events/eventPublisher.js';
import { InsuranceEventTypes } from './events/insuranceEvents.js';

/**
 * Cria um novo lote de faturamento
 * POST /api/insurance/batches
 */
export async function createBatchHandler(req, res) {
    try {
        const {
            insuranceProvider,
            insuranceProviderCode,
            startDate,
            endDate,
            items = []
        } = req.body;

        // Validações básicas
        if (!insuranceProvider || !startDate || !endDate) {
            return res.status(400).json({
                success: false,
                error: 'Dados incompletos',
                details: ['insuranceProvider, startDate e endDate são obrigatórios']
            });
        }

        if (items.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Lote vazio',
                details: ['Adicione pelo menos um item ao lote']
            });
        }

        // Cria o lote (domain logic)
        const batchData = await createBatch({
            insuranceProvider,
            insuranceProviderCode,
            startDate,
            endDate,
            items,
            createdBy: req.user?._id,
            metadata: {
                ip: req.ip,
                userAgent: req.headers['user-agent']
            }
        });

        // Persiste no banco
        const batch = new InsuranceBatch(batchData);
        await batch.save();

        // Publica evento (inicia fluxo event-driven)
        const eventResult = await publishEvent(
            InsuranceEventTypes.INSURANCE_BATCH_CREATED,
            {
                batchId: batch._id.toString(),
                batchNumber: batch.batchNumber,
                insuranceProvider: batch.insuranceProvider,
                totalItems: batch.totalItems,
                totalGross: batch.totalGross
            },
            {
                correlationId: req.correlationId,
                idempotencyKey: `create_batch_${batch._id}`
            }
        );

        res.status(201).json({
            success: true,
            message: 'Lote criado e enviado para processamento',
            data: {
                batchId: batch._id,
                batchNumber: batch.batchNumber,
                status: batch.status,
                totalItems: batch.totalItems,
                totalGross: batch.totalGross,
                eventId: eventResult.eventId
            }
        });

    } catch (error) {
        console.error('[InsuranceController] Erro ao criar lote:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno',
            message: error.message
        });
    }
}

/**
 * Lista lotes de faturamento
 * GET /api/insurance/batches
 */
export async function listBatchesHandler(req, res) {
    try {
        const {
            status,
            insuranceProvider,
            startDate,
            endDate,
            page = 1,
            limit = 20
        } = req.query;

        const query = {};
        if (status) query.status = status;
        if (insuranceProvider) query.insuranceProvider = insuranceProvider;
        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(startDate);
            if (endDate) query.createdAt.$lte = new Date(endDate);
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [batches, total] = await Promise.all([
            InsuranceBatch.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            InsuranceBatch.countDocuments(query)
        ]);

        res.json({
            success: true,
            data: batches,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('[InsuranceController] Erro ao listar lotes:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno',
            message: error.message
        });
    }
}

/**
 * Obtém detalhes de um lote
 * GET /api/insurance/batches/:id
 */
export async function getBatchHandler(req, res) {
    try {
        const { id } = req.params;

        const batch = await InsuranceBatch.findById(id).lean();

        if (!batch) {
            return res.status(404).json({
                success: false,
                error: 'Lote não encontrado'
            });
        }

        // Calcula métricas adicionais
        const metrics = {
            approvalRate: batch.approvalRate,
            glosaRate: batch.glosaRate,
            pendingAmount: batch.items
                .filter(i => ['pending', 'sent'].includes(i.status))
                .reduce((sum, i) => sum + (i.grossAmount || 0), 0)
        };

        res.json({
            success: true,
            data: {
                ...batch,
                metrics
            }
        });

    } catch (error) {
        console.error('[InsuranceController] Erro ao buscar lote:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno',
            message: error.message
        });
    }
}

/**
 * Fecha e envia lote para operadora
 * POST /api/insurance/batches/:id/seal
 */
export async function sealBatchHandler(req, res) {
    try {
        const { id } = req.params;

        const batch = await InsuranceBatch.findById(id);

        if (!batch) {
            return res.status(404).json({
                success: false,
                error: 'Lote não encontrado'
            });
        }

        if (batch.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: 'Lote não pode ser fechado',
                details: [`Status atual: ${batch.status}. Apenas lotes 'pending' podem ser fechados.`]
            });
        }

        // Publica evento de fechamento
        const eventResult = await publishEvent(
            InsuranceEventTypes.INSURANCE_BATCH_SEALED,
            {
                batchId: batch._id.toString(),
                batchNumber: batch.batchNumber,
                sealedBy: req.user?._id,
                sealedAt: new Date()
            },
            {
                correlationId: req.correlationId,
                idempotencyKey: `seal_batch_${batch._id}`
            }
        );

        res.json({
            success: true,
            message: 'Lote fechado e enviado para processamento',
            data: {
                batchId: batch._id,
                batchNumber: batch.batchNumber,
                status: 'processing',
                eventId: eventResult.eventId
            }
        });

    } catch (error) {
        console.error('[InsuranceController] Erro ao fechar lote:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno',
            message: error.message
        });
    }
}

/**
 * Solicita reprocessamento de lote/item
 * POST /api/insurance/batches/:id/reprocess
 */
export async function reprocessBatchHandler(req, res) {
    try {
        const { id } = req.params;
        const { itemIds, reason, corrections } = req.body;

        const batch = await InsuranceBatch.findById(id);

        if (!batch) {
            return res.status(404).json({
                success: false,
                error: 'Lote não encontrado'
            });
        }

        // Publica evento de reprocessamento
        const eventResult = await publishEvent(
            InsuranceEventTypes.INSURANCE_BATCH_REPROCESS_REQUESTED,
            {
                batchId: batch._id.toString(),
                itemIds,
                reason,
                corrections,
                requestedBy: req.user?._id
            },
            {
                correlationId: req.correlationId,
                idempotencyKey: `reprocess_batch_${batch._id}_${Date.now()}`
            }
        );

        res.json({
            success: true,
            message: 'Reprocessamento solicitado',
            data: {
                batchId: batch._id,
                eventId: eventResult.eventId
            }
        });

    } catch (error) {
        console.error('[InsuranceController] Erro ao solicitar reprocessamento:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno',
            message: error.message
        });
    }
}

/**
 * Simula retorno da operadora (para testes)
 * POST /api/insurance/batches/:id/simulate-response
 */
export async function simulateResponseHandler(req, res) {
    try {
        const { id } = req.params;

        const batch = await InsuranceBatch.findById(id);

        if (!batch) {
            return res.status(404).json({
                success: false,
                error: 'Lote não encontrado'
            });
        }

        // Importa função de simulação
        const { simulateProviderResponse } = await import('./integrations/tiss/tissGenerator.js');

        // Simula resposta
        const simulatedResponse = await simulateProviderResponse(
            batch._id.toString(),
            batch.items
        );

        // Publica eventos de resultado para cada item
        for (const result of simulatedResponse.results) {
            const eventType = result.status === 'approved'
                ? InsuranceEventTypes.INSURANCE_ITEM_APPROVED
                : InsuranceEventTypes.INSURANCE_ITEM_REJECTED;

            await publishEvent(
                eventType,
                {
                    batchId: batch._id.toString(),
                    itemId: result.itemId,
                    ...result
                },
                { correlationId: req.correlationId }
            );
        }

        res.json({
            success: true,
            message: 'Resposta simulada processada',
            data: simulatedResponse
        });

    } catch (error) {
        console.error('[InsuranceController] Erro na simulação:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno',
            message: error.message
        });
    }
}

/**
 * Obtém estatísticas de faturamento
 * GET /api/insurance/stats
 */
export async function getStatsHandler(req, res) {
    try {
        const { startDate, endDate, insuranceProvider } = req.query;

        const match = {};
        if (startDate || endDate) {
            match.createdAt = {};
            if (startDate) match.createdAt.$gte = new Date(startDate);
            if (endDate) match.createdAt.$lte = new Date(endDate);
        }
        if (insuranceProvider) {
            match.insuranceProvider = insuranceProvider;
        }

        const stats = await InsuranceBatch.aggregate([
            { $match: match },
            {
                $group: {
                    _id: null,
                    totalBatches: { $sum: 1 },
                    totalItems: { $sum: '$totalItems' },
                    totalGross: { $sum: '$totalGross' },
                    totalNet: { $sum: '$totalNet' },
                    totalGlosa: { $sum: '$totalGlosa' },
                    totalReceived: { $sum: '$receivedAmount' },
                    approvedBatches: {
                        $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
                    },
                    failedBatches: {
                        $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
                    }
                }
            }
        ]);

        const statusBreakdown = await InsuranceBatch.aggregate([
            { $match: match },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 },
                    totalGross: { $sum: '$totalGross' }
                }
            }
        ]);

        res.json({
            success: true,
            data: {
                summary: stats[0] || {
                    totalBatches: 0,
                    totalItems: 0,
                    totalGross: 0,
                    totalNet: 0,
                    totalGlosa: 0,
                    totalReceived: 0
                },
                statusBreakdown: statusBreakdown.reduce((acc, curr) => {
                    acc[curr._id] = { count: curr.count, totalGross: curr.totalGross };
                    return acc;
                }, {}),
                period: { startDate, endDate },
                filters: { insuranceProvider }
            }
        });

    } catch (error) {
        console.error('[InsuranceController] Erro ao buscar estatísticas:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno',
            message: error.message
        });
    }
}
